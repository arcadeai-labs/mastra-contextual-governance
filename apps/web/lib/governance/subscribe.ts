/**
 * The panel's end of the governance stream.
 *
 * Holds one `text/event-stream` connection open, validates every frame against
 * `GovernanceEvent`, and hands the valid ones over. Reconnects on its own with
 * a bounded backoff, resuming from the last id it saw.
 *
 * The wire contract, which `apps/hooks` implements on #20:
 *
 *     GET  {stream url}
 *     Accept: text/event-stream
 *     Last-Event-ID: <the last audit row id this client saw>   (on a resume)
 *
 *     event: governance
 *     id: evt_4k7xq2m9hz
 *     data: {"id":"evt_4k7xq2m9hz","ts":…,"hook":"pre","decision":"deny",…}
 *
 * This module is the only place that knows any of that. #20 owns the endpoint
 * and has not landed; if it settles on a different path, event name or frame
 * layout, changing it is changing this file and nothing else.
 *
 * **Nothing here throws at the caller.** A refused connection, a torn stream, a
 * frame that is not JSON, a frame that is JSON but not a `GovernanceEvent` —
 * each is reported through `onStatus` and the subscription carries on. The
 * panel's job on stage is to keep showing what it has; going blank because one
 * frame was malformed would be the worst possible failure mode for it.
 */
import { GovernanceEvent } from "@cg/policy-schema";

import { createSseDecoder } from "./sse.ts";

/** The event name the hook server puts on a governance frame. */
export const GOVERNANCE_EVENT_NAME = "governance";

/** What the panel tells the audience about its own connection. */
export type StreamStatus =
  /** Trying to open the stream for the first time. */
  | "connecting"
  /** Connected. Events are flowing. */
  | "live"
  /** The stream dropped and a reconnect is pending. Events already shown stay. */
  | "reconnecting";

export interface SubscribeOptions {
  /** Called with every batch of valid events, in the order they arrived. */
  readonly onEvents: (events: GovernanceEvent[]) => void;
  /** Called whenever the connection state changes. */
  readonly onStatus?: (status: StreamStatus) => void;
  /**
   * Called for a frame that arrived but could not be used — bad JSON, or JSON
   * that is not a `GovernanceEvent`. The stream continues either way. Exists so
   * a contract mismatch with #20 is loud in the console rather than a panel
   * that mysteriously shows nothing.
   */
  readonly onUnusableFrame?: (data: string, problem: string) => void;
  /** Aborts the subscription and any pending reconnect. */
  readonly signal: AbortSignal;
  /**
   * Optional replay anchor for the first successful connection only.
   *
   * The control-plane panel uses `"0"` because the home page's server render
   * makes its governed loan reads before the hydrated panel can open the
   * browser stream. Generic subscribers omit this and start live, as before.
   * Once connected, reconnects always resume from the last event id received.
   */
  readonly initialLastEventId?: string | null;
  /** First reconnect delay, doubling to {@link MAX_RETRY_MS}. */
  readonly retryMs?: number;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Subscribes to `url` until `signal` aborts. Resolves when it does.
 *
 * Events are delivered in batches — everything one read of the socket yielded —
 * because that is what makes a burst cost one render instead of a thousand.
 */
export async function subscribeToGovernanceEvents(
  url: string,
  options: SubscribeOptions,
): Promise<void> {
  const {
    onEvents,
    onStatus = () => {},
    onUnusableFrame = () => {},
    signal,
    initialLastEventId = null,
    retryMs = DEFAULT_RETRY_MS,
    fetchImpl = fetch,
  } = options;

  let lastEventId: string | null = null;
  let firstConnection = true;
  let backoff = retryMs;
  let everConnected = false;

  while (!signal.aborted) {
    onStatus(everConnected ? "reconnecting" : "connecting");

    try {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        // The stream is a live view of a mutable log; a cache between here and
        // the hook server replaying yesterday's acts would be hard to diagnose.
        "cache-control": "no-cache",
      };
      if (firstConnection && initialLastEventId !== null) {
        headers["last-event-id"] = initialLastEventId;
      } else if (lastEventId !== null) {
        headers["last-event-id"] = lastEventId;
      }

      const response = await fetchImpl(url, { headers, signal });
      if (!response.ok || response.body === null) {
        throw new Error(`stream responded ${response.status}`);
      }

      firstConnection = false;
      everConnected = true;
      backoff = retryMs;
      onStatus("live");

      const decoder = createSseDecoder();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          const batch: GovernanceEvent[] = [];
          for (const frame of decoder.push(value)) {
            // An id is tracked even for a frame we cannot use, so a resume does
            // not ask the server to replay something already refused.
            if (frame.id !== null) lastEventId = frame.id;
            if (frame.retry !== null) backoff = Math.min(frame.retry, MAX_RETRY_MS);
            if (frame.event !== GOVERNANCE_EVENT_NAME) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              onUnusableFrame(frame.data, "not JSON");
              continue;
            }

            const result = GovernanceEvent.safeParse(parsed);
            if (!result.success) {
              onUnusableFrame(frame.data, result.error.issues[0]?.message ?? "schema mismatch");
              continue;
            }
            batch.push(result.data);
          }

          if (batch.length > 0) onEvents(batch);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // Every failure lands here and none of them propagate: the loop's job is
      // to keep trying until the caller says stop.
    }

    if (signal.aborted) break;
    onStatus("reconnecting");
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, MAX_RETRY_MS);
  }
}

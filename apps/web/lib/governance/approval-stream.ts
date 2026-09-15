/**
 * The chat's end of the governance stream: `event: approval`, and nothing else
 * on the socket.
 *
 * The panel watches the same URL for `event: governance` (`subscribe.ts`). This
 * is a second subscription for a second consumer, rather than a fan-out of the
 * first, for one reason: the two halves of the split screen are two component
 * trees with two lifetimes, and threading one subscription between them would
 * make the chat's ability to resume depend on the panel being mounted. On
 * `/chat` it is not.
 *
 * ## What it does not do
 *
 * **It sends no `Last-Event-ID` and tracks no position.** An approval notice
 * carries no `id:` — it is not an audit row and has no place in the replay —
 * so there is nothing to resume from and asking for one would replay the whole
 * governance log at a consumer that discards every frame of it.
 *
 * **Which means a notice can be missed**, and this is the one thing about it
 * worth stating out loud: a browser whose socket is down at the moment Charlie
 * presses Approve never sees that frame. The issue names the conditions —
 * conference wifi — so the gap is closed rather than documented: every
 * reconnect fires `onReconnect`, and the caller answers it by asking the
 * server what the store now says about the request it is waiting on
 * (`/api/approvals/{id}/status`). Ordinary operation is the stream; the read
 * is what makes a dropped socket a delay rather than a turn that never resumes.
 *
 * **Nothing here throws at the caller**, for the same reason `subscribe.ts`
 * does not: a torn stream, a refused connection or a frame that is not an
 * `ApprovalNotice` is reported and the loop carries on. A chat that stopped
 * listening because one frame was malformed would be a turn stuck for ever
 * with nothing on screen saying why.
 */
import { ApprovalNotice } from "@cg/policy-schema";

import { createSseDecoder } from "./sse.ts";

/** The event name `apps/hooks` puts on an approval decision. */
export const APPROVAL_EVENT_NAME = "approval";

export interface ApprovalSubscribeOptions {
  /** Every valid notice, in arrival order. */
  readonly onNotice: (notice: ApprovalNotice) => void;
  /**
   * The stream just came back up after a drop, or came up for the first time.
   *
   * The caller uses it to catch up on anything decided while the socket was
   * down. Fired on every successful connect, including the first, because
   * "this browser has been connected the whole time" is not something a page
   * that just mounted can claim either.
   */
  readonly onConnected?: () => void;
  /** A frame that arrived and could not be used. The stream continues. */
  readonly onUnusableFrame?: (data: string, problem: string) => void;
  readonly signal: AbortSignal;
  /** First reconnect delay, doubling to {@link MAX_RETRY_MS}. */
  readonly retryMs?: number;
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

/** Subscribes to `url` until `signal` aborts. Resolves when it does. */
export async function subscribeToApprovalNotices(
  url: string,
  options: ApprovalSubscribeOptions,
): Promise<void> {
  const {
    onNotice,
    onConnected = () => {},
    onUnusableFrame = () => {},
    signal,
    retryMs = DEFAULT_RETRY_MS,
    fetchImpl = fetch,
  } = options;

  let backoff = retryMs;

  while (!signal.aborted) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "text/event-stream", "cache-control": "no-cache" },
        signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`stream responded ${response.status}`);
      }

      backoff = retryMs;
      onConnected();

      const decoder = createSseDecoder();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of decoder.push(value)) {
            // Every governance frame on this socket lands here and is dropped,
            // by name. The panel does the mirror image.
            if (frame.event !== APPROVAL_EVENT_NAME) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              onUnusableFrame(frame.data, "not JSON");
              continue;
            }
            const result = ApprovalNotice.safeParse(parsed);
            if (!result.success) {
              onUnusableFrame(frame.data, result.error.issues[0]?.message ?? "schema mismatch");
              continue;
            }
            onNotice(result.data);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // Every failure lands here and none propagate: the loop's job is to keep
      // trying until the caller says stop.
    }

    if (signal.aborted) break;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, MAX_RETRY_MS);
  }
}

/**
 * Whether `notice` is the one this browser is waiting on.
 *
 * Both halves are required and neither is enough alone. The request id says it
 * is the approval this browser's agent asked for; the requester says the turn
 * is this persona's to resume. Without the second, an open tab signed in as
 * Michael would resume Alice's turn — and the resumed turn's tool calls would be
 * made as Michael, because every call is made as whoever this browser is signed
 * in as.
 *
 * The server checks both again, against the store record rather than against
 * the frame (`lib/agent/resume.ts`). This is the same question asked where it
 * is cheap; that one is the answer.
 */
export function noticeIsFor(
  notice: ApprovalNotice,
  waiting: { request_id: string; signedInAs: string | null },
): boolean {
  if (waiting.signedInAs === null) return false;
  return (
    notice.request_id === waiting.request_id &&
    notice.requester_id.trim().toLowerCase() === waiting.signedInAs.trim().toLowerCase()
  );
}

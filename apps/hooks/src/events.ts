/**
 * `GET /events` — the live governance stream the control-plane panel renders.
 *
 * The wire contract is #21's, decided on #20 and implemented here rather than
 * negotiated: `text/event-stream`, one frame per decision, `event: governance`,
 * `data:` the `GovernanceEvent` exactly as `audit_log` holds it, and `id:` the
 * audit row's id so a reconnect can name where it got to. `apps/web`'s
 * `lib/governance/subscribe.ts` is the only client and it was built to this
 * shape; nothing here is free to drift from it.
 *
 *     GET /events
 *     Last-Event-ID: evt_4k7xq2m9hz        (optional, on a resume)
 *     Last-Event-ID: 0                     (or a seq — 0 replays the whole log)
 *
 *     retry: 500
 *
 *     : governance stream — live from seq 41
 *
 *     event: governance
 *     id: evt_4k7xq2m9hz
 *     data: {"id":"evt_4k7xq2m9hz","ts":"…","hook":"pre","decision":"deny",…}
 *
 * ## The stream lags the log; it never leads it
 *
 * Events arrive through the bus, which `record` publishes to *after* the audit
 * transaction commits. So the stream can be behind the log — a slow client, a
 * dropped socket — and the resume mechanism exists precisely to recover from
 * that. What cannot happen is the other direction: a frame the panel renders
 * for which no audit row exists. That asymmetry is the reason the seam is where
 * it is, and `audit-log.ts` says the same thing from the other side.
 *
 * ## Resume is exact, and the handoff has no seam of its own
 *
 * On connect the stream subscribes to the bus **and then** reads the log's
 * high-water mark, with no `await` between the two statements. Publishing is
 * synchronous inside another request's `record`, so nothing can commit between
 * them: every row at or below the mark belongs to the replay, every row above
 * it is already queued, and the two sets are disjoint. That is what makes
 * "reconnect receives exactly the missed rows, in order, nothing duplicated" a
 * property of the construction rather than of the timing.
 *
 * ## Replaying from the beginning, and an anchor this log cannot place
 *
 * `Last-Event-ID: 0` means "from the first row", as the docs always claimed it
 * did. It used to fall through the unknown-id path and serve live from the
 * current cutoff, which looked like a working replay that returned nothing
 * (#62). A `last-event-id` of all digits is now read as a `seq` — the unit the
 * preamble and the truncation comment already speak in — and no audit row id
 * can be one, because every id is `evt_` plus ten base32 characters.
 *
 * An anchor this log cannot place — an unknown id, or a seq past the
 * high-water mark — still resumes live, and still says so in the first bytes
 * on the wire rather than quietly. The comment now names the mark it is
 * resuming from and how to ask for everything, so the second attempt can be
 * exact.
 *
 * ## Backpressure, and why a slow client is disconnected rather than trimmed
 *
 * `pull` only runs when the socket will take more bytes, so a client that
 * stops reading stops the writer, and events accumulate in `pending`. Past
 * {@link STREAM_BACKLOG_LIMIT} the connection is closed. The client reconnects
 * on its own with the last id it actually saw and the replay makes it whole —
 * whereas dropping events from the middle of a live stream would leave the
 * panel quietly missing decisions with nothing to indicate it. The two limits
 * are one number for exactly that reason: a backlog large enough to disconnect
 * is small enough to replay in full.
 *
 * ## Unauthenticated, deliberately, and with one thing to watch
 *
 * There is no bearer on `/events`. The panel fetches it **from the browser**
 * (`ControlPlanePanel` is a client component and the URL is the hook host, not
 * `apps/web`), so any token that could authenticate it would have to be shipped
 * to the browser, where it is not a secret — the alternative is a proxy route
 * in `apps/web`, which is a change to a client this slice was told not to
 * change. Today every field of a `GovernanceEvent` is safe to project: ids,
 * timestamps, persona emails, tool names, decisions, reasons, `rule_id`.
 *
 * A `/post` redaction event is safe by construction rather than by the
 * renderer's good manners: it carries `redactions[]` (path, `rule_id`,
 * `pattern_id`, kind) and no payload — no `before`, no `after`, nothing a rule
 * removed. That was #16's choice, made because this endpoint has no bearer and
 * `audit_log` is durable; see `GovernanceEvent`'s docstring for why `after`
 * was ruled out along with `before`.
 */
import type { Database } from "bun:sqlite";

import type { EventBus, PublishedEvent } from "@cg/governance-core";

import { cappedAnchor, maxSeq, pageAfter, seqOf } from "./audit-log.ts";

export const EVENTS_PATH = "/events";

/** The event name #21's adapter filters on. Anything else it ignores. */
export const GOVERNANCE_EVENT_NAME = "governance";

/**
 * The cap on both a replay and a live backlog, in events.
 *
 * Sized to the largest batch the control plane can produce in one decision: a
 * whole-project `/access` writes one row per tool, measured at 10,844 (`bun run
 * --cwd apps/hooks bench`). A limit under that would make a single legitimate
 * call truncate a resume, so this is that number with room to spare.
 */
export const STREAM_BACKLOG_LIMIT = 25_000;

/**
 * Events per chunk written to the socket.
 *
 * The client batches by socket read, so this is also its render batch size.
 * Small enough that backpressure is felt while a replay is still running,
 * large enough that ten thousand events are not ten thousand syscalls.
 */
export const STREAM_CHUNK_EVENTS = 500;

/** A comment on an idle stream, so a proxy between here and the panel keeps it. */
export const KEEP_ALIVE_MS = 15_000;

/** Reconnect advice for a spec-compliant client. #21's keeps its own backoff. */
const RETRY_MS = 500;

/**
 * Read-only and unauthenticated, so `*` gives away nothing the endpoint does
 * not already. The preflight is not optional: the panel sends `cache-control`
 * on its first connect and `last-event-id` on every resume, neither of which
 * is a CORS-safelisted request header, so the browser asks first. Without this
 * the panel fails to connect in a browser while every server-side test passes,
 * which is the least debuggable way for this endpoint to be wrong.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, cache-control, last-event-id",
  "access-control-max-age": "600",
};

const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Render's proxy would otherwise buffer the whole response and deliver the
  // acts in one go, at the end — which on stage is indistinguishable from the
  // control plane not firing.
  "x-accel-buffering": "no",
  ...CORS_HEADERS,
};

export interface EventStreamDeps {
  readonly db: Database;
  readonly bus: EventBus;
  readonly log: (line: string) => void;
  /** Overridden in tests so an idle keep-alive is observable in milliseconds. */
  readonly keepAliveMs?: number;
  /**
   * Overridden in tests. The cap is a behaviour — disconnect rather than trim,
   * truncate rather than replay forever — and a test that had to write 25,000
   * rows to reach it would be a test nobody runs.
   */
  readonly backlogLimit?: number;
}

/** The CORS preflight the panel's browser sends before it ever connects. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * One `GovernanceEvent` as a frame.
 *
 * `JSON.stringify` escapes every CR and LF inside the payload, so a `data:`
 * line is always one line and a reason containing a newline cannot forge a
 * frame boundary.
 */
function frame(published: PublishedEvent): string {
  const { event } = published;
  return (
    `event: ${GOVERNANCE_EVENT_NAME}\n` + `id: ${event.id}\n` + `data: ${JSON.stringify(event)}\n\n`
  );
}

/** An SSE comment. Ignored by the client's decoder, visible in `curl`. */
function comment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * A `last-event-id` of all digits names a `seq` rather than a row id, and `0`
 * therefore means "from the beginning".
 *
 * The two spaces cannot collide: every audit row id is `evt_` and ten base32
 * characters (`audit-log.ts`), so nothing the panel ever sends is a number.
 * Seqs are already a public part of this endpoint's vocabulary — the preamble
 * and the truncation comment both quote them — so the documented
 * `last-event-id: 0` is a case of a rule rather than a magic value.
 */
const SEQ_ANCHOR = /^\d+$/;

/**
 * The `seq` to replay after, or `null` when the request named something this
 * log cannot place.
 *
 * A seq above the high-water mark is unplaceable for the same reason an unknown
 * id is: the client is describing a log this is not. Saying so beats replaying
 * from a mark the caller did not ask for, which is what the old handling of
 * `0` did — it looked like a working replay that returned nothing (#62).
 */
function resolveAnchor(db: Database, lastEventId: string, cutoff: number): number | null {
  if (!SEQ_ANCHOR.test(lastEventId)) return seqOf(db, lastEventId);
  const seq = Number(lastEventId);
  return Number.isSafeInteger(seq) && seq <= cutoff ? seq : null;
}

/** How the log line names an anchor, so `0` reads as what it is. */
function describeAnchor(lastEventId: string, seq: number): string {
  if (!SEQ_ANCHOR.test(lastEventId)) return `${lastEventId} (seq ${seq})`;
  return seq === 0 ? "seq 0 (the beginning of the log)" : `seq ${seq}`;
}

/**
 * Opens a stream. Replays first if the request names a `Last-Event-ID` the log
 * can place, then stays open on the bus until the client goes away.
 */
export function handleEvents(request: Request, deps: EventStreamDeps): Response {
  const { db, bus, log } = deps;
  const keepAliveMs = deps.keepAliveMs ?? KEEP_ALIVE_MS;
  const backlogLimit = deps.backlogLimit ?? STREAM_BACKLOG_LIMIT;
  const lastEventId = request.headers.get("last-event-id")?.trim() ?? "";

  const encoder = new TextEncoder();
  const pending: PublishedEvent[] = [];

  let closed = false;
  let overflowed = false;
  let lastSentSeq = 0;
  /** The half-open replay window `(replayFrom, replayTo]`, set on connect. */
  let replayFrom = 0;
  let replayTo = 0;
  let unsubscribe: () => void = () => {};
  /** Resolves the idle wait in `pull`. Non-null only while `pull` is waiting. */
  let wake: (() => void) | null = null;
  /**
   * True while `pull` is parked with nothing to send.
   *
   * It is what makes the backlog limit mean "how far behind the writer you may
   * fall" rather than "the largest batch you may receive". A whole-project
   * `/access` arrives as ~10,844 events in one call; an idle writer is about to
   * take all of them, so counting them against the cap would disconnect a
   * perfectly healthy panel for the crime of watching a big decision.
   */
  let writerIdle = false;

  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Subscribe *before* reading the high-water mark, with nothing between
      // them: see the handoff note at the top of this file.
      unsubscribe = bus.subscribe((batch) => {
        if (closed) return;
        if (!writerIdle && pending.length + batch.length > backlogLimit) {
          // Do not trim. Close, and let the client's own resume make it whole.
          overflowed = true;
        } else {
          // A loop, not a spread: a batch is as large as the biggest decision
          // the control plane can make, and that is not an argument list.
          for (const published of batch) pending.push(published);
        }
        notify();
      });
      const cutoff = maxSeq(db);

      request.signal.addEventListener("abort", () => {
        closed = true;
        notify();
      });

      // Where the replay starts. `cutoff` means "nothing to replay".
      let anchor = cutoff;
      let preamble = `retry: ${RETRY_MS}\n\n`;

      if (lastEventId !== "") {
        const found = resolveAnchor(db, lastEventId, cutoff);
        if (found === null) {
          // A panel left open across `scripts/reset`, a stale tab, or a seq
          // past the end of this log. Replaying everything for a client that
          // asked for something else would be worse than saying so and going
          // live — and the mark is named so the next attempt can be exact.
          preamble += comment(
            `last-event-id ${lastEventId} is not in this log; resuming live from seq ${cutoff}. ` +
              `Send last-event-id: 0 to replay from the beginning.`,
          );
          log(`/events resumed from an unknown id ${lastEventId}; serving live from seq ${cutoff}`);
        } else {
          const capped = cappedAnchor(db, found, cutoff, backlogLimit);
          anchor = capped ?? found;
          if (capped !== null) {
            const dropped = capped - found;
            preamble += comment(
              `replay truncated at ${backlogLimit} events; ` +
                `rows between ${lastEventId} and seq ${capped} were not resent`,
            );
            log(
              `/events resumed from ${lastEventId} (seq ${found}) with a gap past the ` +
                `${backlogLimit}-event cap; replaying from seq ${capped}, ~${dropped} skipped`,
            );
          } else {
            log(
              `/events resumed from ${describeAnchor(lastEventId, found)}; ` +
                `replaying up to seq ${cutoff}`,
            );
          }
        }
      } else {
        // The mark this connection starts from, on the wire as well as in the
        // log: it is what a `curl` reader needs to pick an anchor, and it is
        // what the docblock above and the README have always claimed is here.
        preamble += comment(`governance stream — live from seq ${cutoff}`);
        log(`/events opened live from seq ${cutoff}`);
      }

      lastSentSeq = anchor;
      replayFrom = anchor;
      replayTo = cutoff;
      // Bytes immediately, so the panel reports itself live on connect rather
      // than after the first decision — which on stage may be a minute away.
      controller.enqueue(encoder.encode(preamble));
    },

    async pull(controller) {
      while (!closed) {
        if (overflowed) {
          log(
            `/events disconnecting a client ${pending.length} events behind ` +
              `(cap ${backlogLimit}); it will resume from its last id`,
          );
          closed = true;
          controller.close();
          return;
        }

        // Replay first, in pages, oldest first.
        if (replayFrom < replayTo) {
          const page = pageAfter(db, replayFrom, replayTo, STREAM_CHUNK_EVENTS);
          if (page.length === 0) {
            // The window emptied under us — a reset between two pages.
            replayFrom = replayTo;
            continue;
          }
          replayFrom = page[page.length - 1]?.seq ?? replayTo;
          write(controller, page);
          return;
        }

        // Then live, in the batches the bus delivered.
        if (pending.length > 0) {
          const batch = pending.splice(0, STREAM_CHUNK_EVENTS);
          if (write(controller, batch)) return;
          continue;
        }

        // Idle. Wake on the next decision, or send a keep-alive.
        writerIdle = true;
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve(false);
          }, keepAliveMs);
          wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        writerIdle = false;
        if (!woken && !closed) {
          controller.enqueue(encoder.encode(comment("keep-alive")));
          return;
        }
      }

      // The client went away. `cancel` has usually already run; closing twice
      // is what the try/catch is for.
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    },

    cancel() {
      closed = true;
      unsubscribe();
      notify();
    },
  });

  /**
   * Writes `batch`, dropping anything at or below what has already gone out.
   *
   * The skip makes "`seq` strictly increases down the socket" true by
   * construction, rather than true because of an argument about when the bus
   * publishes relative to the replay window. Returns whether anything was
   * written, so `pull` knows if it still owes the consumer a chunk.
   */
  function write(controller: ReadableStreamDefaultController<Uint8Array>, batch: readonly PublishedEvent[]): boolean {
    let text = "";
    let sent = 0;
    for (const published of batch) {
      if (published.seq <= lastSentSeq) continue;
      text += frame(published);
      lastSentSeq = published.seq;
      sent += 1;
    }
    if (sent === 0) return false;
    controller.enqueue(encoder.encode(text));
    return true;
  }

  return new Response(stream, { headers: STREAM_HEADERS });
}

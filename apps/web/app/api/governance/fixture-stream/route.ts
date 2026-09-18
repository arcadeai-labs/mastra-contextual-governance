/**
 * The panel's no-backend stream.
 *
 * Replays #5's `aGovernanceEventSequence()` as real `text/event-stream` frames,
 * in the same shape `apps/hooks` will send on #20. It exists so the control
 * plane panel can be opened, demoed and reviewed with nothing else running —
 * `bun run dev:web` and the acts play — and so the wire format has a second
 * implementation, which is the cheapest way to notice the client and the server
 * disagreeing about it.
 *
 * It is a fixture, and says so: the panel labels this mode rather than letting
 * a rehearsal mistake a replay for the live control plane.
 */
import { aGovernanceEventSequence } from "@cg/policy-schema";

import { anAccessFanout } from "../../../../lib/governance/access-fanout.ts";
import { anAccessListing } from "../../../../lib/governance/access-listing.ts";
import { GOVERNANCE_EVENT_NAME } from "../../../../lib/governance/subscribe.ts";

export const dynamic = "force-dynamic";

/** Paced so each act lands separately, the way it would from a real tool call. */
const DEFAULT_DELAY_MS = 900;
/** Keeps the connection open once the story has played out. */
const KEEP_ALIVE_MS = 15_000;

/** Cap on `repeat`, so a mistyped URL cannot ask for a million events. */
const MAX_REPEAT = 4000;

/** Plain timers, not `Bun.sleep`: this runs under whichever runtime Next uses. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A whole number in `[1, max]` from a query parameter, or `fallback`.
 *
 * `Number(null)` is 0, not `NaN`, so an absent parameter has to be checked for
 * rather than coerced — a bug this route shipped with for one commit, where the
 * default pacing silently became "all at once" and the acts landed on top of
 * each other.
 */
function positiveParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const delayMs = positiveParam(params, "delayMs", DEFAULT_DELAY_MS, { min: 0, max: 60_000 });
  /**
   * How many times to replay the sequence. `?repeat=2000&delayMs=0` is ten
   * thousand events as fast as the socket takes them — the shape of a
   * whole-project `/access`, which decides 10,844 tools in one call. It is here
   * so "handles a burst without dropping or reordering" is something a
   * presenter can watch happen rather than something a test asserts alone.
   */
  const repeat = Math.floor(positiveParam(params, "repeat", 1, { min: 1, max: MAX_REPEAT }));
  /**
   * `?fanout=1` appends both measured `/access` shapes, so the access lane's
   * two kinds of card can be watched rather than described:
   *
   * - the fan-out measured on #13 — three access decisions for one
   *   `Loan.GetLoan` call, two for one `Loan.ApproveLoan` — which is a
   *   `tools/call` shape and draws as runs of repeats; then
   * - one persona's whole `tools/list` (#156), ten seconds later so it is
   *   unmistakably a second burst, which draws as one listing card naming the
   *   tool it hid.
   *
   * Off by default: the four acts are the story, and a stream that silently
   * grew twelve events would break the one thing every other fixture test
   * counts.
   */
  const events =
    params.get("fanout") === "1"
      ? [...aGovernanceEventSequence(), ...anAccessFanout(), ...anAccessListing()]
      : aGovernanceEventSequence();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };

      request.signal.addEventListener("abort", () => {
        open = false;
      });

      // A comment first, so the client reports itself live straight away rather
      // than after the first event a second later.
      send(": governance fixture stream\n\n");

      for (let pass = 0; open && pass < repeat; pass += 1) {
        for (const event of events) {
          if (!open) break;
          if (delayMs > 0) await sleep(delayMs);
          if (!open) break;
          // Each pass needs its own ids, or the timeline de-duplicates the
          // repeat away and the burst never reaches the panel at all.
          const replayed = pass === 0 ? event : { ...event, id: `${event.id}_${pass}` };
          send(
            `event: ${GOVERNANCE_EVENT_NAME}\n` +
              `id: ${replayed.id}\n` +
              `data: ${JSON.stringify(replayed)}\n\n`,
          );
        }
      }

      // Hold the connection rather than closing it. A close would send the
      // client into its reconnect loop and replay the whole story on a timer,
      // which looks like the control plane deciding the same call over and over.
      while (open) {
        await sleep(KEEP_ALIVE_MS);
        send(": keep-alive\n\n");
      }

      try {
        controller.close();
      } catch {
        // Already closed by the client going away.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Render sits behind a proxy that will otherwise buffer the whole
      // response and deliver the acts all at once, at the end.
      "x-accel-buffering": "no",
    },
  });
}

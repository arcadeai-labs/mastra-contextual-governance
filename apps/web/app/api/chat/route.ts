/**
 * One-line adapter onto `lib/agent/entry.ts`, the way every `app/api/**` route
 * in this service is. The reasoning is in `lib/identity/cookies.ts`: the
 * handler is a plain function so the suite can mount it behind a real server
 * and drive it over real HTTP.
 *
 * Onto `entry.ts` rather than straight onto `handlers.ts` because the handler's
 * module graph is the thing that failed in #92 — `entry.ts` loads it inside a
 * `try` so a missing runtime dependency answers JSON naming the step instead of
 * Next's stock 500 page.
 */
import { chatEntry } from "../../../lib/agent/entry.ts";

/** Reads a session cookie and streams; there is nothing here to prerender. */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return chatEntry(request);
}

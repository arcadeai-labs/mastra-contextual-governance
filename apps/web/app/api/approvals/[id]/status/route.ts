/**
 * One-line adapter onto `lib/agent/approval-status.ts`, the way every
 * `app/api/**` route in this service is: the handler is a plain
 * `(Request) => Promise<Response>` so the suite mounts it behind a real server
 * and drives it over real HTTP with a cookie jar.
 *
 * The id comes out of the URL in the handler rather than from Next's `params`,
 * for the same reason — a handler that needed a framework's route context
 * could not be mounted anywhere else.
 */
import { approvalStatus } from "../../../../../lib/agent/approval-status.ts";

/** Reads a session cookie and a live store; there is nothing here to prerender. */
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return approvalStatus(request);
}

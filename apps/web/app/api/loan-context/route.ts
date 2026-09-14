/**
 * The Next adapter. Everything is in `lib/loan-context/handlers.ts`, which is a
 * plain function so the suite can mount it behind a real server — see the note
 * at the top of `app/api/chat/route.ts` for the same argument.
 */
import { loanContext } from "../../../lib/loan-context/handlers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return loanContext(request);
}

/**
 * Everything `/` asks the gateway for, in one gateway session.
 *
 * The page has two questions for the same MCP connection: *what may this
 * persona see* (#15's tool list, act 1) and *what do the two applications under
 * review say* (#22's loan files). Both are answered off one `tools/list` — the
 * tool list is the listing itself, and the loan reads run against the governed
 * tools that listing produced, before the connection is dropped.
 *
 * ## Why this file exists at all
 *
 * It is #109. Loading `/` used to cost **two** `tools/list` calls: one here,
 * server-side, and one from the browser, which fetched `GET /api/loan-context`
 * to find `Loan_GetLoan` before reading the two files. They could not share a
 * session, because the second was a separate HTTP request that opened its own
 * `MCPClient`. Against the real gateway each listing is also four `/access`
 * calls, so the tidy-up is worth about five audit rows and a round trip per
 * page load. `test/home-surface.test.ts` asserts the count rather than
 * describing it.
 *
 * ## What it does not do
 *
 * Reseal the session. `sessionSurface` may spend a refreshed gateway token, and
 * a server component cannot set a cookie — the route that *can* reseal is
 * `POST /api/chat`, and `lib/agent/tool-list.ts` states the bargain. The route
 * this replaced did reseal; losing that costs one extra refresh on the next
 * page load and buys the page back a whole round trip.
 */
import { sessionSurface, type SessionTools, type SessionToolsOptions } from "../agent/tool-list.ts";
import type { Session } from "../identity/session.ts";
import type { LoanFilesState } from "../loan-context/loans.ts";
import { readLoanFiles, type ReadLoanFilesOptions } from "../loan-context/read.ts";

export interface HomeSurface {
  /** #15's widget, as data. */
  tools: SessionTools;
  /** #22's left column, as data. */
  files: LoanFilesState;
}

export type HomeSurfaceOptions = SessionToolsOptions & ReadLoanFilesOptions;

export async function homeSurface(
  session: Session | null,
  options: HomeSurfaceOptions = {},
): Promise<HomeSurface> {
  const { tools, inside } = await sessionSurface(
    session,
    (listing) => readLoanFiles(listing, session?.email ?? "", options),
    options,
  );
  if (inside !== null) return { tools, files: inside };

  // No listing, so no read — and the two halves of the screen say so with the
  // same sentence, because it is the same gateway session that did not answer.
  // The one exception is nobody being signed in: "there is no persona to list
  // tools for" is true and is also not what a column of loan files should say,
  // and the reader's next move is the same either way.
  return {
    tools,
    files: {
      status: "refused",
      refusal:
        session === null
          ? {
              error: "Nobody is signed in on this browser, so there is no one to read the file as.",
              action: "signin",
            }
          : { error: tools.reason, ...(tools.action ? { action: tools.action } : {}) },
    },
  };
}

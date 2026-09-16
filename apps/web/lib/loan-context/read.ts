/**
 * The two loan files the left half puts on screen, read the same way the agent
 * reads them.
 *
 * A pure function of one gateway listing: it is handed the governed tools that
 * a `tools/list` already produced (`lib/agent/tool-list.ts`) and runs two
 * `Loan_GetLoan` calls on that same MCP session. Until #109 this was a route —
 * `GET /api/loan-context`, fetched from the browser — and being a route was
 * what made it cost a second `tools/list`: a separate HTTP request cannot share
 * a connection with the server render that preceded it. The route is gone and
 * nothing fetches it; `lib/home/surface.ts` is the one caller.
 *
 * ## Why this is not a database read
 *
 * The obvious implementation of "show the loan the agent is about to act on" is
 * to open `loans.db`, or to call `apps/loan-app` with a service credential. Both
 * would work, both would be faster, and both would make the screen a liar.
 *
 * The claim this demo makes is that **every** read of the bank's system of
 * record passes the control plane, keyed on who is asking. A left half that
 * reached past the hooks would be a second, ungoverned path into the same data
 * sitting inches from a panel asserting there is only one — and with `/post`
 * redaction live (#16), the chat would show a masked account number beside a
 * file that never had one masked. So these reads go through an MCP client of
 * the gateway with the signed-in persona's bearer, exactly like
 * `lib/agent/tools.ts`, and they appear in the audit log like any other.
 *
 * The cost is honest and worth stating: opening the page makes two real
 * governed tool calls, and two `Loan.GetLoan` rows appear on the panel before
 * the presenter has said anything. That is what reading a loan file costs here.
 *
 * ## Who the read is made as
 *
 * This browser's sealed session, and nothing else. No branch in this file reads
 * an identity from the query string, the body or a header — `DESIGN.md` rule 1,
 * the same rule the chat route and the verifier hold to. `actor` is unsealed by
 * the server component that owns the cookie and passed in.
 */
import { authorizationRequired, isHookDecision, remediationText } from "../agent/authorization.ts";
import { correlationRef, failureText } from "../agent/run.ts";
import type { GovernedListing } from "../agent/tool-list.ts";
import {
  DEMO_LOAN_IDS,
  loanFromToolResult,
  type LoanFilesState,
  type LoanRead,
} from "./loans.ts";

/**
 * The suffix that identifies the read tool on the wire.
 *
 * `DESIGN.md` → Tool surface: MCP advertises `Loan_GetLoan`, and the toolkit
 * half is configurable (`ARCADE_LOAN_TOOLKIT`) while the tool half is not — it
 * is what `arcade-mcp` PascalCases `get_loan` into. Matching the suffix inside
 * the agent's own allow-list is what keeps this read and the agent pointed at
 * the same tool without a second copy of the toolkit name to keep in step.
 *
 * It is matched against the **governed** selection rather than everything the
 * gateway advertises, so a built-in that happened to end the same way could
 * never be selected here.
 */
const GET_LOAN_SUFFIX = "_GetLoan";

export interface ReadLoanFilesOptions {
  /** Only for tests, which need to see which tool was picked out of the surface. */
  onTool?: (name: string) => void;
}

/**
 * Both files, or the one sentence saying why there are none.
 *
 * Total: nothing here throws, because the caller is a server component
 * rendering a page that has a tool list, a chat and a control-plane panel on it
 * too. A gateway that cannot be read from loses the left column, not the page.
 */
export async function readLoanFiles(
  listing: GovernedListing,
  actor: string,
  options: ReadLoanFilesOptions = {},
): Promise<LoanFilesState> {
  const names = Object.keys(listing.tools).filter((name) => name.endsWith(GET_LOAN_SUFFIX));
  // Loud, not quiet. Nothing matched means a wrong `ARCADE_LOAN_TOOLKIT` or a
  // toolkit that did not deploy, and the symptom — an empty column where the
  // loan files should be — looks exactly like a control plane that denied
  // them. Two matches means two toolkits claim the same tool, and picking one
  // would be a guess about which loan book the audience is looking at.
  //
  // The words are #22's, unchanged by #109's move off the route: the sentence
  // is the only thing on screen that names the variable a human has to go and
  // fix, and it names the number the gateway actually answered with.
  if (names.length !== 1) {
    return {
      status: "refused",
      refusal: {
        error:
          names.length === 0
            ? `The gateway advertised ${listing.advertised.length} tools and none of the governed ones ` +
              `is a ${GET_LOAN_SUFFIX.slice(1)}, so there is no way to read a loan file. Check ` +
              `ARCADE_LOAN_TOOLKIT against a real tools/list.`
            : `${names.length} governed tools end in ${GET_LOAN_SUFFIX}, so which loan book this is ` +
              `would be a guess: ${names.join(", ")}.`,
        detail: listing.advertised,
      },
    };
  }

  const toolName = names[0] as string;
  options.onTool?.(toolName);
  const tool = listing.tools[toolName] as { execute: (input: unknown) => Promise<unknown> };

  // Sequential, not parallel. Two calls on one MCP session in flight at once
  // is a transport question this slice has no measurement for, and the whole
  // page load is two reads.
  const reads: LoanRead[] = [];
  for (const loanId of DEMO_LOAN_IDS) {
    reads.push(await readOne(tool, loanId));
  }

  return { status: "loaded", body: { reads, actor, tool: toolName } };
}

/**
 * One governed read, classified the way the chat classifies a failed tool call.
 *
 * The classification is `lib/agent/authorization.ts`'s, imported rather than
 * repeated: a denial needs **positive evidence** that a hook decided (Arcade's
 * prefix, `CHECK_FAILED`, `CONTEXT_DENIED`, or the `[ref evt_…]` token) and
 * everything else is a fault. Two surfaces reading the same error with two
 * different rules is how a screen ends up claiming a decision the one next to
 * it does not show.
 */
async function readOne(
  tool: { execute: (input: unknown) => Promise<unknown> },
  loanId: string,
): Promise<LoanRead> {
  let value: unknown;
  try {
    value = await tool.execute({ loan_id: loanId });
  } catch (cause) {
    const text = failureText(cause);

    const authorization = authorizationRequired(text);
    if (authorization) {
      return {
        loan_id: loanId,
        outcome: "authorization",
        ...(authorization.url === undefined ? {} : { url: authorization.url }),
        ...(authorization.instructions ? { instructions: authorization.instructions } : {}),
      };
    }

    if (!isHookDecision(text)) return { loan_id: loanId, outcome: "fault", message: text };

    const reason = remediationText(text);
    return { loan_id: loanId, outcome: "denied", reason, ref: correlationRef(reason) };
  }

  const loan = loanFromToolResult(value);
  if (loan === null) {
    return {
      loan_id: loanId,
      outcome: "fault",
      message: `The loan book answered with something this screen could not read as a loan file.`,
    };
  }
  return { loan_id: loanId, outcome: "read", loan };
}

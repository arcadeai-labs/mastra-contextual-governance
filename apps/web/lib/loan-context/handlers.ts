/**
 * `GET /api/loan-context` — the two loan files the left half puts on screen,
 * read the same way the agent reads them.
 *
 * A plain `(Request) => Promise<Response>`, for the reason every route in this
 * service is one: the suite mounts this exact function behind a real
 * `Bun.serve`, drives it with a cookie jar through a real gateway transport
 * against a real `/pre` and a real loan book, and asserts on what comes back.
 * `app/api/loan-context/route.ts` is a one-line adapter onto it.
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
 * sitting inches from a panel asserting there is only one — and once `/post`
 * redaction lands (#16), the chat would show a masked account number beside a
 * file that never had one masked. So this route is an MCP client of the gateway
 * with the signed-in persona's bearer, exactly like `lib/agent/tools.ts`, and
 * the reads it makes appear in the audit log like any other.
 *
 * The cost is honest and worth stating: opening this page makes two real
 * governed tool calls, and two `Loan.GetLoan` rows appear on the panel before
 * the presenter has said anything. That is what reading a loan file costs here.
 *
 * ## Who the read is made as
 *
 * This browser's sealed session, and nothing else. No branch in this file reads
 * an identity from the query string, the body or a header — `DESIGN.md` rule 1,
 * the same rule the chat route and the verifier hold to.
 */
import { gatewayProblems, readIdentitySurface, type IdentitySurface } from "../config.ts";
import { authorizationRequired, isHookDecision, remediationText } from "../agent/authorization.ts";
import { correlationRef, failureText } from "../agent/run.ts";
import { liveGatewayToken } from "../identity/handlers.ts";
import { gatewayClient, governedToolset } from "../agent/tools.ts";
import { readSession, writeSession, type Session } from "../identity/session.ts";
import {
  DEMO_LOAN_IDS,
  LOAN_CONTEXT_PATH,
  loanFromToolResult,
  type LoanContextBody,
  type LoanContextRefusal,
  type LoanRead,
} from "./loans.ts";

// Defined in `loans.ts`, which depends on nothing — the client component needs
// it too, and importing it from here would drag `@mastra/mcp` and its stdio
// transport's `fs` import into the browser bundle. That is the failure
// `lib/agent/events.ts` records for `CHAT_PATH`; one is enough.
export { LOAN_CONTEXT_PATH };

/** How long one `tools/call` may take. Shorter than a turn: nobody watches a page load for 30s. */
const MCP_TIMEOUT_MS = 20_000;

/**
 * The suffix that identifies the read tool on the wire.
 *
 * `DESIGN.md` → Tool surface: MCP advertises `Loan_GetLoan`, and the toolkit
 * half is configurable (`ARCADE_LOAN_TOOLKIT`) while the tool half is not — it
 * is what `arcade-mcp` PascalCases `get_loan` into. Matching the suffix inside
 * the agent's own allow-list is what keeps this route and the agent pointed at
 * the same tool without a second copy of the toolkit name to keep in step.
 *
 * It is matched against the **governed** selection rather than everything the
 * gateway advertises, so a built-in that happened to end the same way could
 * never be selected here.
 */
const GET_LOAN_SUFFIX = "_GetLoan";

export interface LoanContextOptions {
  config?: IdentitySurface;
  /** Only for tests, which need to see which tool was picked out of the surface. */
  onTool?: (name: string) => void;
}

function refuse(status: number, body: LoanContextRefusal): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function loanContext(
  request: Request,
  options: LoanContextOptions = {},
): Promise<Response> {
  const config = options.config ?? readIdentitySurface();

  if (request.method !== "GET") return refuse(405, { error: "GET this route." });

  // The gateway hop, not the agent's: this route reads loan files without ever
  // running a model, so an unset ANTHROPIC_API_KEY must not blank the screen.
  const problems = gatewayProblems(config);
  if (problems.length > 0) {
    return refuse(503, {
      error: "This deployment cannot reach the loan book.",
      detail: problems,
    });
  }

  const session = await readSession(request, config);
  if (!session) {
    return refuse(401, {
      error: "Nobody is signed in on this browser, so there is no one to read the file as.",
      action: "signin",
    });
  }

  const live = await liveGatewayToken(session, config);
  if (live.token === null) {
    return refuse(401, { error: `${live.reason}.`, action: "gateway" });
  }

  const client = gatewayClient({
    arcadeApiUrl: config.arcadeApiUrl,
    gatewayId: config.identity.gatewayId,
    token: live.token,
    timeoutMs: MCP_TIMEOUT_MS,
  });

  try {
    let selected: Awaited<ReturnType<typeof governedToolset>>;
    try {
      selected = await governedToolset(client, { toolkits: config.agent.toolkits });
    } catch (cause) {
      return refuse(502, { error: `The gateway would not list its tools: ${String(cause)}` });
    }

    const names = Object.keys(selected.tools).filter((name) => name.endsWith(GET_LOAN_SUFFIX));
    // Loud, not quiet. Nothing matched means a wrong `ARCADE_LOAN_TOOLKIT` or a
    // toolkit that did not deploy, and the symptom — an empty column where the
    // loan files should be — looks exactly like a control plane that denied
    // them. Two matches means two toolkits claim the same tool, and picking one
    // would be a guess about which loan book the audience is looking at.
    if (names.length !== 1) {
      return refuse(502, {
        error:
          names.length === 0
            ? `The gateway advertised ${selected.advertised.length} tools and none of the governed ones ` +
              `is a ${GET_LOAN_SUFFIX.slice(1)}, so there is no way to read a loan file. Check ` +
              `ARCADE_LOAN_TOOLKIT against a real tools/list.`
            : `${names.length} governed tools end in ${GET_LOAN_SUFFIX}, so which loan book this is ` +
              `would be a guess: ${names.join(", ")}.`,
        detail: selected.advertised,
      });
    }

    const toolName = names[0] as string;
    options.onTool?.(toolName);
    const tool = selected.tools[toolName] as { execute: (input: unknown) => Promise<unknown> };

    // Sequential, not parallel. Two calls on one MCP session in flight at once
    // is a transport question this slice has no measurement for, and the whole
    // page load is two reads.
    const reads: LoanRead[] = [];
    for (const loanId of DEMO_LOAN_IDS) {
      reads.push(await readOne(tool, loanId));
    }

    const body: LoanContextBody = { reads, actor: session.email, tool: toolName };
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    // A refreshed gateway token has to be resealed or the next read re-refreshes
    // one that is already dead. Same rule as the chat route.
    if (live.session !== session) await writeSession(headers, request, live.session as Session, config);
    return new Response(JSON.stringify(body), { headers });
  } finally {
    // This connection carries one persona's bearer and belongs to this request.
    await client.disconnect().catch(() => undefined);
  }
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
        url: authorization.url,
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

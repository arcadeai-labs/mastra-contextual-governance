/**
 * A stand-in for the Arcade **gateway**, speaking MCP over HTTP.
 *
 * **This is not the product**, in the same way `arcade-stand-in.ts` is not: it
 * is a development fixture a forker deletes. The difference between the two is
 * the transport and the audience. `arcade-stand-in.ts` imitates the REST
 * `/v1/tools/execute` endpoint the approval page presses; this one imitates
 * `POST https://api.arcade.dev/mcp/{gateway}`, which is where the **agent**
 * reaches its tools (`DESIGN.md` → Integration).
 *
 * ## What is real and what is not
 *
 * Real, on every `tools/call`:
 *
 *   1. `POST /pre` on the actual control plane, with the acting persona's
 *      `user_id`, the tool split into toolkit and name, and the model's own
 *      inputs.
 *   2. Anything but `OK` and **the tool does not run**. The refusal comes back
 *      in the shape spike #2 measured off real Arcade over MCP:
 *      `{ isError: true, content: [{ type: "text", text: "<PREFIX><error_message>" }] }`,
 *      with the hook's `error_message` verbatim behind Arcade's fixed prefix.
 *   3. On `OK`, the tool runs — which for `tools/loan` is one HTTP call to
 *      `apps/loan-app` carrying the persona's bearer, exactly what the deployed
 *      Python toolkit does (`tools/loan/loan/__init__.py::_call`).
 *   4. `POST /post` on the same control plane with what the tool returned, and
 *      **the model is handed `override.output` when the hook sends one** (#16).
 *      `CHECK_FAILED` there withholds the output entirely, in the same
 *      `isError` envelope a `/pre` denial arrives in.
 *
 * So a denial a person sees in the chat is produced by the real pre-hook
 * against the real policy in `governance.db`, and an approval is a real row in
 * `loans.db` attributed to the real actor. **The fiction is the transport and
 * the Python worker, and nothing else.**
 *
 * Real, on every `tools/list` (added by #15):
 *
 *   1. `POST /access` on the actual control plane, with the bearer's `user_id`
 *      and the project's own toolkit in the nested `Toolkits` shape the request
 *      type takes.
 *   2. Every tool named in the response's `deny` map is **removed from the
 *      answer**. It is absent, not present-and-refused, which is act 1's whole
 *      claim: there is nothing there for the model to reason around.
 *   3. An `/access` that cannot be reached, or that answers anything but 2xx,
 *      hides **everything**. Fail closed — spike #2 measured real Arcade doing
 *      the equivalent (every tool in the project fails when the deny map is the
 *      wrong shape), and a stand-in that fell back to the whole catalogue would
 *      turn a dead control plane into an open one.
 *
 * Not real, and deliberately so:
 *
 * - **Slack.** With a store token, `Approvals_RequestApproval` routes by #9's
 *   real rule and records the request against the real `/approvals` endpoints,
 *   and then does not post a DM, because a user token for Slack is a credential
 *   no local run holds. The result says that in words rather than reporting a
 *   `slack_message_ts` it invented — an agent that believes it has escalated
 *   something nobody will see is the one failure `tools/approvals` spends a
 *   comment block on. Without a store token the two approvals tools are still
 *   advertised and still governed, and a call to one is refused with a sentence
 *   saying so: being in the list is what act 2's second half needs (#89), and
 *   running is a separate question (#20).
 * - **Layer 2 is a switch, not a flow.** Arcade evaluates tool auth
 *   requirements before `/pre` and, on a first use, answers with an
 *   `authorization_url` for the persona to visit. There is no OAuth here to
 *   drive, so `requireAuthorizationFor` makes a named tool answer in that
 *   measured shape once. It exists because the chat has to render that link and
 *   stop, and because that path must have a test.
 *
 * Layer 2 is the only one left on that list. `/access` was on it until #15 and
 * `/post` until #16, and both absences cost something specific: without
 * `/access` act 1 could not be shown here at all, and without `/post` the local
 * tracer was *more hostile* than production — the model read act 4's injected
 * note here and would not have read it through real Arcade (#91). Both hooks
 * are called now, so the stand-in and the deployed system agree on every layer
 * that fires one.
 *
 * ## Tokens are how a persona reaches the hooks
 *
 * The real gateway resolves the bearer to the User Source identity Arcade holds
 * for it. Here a bearer is a row in a table: `issueToken(email)` mints one, and
 * every `/pre` payload and every call to `apps/loan-app` is made as that
 * person. A bearer nobody minted is a `401` with the `WWW-Authenticate` header
 * the real gateway sends, because that 401 is where hop 1's discovery starts
 * and a stand-in that skipped it would hide a real failure.
 *
 * ## One stand-in, or two
 *
 * `test/identity-harness.ts` carries its own narrower Arcade Cloud stand-in for
 * the two identity hops (#82): discovery, dynamic registration, authorize,
 * token, `confirm_user`, `next_uri`. This file does not duplicate any of that —
 * it starts where a token already exists. The two overlap only in that both
 * answer on an `/mcp/{gateway}` path, and folding them together is worth doing
 * but would mean editing #82's suite from this slice. Filed as #87 instead,
 * which is also what would let `/chat` be driven offline from a browser.
 */

import { routeApproval } from "@cg/governance-core";
import type { Subject } from "@cg/policy-schema";

/** Arcade's fixed prefix ahead of the hook's own message. Measured, spike #2. */
export const DENIAL_PREFIX = "Tool execution was denied by an extension policy: ";

/**
 * The version every payload here names a tool at.
 *
 * One constant rather than three literals: `/access` copies the request's own
 * version array into its `deny` map, so a `/pre` payload and an `/access`
 * payload that disagreed about the version would describe two different tools
 * to the same policy.
 */
const TOOL_VERSION = "1.0.0";

/**
 * The two tools the live gateway advertises on top of a project's own —
 * measured against `cg-demo-us` for a signed-in persona, which returns eight
 * entries, not six.
 *
 * They are listed here because a stand-in that advertised only the project's
 * six would let `lib/agent/tools.ts`'s filter pass a test it would fail against
 * the real gateway, and the agent would be handed two tools that have nothing
 * to do with loans.
 */
export const GATEWAY_BUILTINS = ["System_ManageAuthorization", "Arcade_ListApps"] as const;

/**
 * What a project toolkit advertises, as `arcade-mcp` PascalCases it (#35), and
 * how — or whether — this stand-in runs it once `/pre` has allowed the call.
 *
 * Two targets, because the two deployed toolkits are stateless clients of two
 * different services and neither of them is Arcade. `tools/loan` calls
 * `apps/loan-app` with the persona's bearer; `tools/approvals` calls the
 * `/approvals` endpoints on `apps/hooks` with the shared store token. The
 * split is `arcade deploy`'s, not this file's — see `DESIGN.md` → Services.
 *
 * **Advertising a tool and running it are two different things**, and the
 * approvals toolkit is where the difference is load-bearing in both directions.
 * The agent has to be able to *see* `Approvals_RequestApproval`, because the
 * pre-hook's remediation sentence names it and a model that cannot see it
 * refuses the instruction (#89) — so it is always advertised, always submitted
 * to `/access`, always governed at `/pre`. Whether it then *runs* depends on
 * whether this stand-in was given a store token to reach `/approvals` with
 * (#20). Without one, `call` is absent and the call is refused honestly rather
 * than answered with an invented request id.
 */
interface BaseToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface LoanToolSpec extends BaseToolSpec {
  target: "loan-app";
  /** `GET /loans`, `GET /loans/{loan_id}`, … — how this stand-in runs the tool. */
  run: (inputs: Record<string, unknown>) => { method: string; path: string; query?: Record<string, string>; body?: unknown };
}

interface ApprovalsToolSpec extends BaseToolSpec {
  target: "approvals";
  /**
   * The tool's own body, run in-process against the real `/approvals`
   * endpoints. Returns what the deployed Python tool returns, or the message
   * it would have raised as a `ToolExecutionError`.
   *
   * **Absent when this stand-in holds no store token.** Then the tool is still
   * advertised and still governed — it reaches `/access` and `/pre`, and it is
   * on the panel and in the audit log, which is what act 2's second half has to
   * be able to show — and the call is refused with a sentence saying so. An
   * invented request id would be worse in exactly the way this repo keeps
   * naming: the beat would look finished and no approver would ever have been
   * asked.
   */
  call?: (
    inputs: Record<string, unknown>,
    actor: string,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

type ToolSpec = LoanToolSpec | ApprovalsToolSpec;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/**
 * The loan tools, named the way the wire names them.
 *
 * `Loan_GetLoan` with an underscore, because that is what MCP carries; the hook
 * frame names the same tool `Loan.GetLoan` with a dot. Two spellings of one
 * tool, and neither is invented here: `qualifiedToolName` below is the only
 * place that converts between them.
 *
 * The descriptions are shortened from `tools/loan`'s. They are what the model
 * picks a tool from, so they say what each one does and nothing about who may
 * do it — authority is the control plane's question, asked after the model has
 * already chosen (`DESIGN.md` → Thesis).
 */
function loanTools(toolkit: string): LoanToolSpec[] {
  return [
    {
      target: "loan-app",
      name: `${toolkit}_SearchLoans`,
      description:
        "Find loan applications in the loan book, newest submission first. All filters are optional and combine; with none supplied this returns every application on file.",
      inputSchema: object({
        status: { ...str("Only applications in this state."), enum: ["pending", "approved", "denied"] },
        min_amount: num("Only applications requesting at least this many US dollars."),
        max_amount: num("Only applications requesting at most this many US dollars."),
      }),
      run: (inputs) => ({
        method: "GET",
        path: "/loans",
        query: Object.fromEntries(
          ["status", "min_amount", "max_amount"]
            .filter((key) => inputs[key] !== undefined && inputs[key] !== null)
            .map((key) => [key, String(inputs[key])]),
        ),
      }),
    },
    {
      target: "loan-app",
      name: `${toolkit}_GetLoan`,
      description:
        "Read one loan application's complete file by ID. Use this whenever you need more than the list-view fields, and always before recording a decision.",
      inputSchema: object({ loan_id: str("The loan application ID, in the form LN-0000.") }, ["loan_id"]),
      run: (inputs) => ({ method: "GET", path: `/loans/${encodeURIComponent(String(inputs.loan_id))}` }),
    },
    {
      target: "loan-app",
      name: `${toolkit}_ApproveLoan`,
      description:
        "Approve a loan application for a given dollar amount, committing the decision to the loan book. It is a write against the bank's system of record, not a recommendation, and there is no undo.",
      inputSchema: object(
        {
          loan_id: str("The loan application ID, in the form LN-0000."),
          amount: num("The amount to approve, in US dollars."),
        },
        ["loan_id", "amount"],
      ),
      run: (inputs) => ({
        method: "POST",
        path: `/loans/${encodeURIComponent(String(inputs.loan_id))}/approve`,
        body: { amount: inputs.amount },
      }),
    },
    {
      target: "loan-app",
      name: `${toolkit}_DenyLoan`,
      description:
        "Decline a loan application with a stated reason, committing the decision to the loan book. There is no undo.",
      inputSchema: object(
        {
          loan_id: str("The loan application ID, in the form LN-0000."),
          reason: str("Why the application is being declined. Recorded verbatim and read by auditors."),
        },
        ["loan_id", "reason"],
      ),
      run: (inputs) => ({
        method: "POST",
        path: `/loans/${encodeURIComponent(String(inputs.loan_id))}/deny`,
        body: { reason: inputs.reason },
      }),
    },
  ];
}

/**
 * The half of `tools/approvals` that is not Slack, as an HTTP client of the
 * `/approvals` endpoints.
 *
 * Each method mirrors one tool body in `tools/approvals/approvals/__init__.py`,
 * including the two places that one raises rather than returns: an amount
 * nobody on the roster can cover, and a store that would not record the
 * request. Returning a plausible success there would let an agent believe it
 * had escalated something nobody will ever see, which is the failure the
 * Python tool spends a comment block on.
 */
interface ApprovalsStore {
  requestApproval(
    inputs: Record<string, unknown>,
    actor: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  decide(
    inputs: Record<string, unknown>,
    actor: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

function createApprovalsStore(options: {
  hooks: string;
  storeToken: string;
  webHost: string;
}): ApprovalsStore {
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`${options.hooks}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.storeToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    async requestApproval(inputs, actor) {
      const action = String(inputs.action ?? "");
      const resourceId = String(inputs.resource_id ?? "");
      const amount = Number(inputs.amount);
      const justification = String(inputs.justification ?? "");
      if (!Number.isFinite(amount)) {
        return { ok: false, error: `${String(inputs.amount)} is not an amount that can be routed for approval.` };
      }

      const rosterResponse = await request("GET", "/approvals/roster").catch(
        (cause: unknown) => cause as Error,
      );
      if (rosterResponse instanceof Error || !rosterResponse.ok) {
        const detail =
          rosterResponse instanceof Error ? rosterResponse.message : String(rosterResponse.status);
        return { ok: false, error: `The approvals store would not answer for the roster (${detail}).` };
      }
      const roster = ((await rosterResponse.json()) as { subjects?: Subject[] }).subjects ?? [];

      // #9's rule, the real module, the same one `tools/approvals` is checked
      // against. The agent does not choose the approver and neither does this.
      const routed = routeApproval(amount, actor, roster);
      if (routed.outcome === "no_eligible_approver") {
        return {
          ok: false,
          error:
            `Nobody holds authority sufficient to approve ${action} for ${amount}, so no ` +
            `approval was requested.`,
        };
      }

      const created = await request("POST", "/approvals", {
        requester_id: actor,
        action,
        resource_id: resourceId,
        amount,
        justification,
        approver_id: routed.approver.user_id,
        candidate_approver_ids: routed.candidates.map((subject) => subject.user_id),
        required_clearance: routed.required_clearance,
      });
      const body = (await created.json().catch(() => null)) as
        | { request?: { id?: string; status?: string }; error?: string }
        | null;
      const requestId = body?.request?.id;
      if (created.status !== 201 || !requestId) {
        return {
          ok: false,
          error:
            `The approval request could not be recorded, so nobody was asked ` +
            `(${body?.error ?? created.status}).`,
        };
      }

      return {
        ok: true,
        value: {
          request_id: requestId,
          status: body?.request?.status ?? "pending",
          approver: routed.approver.user_id,
          approver_display_name: routed.approver.display_name || routed.approver.user_id,
          required_clearance: routed.required_clearance,
          candidate_approvers: routed.candidates.map((subject) => subject.user_id),
          approval_url: `${options.webHost}/approvals/${requestId}`,
          // Not a `slack_message_ts`, because no message was sent. Saying so
          // is the difference between "go and tell Riley" and an agent that
          // believes it has escalated something nobody has seen — the same
          // distinction `tools/approvals` raises a `ToolExecutionError` for
          // when Slack refuses.
          notification:
            "No Slack message was sent: this is the offline gateway stand-in, which holds no " +
            "Slack credential. The request is recorded and routed; the approver has to be told " +
            "another way.",
        },
      };
    },

    async decide(inputs, actor) {
      const id = String(inputs.request_id ?? "");
      const decision = String(inputs.decision ?? "");
      const note = inputs.note === undefined || inputs.note === null ? null : String(inputs.note);
      const response = await request("POST", `/approvals/${encodeURIComponent(id)}/decision`, {
        decision,
        note,
        // From the resolved bearer, never from an argument: the deployed tool
        // takes it from `context.user_id` for the same reason.
        decided_by: actor,
      });
      const body = (await response.json().catch(() => null)) as
        | { request?: unknown; error?: string }
        | null;
      if (!response.ok) {
        return { ok: false, error: body?.error ?? `the approvals store answered ${response.status}` };
      }
      return { ok: true, value: body?.request ?? {} };
    },
  };
}

/**
 * The approvals tools, advertised and governed here; run only when this
 * stand-in was given a store token.
 *
 * They exist in this file for one reason: `tools/list` is where the agent's
 * surface comes from, and act 2's second half is the model reading a denial
 * that says *"call `Approvals_RequestApproval`"* and doing it. A stand-in that
 * advertised the loan toolkit alone would make that impossible offline and
 * would make it look like a model problem — which is exactly how #89 was found.
 *
 * **The descriptions state what each tool does and instruct the model in
 * nothing** — not when to call it, not what to do after it answers, not who
 * chooses the approver. `DESIGN.md` → No model-side controls bars behavioural
 * instruction "in either direction: nothing about confirming, refusing,
 * escalating, retrying, caution or irreversibility", and it bars it in a tool
 * description exactly as it bars it in the system prompt. Round 1 of #89's
 * review caught an earlier draft here saying *"Escalate an action you were
 * refused authority for ... You do not choose the approver ... It does not wait
 * for the answer"*: three behavioural instructions, defended at the time with
 * the wrong test — "nothing about who may do it" is not the rule.
 *
 * It matters more here than anywhere, because the live 5/5 measurement is the
 * claim that *the hook's sentence* moved the model. A description that already
 * told it to escalate after a refusal would have been steering the result the
 * measurement was taken to prove, and the number would have meant nothing.
 * `test/act1-tool-list.test.ts` reads these back through a real `tools/list`
 * and fails on the vocabulary, so the rule is enforced on the sentence the
 * model receives rather than on the source that produced it.
 *
 * `store` is what makes them runnable (#20). Without it they are advertised,
 * submitted to `/access`, governed at `/pre` — and then honestly refused.
 */
function approvalsTools(toolkit: string, store?: ApprovalsStore): ApprovalsToolSpec[] {
  return [
    {
      target: "approvals",
      name: `${toolkit}_RequestApproval`,
      description:
        "Records a request for one person's approval of an action on a resource, and notifies the approver it routes to. Returns the request ID and who was notified.",
      inputSchema: object(
        {
          action: str("The action the approval would cover — for example approve_loan."),
          resource_id: str("What the action would act on, such as a loan application ID."),
          amount: num("The amount the approval would cover, in US dollars."),
          justification: str("The case for the action. The approver reads it verbatim."),
        },
        ["action", "resource_id", "amount", "justification"],
      ),
      ...(store === undefined
        ? {}
        : { call: (inputs, actor) => store.requestApproval(inputs, actor) }),
    },
    {
      target: "approvals",
      name: `${toolkit}_Decide`,
      description: "Records an approver's answer against an approval request.",
      inputSchema: object(
        {
          request_id: str("The approval request being answered."),
          decision: { ...str("The answer."), enum: ["approved", "denied"] },
          note: str("An optional note recorded with the decision."),
        },
        ["request_id", "decision"],
      ),
      ...(store === undefined ? {} : { call: (inputs, actor) => store.decide(inputs, actor) }),
    },
  ];
}

/**
 * `Loan_GetLoan` → `{ toolkit: "Loan", name: "GetLoan" }`.
 *
 * The first underscore separates them, and only the first: every tool name
 * `arcade-mcp` produces is PascalCase on both sides, so a later underscore
 * would be a name neither this repo nor Arcade generates. A name with no
 * underscore at all is returned with an empty toolkit rather than guessed at,
 * and the caller refuses it — a stand-in that invented a toolkit would build a
 * `/pre` payload matching no rule, which is the failure mode this project keeps
 * naming.
 */
export function qualifiedToolName(wire: string): { toolkit: string; name: string } {
  const cut = wire.indexOf("_");
  if (cut <= 0) return { toolkit: "", name: wire };
  return { toolkit: wire.slice(0, cut), name: wire.slice(cut + 1) };
}

export interface GatewayStandInOptions {
  /** The gateway slug the MCP path carries: `/mcp/cg-demo-us`. */
  gatewayId: string;
  /** The control plane, HOST-form. */
  hooksHost: string;
  /** What `/pre` requires as its bearer. */
  hookSigningSecret: string;
  /** `apps/loan-app`, HOST-form. The tools are stateless clients of it. */
  loanAppHost: string;
  /** `tool.toolkit` as Arcade files the deployed loan toolkit. */
  loanToolkit?: string;
  /**
   * `tool.toolkit` as Arcade files the deployed approvals toolkit.
   *
   * Always advertised, whether or not this is set — the default is the name
   * `.env.example` pins. The agent has to be able to see
   * `Approvals_RequestApproval` because the pre-hook's remediation sentence
   * names it (#89).
   */
  approvalsToolkit?: string;
  /**
   * The shared `APPROVALS_STORE_TOKEN` the two approvals tools present, which
   * is what makes them **runnable** here (#20).
   *
   * Unset, they are still advertised, still submitted to `/access` and still
   * governed at `/pre`, and a call to one is then refused with a sentence
   * saying this stand-in does not run it. Set, they are real clients of the
   * real `/approvals` endpoints on `apps/hooks`.
   */
  approvalsStoreToken?: string;
  /** Where the approval link points. HOST-form or a full origin. */
  webPublicHost?: string;
  /** `0` lets the OS pick, which is what tests and an unset `PORT` want. */
  port?: number;
  /**
   * How a persona's bearer becomes a bearer `apps/loan-app` accepts.
   *
   * The deployed toolkit is handed the persona's `cg-idp` access token by
   * Arcade. Offline there is no such token, so this maps the persona's email to
   * whatever the loan API's identity provider will answer for — `dev:<email>`
   * for `apps/loan-app/scripts/dev-idp.ts`, which is the established local
   * protocol in this repo.
   */
  tokenForActor?: (email: string) => string;
  /** Every `tools/call`, in order, whatever the outcome. The suite asserts on this. */
  onCall?: (call: {
    user_id: string;
    tool: string;
    inputs: Record<string, unknown>;
    outcome: "denied" | "ran" | "authorization_required" | "withheld";
    /** Whether `/post` rewrote what the tool returned. Only set on `ran`. */
    redacted?: boolean;
  }) => void;
  /**
   * Every `tools/list`, with what `/access` took away.
   *
   * Separate from `onCall` because a hidden tool is the opposite of a call: it
   * is the absence of one. A suite that could only see calls could not tell
   * "the analyst never tried" from "the analyst tried and we did not record
   * it", and act 1 is precisely the first of those.
   */
  onList?: (list: { user_id: string; advertised: string[]; hidden: string[] }) => void;
}

export interface GatewayStandIn {
  port: number;
  url: string;
  /** Mint a bearer for a persona. The real gateway's User Source does this at the end of hop 1. */
  issueToken(email: string): string;
  /**
   * Make the next call to this wire-named tool answer with layer 2's
   * authorization challenge instead of reaching `/pre`.
   *
   * One shot, because that is how the real thing behaves: a persona who
   * authorizes once is not challenged again, and a switch that stayed on would
   * make the "and then it works" half of the path untestable.
   */
  requireAuthorizationFor(wireName: string, authorizationUrl: string): void;
  stop(): void;
}

export function createGatewayStandIn(options: GatewayStandInOptions): GatewayStandIn {
  const toolkit = options.loanToolkit ?? "Loan";
  const approvalsToolkit = options.approvalsToolkit?.trim() || "Approvals";
  const actors = new Map<string, string>();
  const challenges = new Map<string, string>();
  const tokenForActor = options.tokenForActor ?? ((email: string) => `dev:${email}`);

  const base = (host: string) =>
    host.startsWith("localhost") || host.startsWith("127.0.0.1") ? `http://${host}` : `https://${host}`;
  const hooks = base(options.hooksHost);
  const loanApp = base(options.loanAppHost);

  // Runnable only with a store token to reach `/approvals` with. Advertised
  // either way — see `approvalsStoreToken` on the options above.
  const approvalsStore =
    (options.approvalsStoreToken ?? "") === ""
      ? undefined
      : createApprovalsStore({
          hooks,
          storeToken: options.approvalsStoreToken as string,
          webHost: options.webPublicHost?.startsWith("http")
            ? options.webPublicHost
            : base(options.webPublicHost ?? "localhost:3000"),
        });

  // Both project toolkits, because a live gateway advertises both and the
  // agent's allow-list is keyed on both (DESIGN.md → Tool surface). Grouped by
  // toolkit rather than flattened, because `/access` speaks toolkit-and-tool
  // and the request below has to carry every one of them.
  const byToolkit: Record<string, ToolSpec[]> = {
    [toolkit]: loanTools(toolkit),
    [approvalsToolkit]: approvalsTools(approvalsToolkit, approvalsStore),
  };
  const tools = Object.values(byToolkit).flat();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const mcpPath = `/mcp/${options.gatewayId}`;

  /**
   * Layer 1: which of this toolkit's tools may `actor` see at all.
   *
   * The request is the nested `Toolkits` shape `AccessHookRequest` takes, down
   * to the innermost array of versions — spike #2 measured what any other shape
   * does, and `apps/hooks` copies the request's own entry across into `deny`,
   * so the two have to agree exactly. The version string is the one every other
   * payload in this file carries.
   *
   * Returns wire names (`Loan_ApproveLoan`), because that is what `tools/list`
   * answers in; `/access` speaks tool-and-toolkit, and this is the join.
   */
  async function hiddenFor(actor: string): Promise<{ ok: true; tools: Set<string> } | { ok: false; reason: string }> {
    // One entry per toolkit, each carrying its own tools. Submitting only the
    // loan toolkit would leave every approvals tool unasked-about — and an
    // unasked question is not an allow, it is a control that never ran.
    const toolkits = Object.fromEntries(
      Object.entries(byToolkit).map(([name, specs]) => [
        name,
        {
          tools: Object.fromEntries(
            specs.map((tool) => [qualifiedToolName(tool.name).name, [{ version: TOOL_VERSION }]]),
          ),
        },
      ]),
    );

    const access = await fetch(`${hooks}/access`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.hookSigningSecret}` },
      body: JSON.stringify({ user_id: actor, toolkits }),
    }).catch((cause: unknown) => cause as Error);

    if (access instanceof Error) {
      return { ok: false, reason: `the control plane at ${hooks} could not be reached for /access: ${access.message}` };
    }
    if (access.status === 401) {
      return { ok: false, reason: "the control plane refused the stand-in's hook bearer on /access; set ARCADE_HOOK_SIGNING_SECRET on both." };
    }
    if (!access.ok) {
      return { ok: false, reason: `the control plane answered ${access.status} to /access, so no tool is listed.` };
    }

    const verdict = (await access.json().catch(() => null)) as { deny?: Record<string, { tools?: Record<string, unknown> }> } | null;
    if (verdict === null) {
      return { ok: false, reason: "the control plane answered /access with something that was not JSON." };
    }

    const hidden = new Set<string>();
    for (const [deniedToolkit, info] of Object.entries(verdict.deny ?? {})) {
      for (const name of Object.keys(info?.tools ?? {})) hidden.add(`${deniedToolkit}_${name}`);
    }
    return { ok: true, tools: hidden };
  }

  /** A JSON-RPC result. The MCP client reads `result`; a tool failure is in-band. */
  const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const rpcError = (id: unknown, code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } });

  /** A tool result the MCP spec calls a failure: `isError` plus text content. */
  const toolError = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
  const toolOk = (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });

  const server = Bun.serve({
    port: options.port ?? 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== mcpPath) return Response.json({ error: "not found" }, { status: 404 });

      // The real gateway answers an unauthenticated call with the 401 that
      // names where its protected-resource metadata lives. Hop 1's discovery
      // starts there (`lib/identity/gateway.ts`), so a stand-in that let an
      // anonymous call through would hide the one failure that matters.
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${mcpPath}"`,
          },
        });
      }
      const actor = actors.get(bearer);
      if (actor === undefined) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      if (request.method !== "POST") return new Response(null, { status: 405 });

      const message = (await request.json().catch(() => null)) as
        | { id?: unknown; method?: string; params?: Record<string, unknown> }
        | null;
      if (!message?.method) return rpcError(message?.id ?? null, -32600, "not a JSON-RPC request");

      if (message.method === "initialize") {
        return rpc(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `${options.gatewayId} (stand-in)`, version: "0.1.0" },
        });
      }
      if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });

      if (message.method === "tools/list") {
        const hidden = await hiddenFor(actor);
        if (!hidden.ok) {
          // Fail closed, loudly. Not an empty list: an empty catalogue is what
          // "everything is denied" and "the control plane is down" would both
          // look like, and the agent's own 502 would then name the wrong
          // variable. An error says which of the two happened.
          return rpcError(message.id, -32603, hidden.reason);
        }
        const visible = tools.filter((tool) => !hidden.tools.has(tool.name));
        options.onList?.({
          user_id: actor,
          advertised: [...visible.map((tool) => tool.name), ...GATEWAY_BUILTINS],
          hidden: [...hidden.tools],
        });
        return rpc(message.id, {
          tools: [
            ...visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            // The gateway's own, advertised to every client. Not loan tools,
            // and `lib/agent/tools.ts` is what keeps them away from the agent.
            //
            // They are *not* submitted to `/access` and never hidden by it. That
            // is a measurement, not a shortcut: a live `tools/list` for a
            // signed-in persona carries eight entries — the project's six plus
            // these two — and that list is what Arcade answered *after* our
            // access hook ran (#82, DESIGN.md → Tool surface). Whatever Arcade
            // does with its own built-ins, it does not let our deny map reach
            // them, so a stand-in that hid them would advertise a surface the
            // real gateway never returns.
            ...GATEWAY_BUILTINS.map((name) => ({
              name,
              description: `Arcade gateway built-in (${name}).`,
              inputSchema: object({}),
            })),
          ],
        });
      }

      if (message.method !== "tools/call") return rpcError(message.id, -32601, `no method ${message.method}`);

      const wire = String(message.params?.name ?? "");
      const inputs = (message.params?.arguments ?? {}) as Record<string, unknown>;

      // Layer 2, before anything else — because Arcade evaluates auth
      // requirements before /pre, and a refusal there fires no hook
      // (DESIGN.md, open risk 2).
      const challenge = challenges.get(wire);
      if (challenge !== undefined) {
        challenges.delete(wire);
        options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "authorization_required" });
        return rpc(message.id, toolError(authorizationChallenge(challenge)));
      }

      const { toolkit: calledToolkit, name } = qualifiedToolName(wire);
      if (!calledToolkit) {
        return rpc(message.id, toolError(`"${wire}" is not a fully-qualified tool name.`));
      }

      // One id for both hooks on one call: `execution_id` is what correlates
      // `/pre` with `/post` in the audit log (`DESIGN.md` → Event contract), and
      // a stand-in that minted two would break the panel's join.
      const executionId = `tc_${crypto.randomUUID().slice(0, 8)}`;

      const pre = await fetch(`${hooks}/pre`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.hookSigningSecret}` },
        body: JSON.stringify({
          execution_id: executionId,
          tool: { name, toolkit: calledToolkit, version: TOOL_VERSION },
          inputs,
          context: { authorization: [{}], user_id: actor },
        }),
      }).catch((cause: unknown) => cause as Error);

      if (pre instanceof Error) {
        return rpc(message.id, toolError(`the control plane at ${hooks} could not be reached: ${pre.message}`));
      }
      if (pre.status === 401) {
        return rpc(
          message.id,
          toolError("the control plane refused the stand-in's hook bearer; set ARCADE_HOOK_SIGNING_SECRET on both."),
        );
      }
      const verdict = (await pre.json().catch(() => ({}))) as { code?: string; error_message?: string };

      if (verdict.code !== "OK") {
        options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "denied" });
        // The one line the whole thesis rests on: the hook's own message,
        // untouched, behind Arcade's fixed prefix.
        return rpc(message.id, toolError(DENIAL_PREFIX + (verdict.error_message ?? "denied by an extension policy")));
      }

      const spec = byName.get(wire);
      if (!spec) {
        return rpc(
          message.id,
          toolError(
            `"${wire}" passed /pre, but this stand-in only runs ` +
              `${[...new Set(tools.map((tool) => qualifiedToolName(tool.name).toolkit))].join(" and ")}.`,
          ),
        );
      }
      if (spec.target === "approvals" && spec.call === undefined) {
        // Advertised, governed, and then honestly unfinished — this stand-in
        // was given no store token. The call reached `/access` and `/pre` and
        // is on the panel and in the audit log, which is what act 2's second
        // half has to be able to show. What it cannot do without a bearer for
        // `/approvals` is record the request and route an approver.
        //
        // An invented request id would be worse than this error in exactly the
        // way this repo keeps naming: the beat would look finished and no
        // approver would ever have been asked.
        options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "ran" });
        return rpc(
          message.id,
          toolError(
            `"${wire}" passed /pre. This stand-in advertises the ${approvalsToolkit} toolkit so the ` +
              `agent can reach it, but it holds no APPROVALS_STORE_TOKEN, so it cannot record the ` +
              `request or route an approver. Tell the user the request could not be sent.`,
          ),
        );
      }

      // The tool itself. Two targets, one `/post` below: `tools/loan` is a
      // client of `apps/loan-app` with the persona's bearer, `tools/approvals`
      // is a client of the `/approvals` endpoints with the store token. Both
      // run only because `/pre` said OK, and both are asked about at `/post`.
      let payload: Record<string, unknown> | null;
      if (spec.target === "approvals") {
        const outcome = await spec.call!(inputs, actor).catch((cause: unknown) => ({
          ok: false as const,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
        if (!outcome.ok) {
          options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "ran" });
          return rpc(message.id, toolError(outcome.error));
        }
        payload = outcome.value as Record<string, unknown>;
      } else {
        const call = spec.run(inputs);
        const target = new URL(loanApp + call.path);
        for (const [key, value] of Object.entries(call.query ?? {})) target.searchParams.set(key, value);

        const ran = await fetch(target, {
          method: call.method,
          headers: {
            authorization: `Bearer ${tokenForActor(actor)}`,
            ...(call.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        }).catch((cause: unknown) => cause as Error);

        if (ran instanceof Error) {
          return rpc(message.id, toolError(`The loan origination system could not be reached: ${ran.message}`));
        }
        const body = (await ran.json().catch(() => null)) as { error?: string } | null;
        payload = body as Record<string, unknown> | null;
        if (!ran.ok) {
          options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "ran" });
          return rpc(
            message.id,
            toolError(body?.error ?? `the loan origination system answered ${ran.status}`),
          );
        }
      }

      // Layer 4. What the tool returned is not yet what the model gets: the
      // post-hook may hand back an `override.output`, and Arcade substitutes it
      // for the tool's own. So does this, because the whole claim of act 3 is
      // that the identifiers never enter the model's context, and a stand-in
      // that called `/post` and then forwarded the original payload anyway
      // would be the control that does nothing.
      const post = await fetch(`${hooks}/post`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.hookSigningSecret}` },
        body: JSON.stringify({
          execution_id: executionId,
          tool: { name, toolkit: calledToolkit, version: TOOL_VERSION },
          inputs,
          success: true,
          output: payload,
          context: { authorization: [{}], user_id: actor },
        }),
      }).catch((cause: unknown) => cause as Error);

      if (post instanceof Error) {
        // Unreachable control plane at `/post` is the same fail-closed question
        // as at `/pre`, and the answer has to be the same: the output does not
        // reach the model on the strength of a hook nobody could ask.
        options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "withheld" });
        return rpc(message.id, toolError(`the control plane at ${hooks} could not be reached: ${post.message}`));
      }
      const released = (await post.json().catch(() => ({}))) as {
        code?: string;
        error_message?: string;
        override?: { output?: unknown };
      };
      if (released.code !== "OK") {
        options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "withheld" });
        return rpc(
          message.id,
          toolError(DENIAL_PREFIX + (released.error_message ?? "output withheld by an extension policy")),
        );
      }

      const overridden = released.override !== undefined && "output" in released.override;
      options.onCall?.({ user_id: actor, tool: wire, inputs, outcome: "ran", redacted: overridden });
      return rpc(message.id, toolOk(overridden ? released.override?.output : payload));
    },
  });

  return {
    port: server.port as number,
    url: `http://localhost:${server.port}`,
    issueToken(email) {
      const token = `gw_${crypto.randomUUID()}`;
      actors.set(token, email.trim().toLowerCase());
      return token;
    },
    requireAuthorizationFor(wireName, authorizationUrl) {
      challenges.set(wireName, authorizationUrl);
    },
    stop: () => server.stop(true),
  };
}

/**
 * Layer 2's refusal, in the shape measured off the live gateway on 2026-09-12.
 *
 * JSON inside the text content, carrying `authorization_url` and
 * `llm_instructions`. It arrives as `isError: true`, which is the same envelope
 * a hook denial arrives in — so the chat has to tell them apart by *reading*
 * rather than by status, and `lib/agent/authorization.ts` is where that
 * happens. Reported as a hook denial it would put a refusal on screen that no
 * audit row backs.
 */
function authorizationChallenge(authorizationUrl: string): string {
  return JSON.stringify({
    authorization_url: authorizationUrl,
    llm_instructions:
      "Tell the user to click the link to authorize, then try again once they confirm they have done so. Do not retry before they confirm.",
  });
}

/**
 * Which port the runnable stand-in binds — from `ARCADE_API_URL`, and
 * deliberately **not** from `PORT`.
 *
 * `PORT` here belongs to `apps/web`. This script lives under `apps/web/scripts/`
 * and `bun run --cwd apps/web gateway-stand-in` loads `apps/web/.env.local` into
 * it: the right file for the wrong service. Measured while writing this —
 * in a worktree owning 4400-4409 the stand-in announced `:4400` and answered on
 * it, which is `apps/web`'s own port, so whichever process started second lost
 * and nothing was listening where anybody was calling.
 *
 * That is #56's bug exactly, and this is #56's fix:
 * `apps/loan-app/scripts/dev-idp.ts` reads the port out of `IDP_PUBLIC_HOST` —
 * the address the loan API already asks for — so the two agree by construction.
 * `ARCADE_API_URL` is the same kind of value here: it is where `apps/web` is
 * told to reach Arcade, so binding it leaves no second number to keep in step.
 *
 * Unset means `:0`: the OS picks, the boot line says what it got, and you paste
 * that into `ARCADE_API_URL`.
 */
export function resolveStandInPort(env: Record<string, string | undefined> = process.env): number {
  const configured = env.ARCADE_API_URL?.trim();
  if (!configured) return 0;

  // The scheme is checked rather than left to `new URL`, which reads
  // `localhost:4405` as the *scheme* `localhost:` with an empty port — a
  // perfectly wrong value that would otherwise be reported as "names no port"
  // and send somebody looking for a port that is right there.
  let parsed: URL | null = null;
  try {
    parsed = new URL(configured);
  } catch {
    parsed = null;
  }
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`ARCADE_API_URL=${configured} is not an http(s) URL — expected something like http://localhost:4405.`);
  }
  // A URL with no port is real Arcade on 443, not something this can stand in
  // for. Falling back to a default would bind a port nothing is calling and
  // look like it worked, which is the failure this function exists to end.
  if (parsed.port === "") {
    throw new Error(
      `ARCADE_API_URL=${configured} names no port, so there is nothing here for the stand-in to bind. ` +
        `It wants a local host:port, e.g. http://localhost:4405.`,
    );
  }
  return Number(parsed.port);
}

// ---------------------------------------------------------------------------
// Runnable
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const env = process.env;
  let port: number;
  try {
    port = resolveStandInPort(env);
  } catch (cause) {
    console.error(`[gateway-stand-in] ${cause instanceof Error ? cause.message : String(cause)}`);
    // 78 is sysexits' EX_CONFIG: the environment is wrong, not the invocation.
    // The same code `apps/loan-app/scripts/dev-idp.ts` exits with.
    process.exit(78);
  }

  const gatewayId = env.ARCADE_GATEWAY_ID?.trim() || "cg-demo-us";
  const hooksHost = env.HOOKS_PUBLIC_HOST?.trim() || "localhost:8081";
  // Both toolkits always — the agent has to be able to see
  // `Approvals_RequestApproval`, because the pre-hook's remediation sentence
  // names it (#89). The store token is what decides whether they *run*.
  const storeToken = env.APPROVALS_STORE_TOKEN?.trim() || "";
  const standIn = createGatewayStandIn({
    gatewayId,
    hooksHost,
    hookSigningSecret: env.ARCADE_HOOK_SIGNING_SECRET?.trim() || "cg-hooks-dev-secret-not-for-production",
    loanAppHost: env.LOAN_APP_PUBLIC_HOST?.trim() || "localhost:8082",
    loanToolkit: env.ARCADE_LOAN_TOOLKIT?.trim() || "Loan",
    // Advertised either way; runnable only with a store token.
    approvalsToolkit: env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
    ...(storeToken === ""
      ? {}
      : {
          approvalsStoreToken: storeToken,
          webPublicHost: env.PUBLIC_URL?.trim() || env.WEB_PUBLIC_HOST?.trim() || "localhost:3000",
        }),
    port,
    onCall: ({ user_id, tool, outcome }) => console.log(`[gateway-stand-in] ${outcome} ${tool} as ${user_id}`),
    onList: ({ user_id, advertised, hidden }) =>
      console.log(
        `[gateway-stand-in] tools/list as ${user_id}: ${advertised.length} advertised` +
          (hidden.length === 0 ? ", none hidden by /access" : `, hidden by /access: ${hidden.join(", ")}`),
      ),
  });

  // Said on every boot, because a fixture that looks like the product is how a
  // demo ends up being offered as evidence of the product.
  console.log(
    `[gateway-stand-in] listening on :${standIn.port} — this is a STAND-IN for the Arcade gateway, ` +
      `for local runs only. It is not the product and it is not in the deployed image.`,
  );
  console.log(`[gateway-stand-in] point apps/web at it with ARCADE_API_URL=http://localhost:${standIn.port}`);
  console.log(
    `[gateway-stand-in] every tools/call asks ${hooksHost}/pre first and runs nothing when the answer ` +
      `is not OK, then asks ${hooksHost}/post and forwards its override.output when there is one; ` +
      `every tools/list asks ${hooksHost}/access first and omits what comes back denied.`,
  );
  console.log(
    storeToken === ""
      ? `[gateway-stand-in] the approvals toolkit is advertised and governed but NOT run: ` +
          `APPROVALS_STORE_TOKEN is not set, so a call to it reaches /access and /pre and is then ` +
          `refused. Set it to run the approvals half offline.`
      : `[gateway-stand-in] the approvals toolkit is advertised and reaches ${hooksHost}/approvals. ` +
          `No Slack message is sent — there is no credential here — and RequestApproval says so in ` +
          `its own result rather than reporting a message id it did not get.`,
  );

  // A token per persona, printed, because offline there is no hop 1 to mint
  // one and no User Source to bind it. This is the whole reason this block
  // must never run anywhere but a laptop.
  for (const [key, value] of Object.entries(env)) {
    const match = /^PERSONA_([A-Z0-9_]+)_EMAIL$/.exec(key);
    if (match && value?.trim()) {
      console.log(`[gateway-stand-in] ${match[1]!.toLowerCase()}: ${standIn.issueToken(value.trim())}`);
    }
  }
}

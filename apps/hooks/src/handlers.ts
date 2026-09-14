/**
 * The three hooks, as functions from Arcade's payload to Arcade's response.
 *
 * Nothing here decides anything. Each handler resolves `context.user_id` to a
 * `Subject`, hands the pure `PolicyEngine` our own types, and translates the
 * `Decision` it gets back into the generated response type — plus the audit
 * rows describing what was decided. If an `if` about who may do what appears
 * in this file, it belongs in `@cg/governance-core` instead.
 *
 * Every handler is total: given a cache in the `failed` state, or a subject
 * the roster does not know, it still returns a well-formed response — the
 * denying one — and the rows recording why. The HTTP layer adds the last
 * fail-closed net for the cases where even a payload could not be parsed.
 *
 * Pure apart from `ctx.now` and `ctx.newId`, which are injected so tests can
 * pin them.
 */
import {
  consumeGrant,
  evaluatePermission,
  governedToolkits,
  redact,
  resolveVisibility,
  routeApproval,
  selectGrant,
  type GrantRejection,
  type ToolRef,
  type ValidatedGrant,
} from "@cg/governance-core";
import {
  qualify,
  type AccessHookRequest,
  type AccessHookResult,
  type Decision,
  type GovernanceEvent,
  type Grant,
  type Inputs,
  type PostHookRequest,
  type PostHookResult,
  type PreHookRequest,
  type PreHookResult,
  type RedactionRecord,
  type Subject,
  type ToolkitInfo,
  type Toolkits,
} from "@cg/policy-schema";

import {
  DECIDE,
  grantFrom,
  REQUEST_APPROVAL,
  whyUnusable,
  withResolvedApproval,
  type ApprovalControl,
} from "./approval-governance.ts";
import type { StoredApproval } from "./approvals-store.ts";
import { accessAuditRows, type DecidedTool } from "./access-audit.ts";
import { withCorrelation } from "./correlation.ts";
import { findSubject, type CacheState } from "./policy-cache.ts";

export interface HandlerContext {
  now: () => string;
  newId: () => string;
  /**
   * The approval flow's half of `/pre`: the approval a `Decide` call names,
   * and the grants an approval issues and a retry spends. Required rather than
   * optional — a server built without it would silently stop consulting
   * grants, and a control that quietly does nothing is the failure this repo
   * is organised against.
   */
  approvals: ApprovalControl;
  /**
   * The toolkits `/access` records one audit row per tool for (#107).
   *
   * The fallback for a policy that has not loaded — see `access-audit.ts`. It
   * is only consulted in that state; with a catalogue in hand the catalogue
   * wins, so a toolkit added on stage takes effect on the next poll.
   */
  configuredToolkits: ReadonlySet<string>;
}

/** What a handler produces: the wire response and the rows to append. */
export interface Outcome<R> {
  response: R;
  events: GovernanceEvent[];
}

/** Why a request is being failed closed, in the words the audit row carries. */
function failClosedReason(state: CacheState, what: string): string {
  switch (state.status) {
    case "failed":
      return `FAIL-CLOSED: the control plane could not load its policy (${state.error}), so ${what}.`;
    case "cold":
      return `FAIL-CLOSED: the control plane has not loaded its policy yet, so ${what}.`;
    case "ready":
      return `FAIL-CLOSED: ${what}.`;
  }
}

// ---------------------------------------------------------------------------
// /access
// ---------------------------------------------------------------------------

/**
 * Which of the tools Arcade is about to list may this user see.
 *
 * The response's `deny` map takes the *request's* `Toolkits` shape, down to the
 * innermost array of versions; spike #2 measured what any other shape does
 * (every tool in the project fails). So each denied tool's entry is the
 * request's own entry for it, copied across.
 *
 * One audit row per tool decided, allowed or hidden, governed or not — the
 * whole-project catalogue makes that thousands of rows per call, and that is
 * the cost of a table a reviewer can reconstruct every decision from. The
 * rows go in as one transaction (see `audit-log.ts`), and the bench shows the
 * cost: tens of milliseconds against a 5 s budget.
 */
export function handleAccess(
  request: AccessHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<AccessHookResult> {
  const ts = ctx.now();
  const deny: Toolkits = {};
  /**
   * Every decision this call made, in the order it made them. The rows are
   * built from it afterwards rather than inside the loop, because how many
   * rows a decision is worth is a question about the whole call — see
   * `access-audit.ts` and #107.
   */
  const decided: DecidedTool[] = [];

  const base = { ts, execution_id: "", hook: "access" as const, user_id: request.user_id };
  const subject = findSubject(state, request.user_id);

  for (const [toolkit, info] of Object.entries(request.toolkits)) {
    const versionsByTool = info.tools ?? {};
    const names = Object.keys(versionsByTool);
    if (names.length === 0) continue;

    const refs: ToolRef[] = names.map((name) => ({ toolkit, name }));
    const decisions: readonly { tool: ToolRef; decision: Decision }[] =
      state.status === "ready"
        ? resolveVisibility(subject, refs, state.policy)
        : refs.map((tool) => ({
            tool,
            decision: {
              effect: "deny",
              reason: failClosedReason(state, `${qualify(tool.toolkit, tool.name)} is hidden`),
              rule_id: null,
            },
          }));

    const hidden: NonNullable<ToolkitInfo["tools"]> = {};
    for (const { tool, decision } of decisions) {
      if (decision.effect === "deny") hidden[tool.name] = versionsByTool[tool.name] ?? [];
      decided.push({ tool, decision });
    }
    if (Object.keys(hidden).length > 0) deny[toolkit] = { tools: hidden };
  }

  // The response is built from the same decisions and is unchanged by #107:
  // Arcade is told exactly what it was told before, whatever the rows do.
  return {
    response: { deny },
    events: accessAuditRows(decided, {
      governed: governedFor(state, ctx),
      base,
      newId: ctx.newId,
      // With no policy loaded, every tool in the call — governed or not — was
      // refused because the control plane could not decide, so the summary row
      // says so in the same words the per-tool rows use. Otherwise the
      // summarised tools really were refused for being outside the catalogue,
      // and the module's own sentence is the accurate one.
      ...(state.status === "ready"
        ? {}
        : { summaryReason: (what: string) => failClosedReason(state, what) }),
    }),
  };
}

/**
 * Which toolkits get a row per tool.
 *
 * The loaded catalogue, which is a database table a presenter may edit live,
 * and only when there is none — cold, or a policy that will not compile — the
 * configured names. Two sources, in that order, because the fallback exists
 * for the state in which the first does not exist at all; they agree by
 * construction, since the catalogue is seeded from those same values.
 */
export function governedFor(state: CacheState, ctx: HandlerContext): ReadonlySet<string> {
  if (state.status !== "ready") return ctx.configuredToolkits;
  return governedToolkits(state.policy);
}

// ---------------------------------------------------------------------------
// /pre
// ---------------------------------------------------------------------------

/**
 * May this user make this call with these inputs.
 *
 * A denial's `error_message` is the engine's `reason` — the remediation
 * instruction the rule author wrote, already rendered with the call's values —
 * with the audit row's id appended as the correlation token (#6). The model
 * reads that string and nothing else.
 *
 * The audit row's `reason` is allowed to say *more* than the model is told,
 * and does: which grants were examined and rejected, who a request was routed
 * to, which grant an approval issued. Those are facts a compliance reviewer
 * and the control-plane panel need and the model has no business acting on, so
 * they never reach `error_message`.
 */
export function handlePre(
  request: PreHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<PreHookResult> {
  const id = ctx.newId();
  const tool = { toolkit: request.tool.toolkit, name: request.tool.name };
  const qualified = qualify(tool.toolkit, tool.name);
  const userId = request.context.user_id ?? "";

  // What the model is told when the policy itself is unavailable. The audit
  // row carries the full error; the model gets one sentence and the reference,
  // because a compiler's problem list is for the administrator, not the agent.
  const unavailable =
    `DENIED: the control plane cannot evaluate ${qualified} because its policy is ` +
    `unavailable. Do not retry ${qualified}; report the reference to an administrator.`;

  const { decision, auditReason } =
    state.status === "ready"
      ? decidePre(request, tool, state, ctx)
      : {
          decision: {
            effect: "deny" as const,
            reason: failClosedReason(state, `${qualified} cannot be evaluated`),
            rule_id: null,
          },
          auditReason: failClosedReason(state, `${qualified} cannot be evaluated`),
        };

  const event: GovernanceEvent = {
    id,
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "pre",
    user_id: userId,
    tool: qualified,
    decision: decision.effect,
    reason: auditReason,
    rule_id: decision.rule_id,
  };

  const response: PreHookResult =
    decision.effect === "allow"
      ? { code: "OK" }
      : {
          code: "CHECK_FAILED",
          error_message: withCorrelation(state.status === "ready" ? decision.reason : unavailable, id),
        };

  return { response, events: [event] };
}

/** A `/pre` decision, plus the fuller account the audit row carries. */
interface PreDecision {
  decision: Decision;
  auditReason: string;
}

type ReadyState = Extract<CacheState, { status: "ready" }>;

/**
 * The `/pre` decision when the policy is loaded: resolve, evaluate, and — only
 * then — write.
 *
 * The order is the point. Nothing is written before the engine has allowed the
 * call, so there is no path on which a grant exists for a decision that was
 * refused; and the grant a decision issues is built from the approval record,
 * never from the arguments of the call that triggered it.
 */
function decidePre(
  request: PreHookRequest,
  tool: ToolRef,
  state: ReadyState,
  ctx: HandlerContext,
): PreDecision {
  const control = ctx.approvals;
  const subject = findSubject(state, request.context.user_id);
  const clickerId = subject?.user_id ?? request.context.user_id ?? "";
  const inApprovals = tool.toolkit === control.toolkit;

  // A `Decide` call names an approval by an opaque id and nothing else; the
  // three facts the decision turns on live in `governance.db`. Resolving them
  // here is what lets `pre.decide-*` be policy rows rather than code.
  const stored: StoredApproval | null =
    inApprovals && tool.name === DECIDE ? resolveApproval(request.inputs, control) : null;
  const inputs: Inputs =
    inApprovals && tool.name === DECIDE
      ? withResolvedApproval(request.inputs, stored, clickerId)
      : request.inputs;

  // Grants this subject holds for this exact call, in two steps.
  //
  // First: is the row even eligible to be asked about? A grant is minted
  // `pending` by an approving `/pre` and is turned on only by the transaction
  // that records the winning decision as `approved`, so a grant whose request
  // was denied — or whose decision nobody has recorded yet — never reaches the
  // checker at all. That is what stops an approval that lost a race from
  // lifting the denial that won it.
  //
  // Then: does an eligible grant authorise *this* call? That is
  // `GrantChecker`'s question, judged against these inputs — a grant validated
  // in the abstract and then applied to another resource is the replay it
  // exists to stop.
  const held = subject === null ? [] : control.store.grantsFor(subject.user_id, tool);
  const eligible: Grant[] = [];
  const ineligible: string[] = [];
  for (const stored of held) {
    const problem = whyUnusable(stored);
    if (problem === null) eligible.push(stored.grant);
    else ineligible.push(`Grant ${stored.grant.id} was not considered: ${problem}.`);
  }

  const selection =
    subject === null
      ? { grant: null as ValidatedGrant | null, rejected: [] as readonly GrantRejection[] }
      : selectGrant({
          grants: eligible,
          subject,
          tool,
          inputs,
          now: new Date(ctx.now()),
        });

  const evaluate = (grants: readonly ValidatedGrant[]): Decision =>
    evaluatePermission({ subject, tool, inputs, policy: state.policy, grants });

  // Evaluated twice, and cheaply: the engine is pure. The second answer is
  // what says whether the grant was *decisive*, which is the only condition
  // under which a use is spent. A call policy would have allowed anyway must
  // not burn the one use an approval bought.
  const withoutGrant = evaluate([]);
  const decision = selection.grant === null ? withoutGrant : evaluate([selection.grant]);
  const decisive =
    selection.grant !== null && decision.effect === "allow" && withoutGrant.effect === "deny";

  const notes: string[] = [];
  if (decisive && selection.grant !== null) {
    const spent = consumeGrant(selection.grant);
    control.store.consume(spent);
    notes.push(
      `Consumed grant ${spent.id}, issued against approval request ${spent.request_id} ` +
        `(${spent.uses_remaining ?? "unlimited"} use(s) left, expires ${spent.expires_at}).`,
    );
  }
  for (const rejection of selection.rejected) {
    notes.push(`Grant ${rejection.grant_id} did not apply: ${rejection.message}`);
  }
  notes.push(...ineligible);

  if (decision.effect === "allow" && inApprovals && tool.name === DECIDE && stored !== null) {
    notes.unshift(...settleDecision(stored, subject, inputs, control, ctx));
  }
  if (decision.effect === "allow" && inApprovals && tool.name === REQUEST_APPROVAL) {
    notes.unshift(narrateRouting(request.inputs, subject, state));
  }

  const auditReason = [decision.reason, ...notes].filter((line) => line.length > 0).join(" ");
  return { decision, auditReason };
}

/** The stored approval a `Decide` call names, or `null` for anything else. */
function resolveApproval(inputs: Inputs, control: ApprovalControl): StoredApproval | null {
  const requestId = inputs["request_id"];
  return typeof requestId === "string" ? control.store.approval(requestId) : null;
}

/**
 * Issue the grant an approved decision buys — the one write in this service
 * that produces authority, and it happens only downstream of an allow.
 *
 * A denial issues nothing: the point of a denial is that the retry stays
 * blocked. The unique index over `request_id` is what stops a `Decide`
 * replayed before the store has flipped the request to `approved` from minting
 * a second grant for the same approval.
 */
function settleDecision(
  stored: StoredApproval,
  subject: Subject | null,
  inputs: Inputs,
  control: ApprovalControl,
  ctx: HandlerContext,
): string[] {
  const decidedBy = subject?.user_id ?? "";
  const outcome = inputs["decision"];
  const record = stored.record;
  const headline =
    `${decidedBy} decides ${record.id} (${record.action} on ${record.resource_id} for ` +
    `${record.amount}) as "${String(outcome)}".`;

  if (outcome !== "approved") return [`${headline} No grant is issued by a denial.`];

  const grant = grantFrom(stored, decidedBy, control, new Date(ctx.now()));
  const inserted = control.store.issueGrant(grant, "approved");
  if (inserted === "duplicate_request") {
    return [`${headline} A grant for this approval already exists; no second one was issued.`];
  }
  const ceiling =
    grant.ceiling === null
      ? "no numeric ceiling"
      : `${grant.ceiling.input} at most ${grant.ceiling.max}`;
  return [
    `${headline} Grant ${grant.id} minted PENDING for ${grant.subject_id} on ` +
      `${qualify(grant.match.toolkit, grant.match.tool)} for ${String(grant.resource_id)}, ` +
      `${ceiling}, ${String(grant.uses_remaining)} use, expiring ${grant.expires_at}. ` +
      `It authorises nothing until the transaction that records this approval activates it, ` +
      `and a recorded denial voids it instead.`,
  ];
}

/**
 * Who this escalation will reach, worked out by the control plane rather than
 * read back from the tool.
 *
 * `routeApproval` is the same deterministic rule `tools/approvals` runs (both
 * checked against `approver-routing-cases.json`), so saying it here costs one
 * pure call and gives the panel the routing beat — including who was
 * *deliberately not* asked, which is the part the demo is about.
 */
function narrateRouting(inputs: Inputs, subject: Subject | null, state: ReadyState): string {
  const amount = inputs["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || subject === null) {
    return "";
  }
  const roster = [...state.subjects.values()];
  const routed = routeApproval(amount, subject.user_id, roster);
  if (routed.outcome === "no_eligible_approver") {
    return `Nobody on the roster holds authority for ${amount}, so this escalation has no approver.`;
  }
  const notAsked = routed.candidates.slice(1).map((s) => `${s.display_name} (${s.clearance})`);
  return (
    `Routing ${amount} from ${subject.display_name} to ${routed.approver.display_name} ` +
    `(clearance ${routed.approver.clearance}), the lowest sufficient approver` +
    (notAsked.length > 0 ? `; also sufficient and not asked: ${notAsked.join(", ")}.` : ".")
  );
}

// ---------------------------------------------------------------------------
// /post
// ---------------------------------------------------------------------------

/**
 * What the model is allowed to read of what came back (#16).
 *
 * The other three control points decide whether a call happens; this one runs
 * after it has, over a payload that is already on its way into the model's
 * context. `RedactionEngine` (#8) is pure and does the deciding: named field
 * paths, and regular expressions over free text. Nothing here inspects a value.
 *
 * Three outcomes:
 *
 * - **Nothing applied.** `OK` with no override, and an `allow` row. The
 *   payload is the very object that arrived — the engine returns the same
 *   reference — so the panel's post lane says "read, nothing removed" rather
 *   than staying blank.
 * - **Something was removed.** `OK` with `override.output`, and a `modify` row
 *   carrying `redactions[]`. Arcade substitutes the override for the tool's
 *   output, so the model sees only what came back from here.
 * - **No policy to decide against.** Cold or failed cache: `CHECK_FAILED`, the
 *   output withheld, a `deny` row. A pass-through is only correct when the
 *   control plane can vouch for it.
 *
 * **The event carries no payload, on purpose** (driver decision on #16, option
 * A). `audit_log` is persisted and `GET /events` is unauthenticated, so a
 * `before` holding the raw output would write the borrower's account number to
 * disk and broadcast it; an `after` is no safer, because a rule conditioned on
 * clearance does not fire for a privileged subject and *their* "after" still
 * holds the identifiers. What is recorded is `redactions[]`: path, `rule_id`,
 * `pattern_id`, kind. Where and why, never what.
 *
 * `rule_id` on the row names the rule when exactly one fired, and is `null`
 * when several did — the per-redaction ids are on `redactions[]`, and picking
 * one of several for the summary column would attribute the others to it.
 */
export function handlePost(
  request: PostHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<PostHookResult> {
  const id = ctx.newId();
  const tool = { toolkit: request.tool.toolkit, name: request.tool.name };
  const qualified = qualify(tool.toolkit, tool.name);

  if (state.status !== "ready") {
    const reason = failClosedReason(state, `the output of ${qualified} cannot be released`);
    return {
      response: {
        code: "CHECK_FAILED",
        error_message: withCorrelation(
          `DENIED: the control plane cannot release the output of ${qualified} because its ` +
            `policy is unavailable. Do not retry ${qualified}; report the reference to an administrator.`,
          id,
        ),
      },
      events: [
        {
          id,
          ts: ctx.now(),
          execution_id: request.execution_id,
          hook: "post",
          user_id: request.context.user_id ?? "",
          tool: qualified,
          decision: "deny",
          reason,
          rule_id: null,
        },
      ],
    };
  }

  const subject = findSubject(state, request.context.user_id);
  const { output, redactions } = redact({
    output: request.output,
    subject,
    tool,
    policy: state.outputPolicy,
  });

  const event: GovernanceEvent = {
    id,
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "post",
    user_id: request.context.user_id ?? "",
    tool: qualified,
    decision: redactions.length === 0 ? "allow" : "modify",
    reason: describeRedactions(redactions, state),
    rule_id: soleRule(redactions),
    ...(redactions.length === 0 ? {} : { redactions: [...redactions] }),
  };

  return {
    response: redactions.length === 0 ? { code: "OK" } : { code: "OK", override: { output } },
    events: [event],
  };
}

/**
 * The audit row's account of a `/post` decision, grouped by the rule that made
 * it — which is also the line a presenter reads off the panel.
 *
 * Each rule appears once, named by id, followed by the sentence its author
 * wrote and the paths it acted on. Two rules commonly fire on one `Loan.GetLoan`
 * (act 3's fields and act 4's sweep) and the audience has to be able to tell
 * which did what, so neither is folded into the other.
 *
 * Written from the records and the rules that produced them, so it names paths
 * and rule ids and cannot accidentally quote a value: nothing in scope here
 * holds one. An `unsettled` record is called out by name — it means the output
 * policy is rewriting its own output and the value was withheld rather than
 * redacted, which is a defect to fix and not a secret that was found.
 */
function describeRedactions(
  redactions: readonly RedactionRecord[],
  state: ReadyState,
): string {
  if (redactions.length === 0) {
    return "Output released unchanged: no output rule applied to this call.";
  }

  const byRule = new Map<string, RedactionRecord[]>();
  for (const record of redactions) {
    const key = record.rule_id ?? "";
    const group = byRule.get(key);
    if (group === undefined) byRule.set(key, [record]);
    else group.push(record);
  }

  const sentences = [...byRule].map(([ruleId, records]) => {
    const name = ruleId === "" ? "the engine itself" : ruleId;
    const reason = ruleId === "" ? "" : ` ${state.outputRules.get(ruleId)?.reason ?? ""}`;
    const what = records
      .map(
        (record) =>
          `${record.kind} ${record.path}` +
          (record.pattern_id === null ? "" : ` via ${record.pattern_id}`),
      )
      .join(", ");
    return `${name}:${reason} (${what}).`;
  });

  const withheld = redactions.filter((record) => record.kind === "unsettled").length;
  return (
    `Output rewritten before it reached the model; ${redactions.length} redaction(s) by ` +
    `${byRule.size} rule(s). ${sentences.join(" ")}` +
    (withheld > 0
      ? ` ${withheld} value(s) were withheld rather than redacted because the output policy did not settle.`
      : "")
  );
}

/** The one rule that fired, or `null` when none or several did. */
function soleRule(redactions: readonly RedactionRecord[]): string | null {
  const ids = new Set(redactions.map((record) => record.rule_id));
  const [only] = [...ids];
  return ids.size === 1 && only !== undefined ? only : null;
}

/**
 * The governance vocabulary. Hand-written, because it is ours.
 *
 * Everything here is domain-agnostic on purpose: it talks about subjects,
 * tools, inputs, outputs and clearances, never about what the governed system
 * happens to do. Forking this template means replacing the governed app and
 * its seed data and touching nothing under `packages/` — a type in this file that
 * named the demo's business domain would break that promise, so `#24` greps for
 * it. Anything scenario-specific belongs in the app, not here.
 *
 * Nullable rather than optional, nearly everywhere. These records round-trip
 * through `bun:sqlite` and across SSE, and `undefined` does not survive
 * `JSON.stringify` — an absent key and a key set to `undefined` serialise
 * identically, so a field that is *meaningfully* empty says so with `null`.
 *
 * Every object here is `.strict()` — the opposite of the generated hook
 * contract next door, and for the opposite reason. Those payloads are Arcade's
 * and may grow; these are ours and may not. Zod 3 strips unknown keys by
 * default, so a misspelled field in a policy row would parse cleanly and
 * evaluate as though it had never been written: a rule narrower than intended
 * becomes a blanket rule, and a constraint someone thought they had applied is
 * simply absent. That is a silent fail-open in the policy table of a demo whose
 * whole thesis is that controls must not fail silently. Strict makes it a parse
 * error at seed time instead.
 *
 * `Timestamp` is `z.string().datetime()`, which accepts only `Z`-suffixed UTC
 * instants: `2026-01-01T00:00:00.000Z`. It rejects a `+00:00` offset and it
 * rejects SQLite's own `datetime('now')` format. Anything writing these rows
 * must stamp them with `new Date().toISOString()` and never let SQLite supply
 * the value, or every row fails on the way back out.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Which of Arcade's three control points a rule or event belongs to. */
export const HookPoint = z.enum(["access", "pre", "post"]);
export type HookPoint = z.infer<typeof HookPoint>;

/** What a decision does. `modify` means the payload was rewritten, not blocked. */
export const Effect = z.enum(["allow", "deny", "modify"]);
export type Effect = z.infer<typeof Effect>;

/** ISO 8601 instant, UTC. Every timestamp in this package is this. */
export const Timestamp = z.string().datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** A tool input map, exactly as it arrives on a hook payload. */
export const Inputs = z.record(z.unknown());
export type Inputs = z.infer<typeof Inputs>;

/**
 * Matches a tool by `toolkit` and `name`, the only two fields a hook payload
 * carries. `"*"` matches any value for that segment.
 *
 * Spike 02 is the reason there is no `operations` or `service_domains` here:
 * `tool.metadata` is never populated on hook payloads — not for remote MCP
 * tools and not for hosted toolkits either — so a rule keyed on tool behaviour
 * matches nothing, which is indistinguishable from a rule that permits.
 * Classification lives in our own rules, keyed on the name.
 */
export const ToolMatcher = z
  .object({
    toolkit: z.string().min(1),
    tool: z.string().min(1),
  })
  .strict();
export type ToolMatcher = z.infer<typeof ToolMatcher>;

// ---------------------------------------------------------------------------
// Subject — who a decision is about
// ---------------------------------------------------------------------------

/**
 * The identity a decision is made about, as the control plane knows it.
 *
 * `user_id` is whatever Arcade puts in `context.user_id` — for this demo a real
 * email address, so OAuth actually works. `clearance` is a unit-free numeric
 * ceiling: the routing and limit rules compare numbers and never learn what
 * the number counts.
 */
export const Subject = z
  .object({
    user_id: z.string().min(1),
    display_name: z.string(),
    /** Opaque role key. Policy rules match on it; nothing interprets it. */
    role: z.string().min(1),
    /**
     * Upper bound on the numeric inputs this subject may pass, compared by the
     * `exceeds_clearance` condition. `0` means "no numeric authority at all".
     */
    clearance: z.number().nonnegative(),
    /** Extension point for forkers: any additional attributes rules can match on. */
    attributes: z.record(z.unknown()).default({}),
  })
  .strict();
export type Subject = z.infer<typeof Subject>;

/**
 * Which subjects a rule applies to. Every field is a narrowing filter, `null`
 * means "do not narrow on this", and a matcher that narrows on nothing matches
 * everyone — so a rule with no `subjects` is a blanket rule, which is the
 * common case.
 *
 * The two clearance bounds are what let a redaction rule apply to junior
 * subjects and not to senior ones (#8: "rules can be conditioned on the
 * subject's role or clearance") without the rule knowing what clearance
 * measures. Both bounds together express a band.
 *
 * `.strict()`, and this is the important part. An unrecognised key here — a
 * typo, or a predicate someone assumed existed — would otherwise be stripped
 * silently, leaving `{ user_ids: null, roles: null, ... }`: a matcher that
 * narrows on nothing and therefore applies to everyone. A rule intended for
 * one role would quietly govern the whole roster. Strict turns that into a
 * parse error at seed time.
 */
export const SubjectMatcher = z
  .object({
    user_ids: z.array(z.string()).nullable().default(null),
    roles: z.array(z.string()).nullable().default(null),
    /** Applies only to subjects whose clearance is strictly below this. */
    clearance_below: z.number().nullable().default(null),
    /** Applies only to subjects whose clearance is greater than or equal to this. */
    clearance_at_least: z.number().nullable().default(null),
  })
  .strict();
export type SubjectMatcher = z.infer<typeof SubjectMatcher>;

// ---------------------------------------------------------------------------
// Conditions — the parameter-aware part
// ---------------------------------------------------------------------------

/**
 * How a condition compares. `exceeds_clearance` is the only operator that
 * reads the subject rather than the rule: it is true when the numeric value at
 * `input` is greater than `Subject.clearance`, which is how an authority limit
 * gets expressed without the policy table knowing anyone's number.
 */
export const ConditionOperator = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "matches",
  "exists",
  "exceeds_clearance",
]);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

/**
 * One predicate over a tool's inputs.
 *
 * `input` is a dot path into the input map, so nested arguments are reachable
 * (`applicant.id`). `value` is unused by `exists` and `exceeds_clearance`; for
 * `in`/`nin` it is an array, and for `matches` a regular-expression source
 * string. Evaluation is #7's job — this type only says what can be written
 * down, and #7 owns rejecting the combinations that make no sense.
 */
export const Condition = z
  .object({
    input: z.string().min(1),
    operator: ConditionOperator,
    value: z.unknown().nullable().default(null),
  })
  .strict();
export type Condition = z.infer<typeof Condition>;

// ---------------------------------------------------------------------------
// PolicyRule — access and pre-execution
// ---------------------------------------------------------------------------

/**
 * One row of the policy table, evaluated at `/access` or `/pre`.
 *
 * `reason` is load-bearing rather than cosmetic. Over MCP a denial reaches the
 * model as `"Tool execution was denied by an extension policy: " + reason` and
 * nothing else (spike 02), so this string *is* the remediation instruction the
 * agent acts on. The hook writes it; the system prompt does not.
 *
 * Rules are ordered by ascending `priority`, first match wins. Ties are
 * resolved by `id` so evaluation is deterministic whatever order the database
 * returns rows in.
 */
export const PolicyRule = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    /** `access` hides the tool during discovery; `pre` blocks the call. */
    hook: z.enum(["access", "pre"]),
    match: ToolMatcher,
    subjects: SubjectMatcher.nullable().default(null),
    /** All conditions must hold for the rule to fire. Empty means "always". */
    conditions: z.array(Condition).default([]),
    effect: Effect,
    reason: z.string(),
    priority: z.number().int(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRule>;

// ---------------------------------------------------------------------------
// OutputRule — post-execution
// ---------------------------------------------------------------------------

/**
 * What to do with matched content. The three differ in **how much** they
 * substitute, which is what makes them three strategies rather than two
 * spellings of one — a strategy that behaved identically to another would be
 * a control that silently does nothing.
 *
 * | strategy | pattern match | field path |
 * |---|---|---|
 * | `mask` | the matched substring becomes `replacement`; the text around it survives | the value becomes `replacement` |
 * | `replace` | the whole string holding the match becomes `replacement` | the value becomes `replacement` |
 * | `remove` | the matched substring is deleted and the text closes up | the key is deleted from its parent |
 *
 * For a field path `mask` and `replace` necessarily coincide: the match *is*
 * the whole value, so there is nothing around it to preserve. The distinction
 * only pays off on a pattern sweep, and that is exactly where it is needed —
 * a free-text field commonly holds legitimate content *and* something that
 * must not reach the model, and `mask` keeps the first while `replace` throws
 * the field away wholesale because none of it is trusted.
 *
 * Nothing here is format-preserving. A mask that revealed the length or the
 * shape of what it covered would teach the model what was taken, which is the
 * thing the post-execution hook exists to prevent.
 */
export const RedactionStrategy = z.enum(["mask", "remove", "replace"]);
export type RedactionStrategy = z.infer<typeof RedactionStrategy>;

/**
 * What a `RedactionRecord` says happened. Every `RedactionStrategy`, plus one
 * outcome no rule can ask for.
 *
 * `unsettled` is the post-hook's fail-closed state. Redaction runs the applicable
 * patterns over a string until it stops changing; if it has not settled within
 * the engine's bound, the patterns are rewriting each other's output and there is
 * no answer to give. The engine then withholds the whole value rather than
 * handing over whichever revision the loop happened to stop on — withholding
 * more is the fail-closed direction at `/post`, where the question is what the
 * model may read.
 *
 * It is a separate kind rather than a `mask` so the panel and the audit log can
 * say *why* the value is gone: an `unsettled` row is a defect in the output
 * policy, not a secret that was found.
 */
export const RedactionKind = z.enum([...RedactionStrategy.options, "unsettled"]);
export type RedactionKind = z.infer<typeof RedactionKind>;

/** Redact a known field, addressed by dot path into the tool's output. */
export const FieldRedaction = z
  .object({
    path: z.string().min(1),
    strategy: RedactionStrategy,
    /** Used by `mask` and `replace`; ignored by `remove`. */
    replacement: z.string().default("[REDACTED]"),
  })
  .strict();
export type FieldRedaction = z.infer<typeof FieldRedaction>;

/**
 * Redact by pattern, for content whose shape is known but whose location is
 * not — free text a tool returns, including text that arrived from somewhere
 * untrusted and is trying to address the model.
 */
export const PatternRedaction = z
  .object({
    id: z.string().min(1),
    /** Regular-expression source. Stored as a string so the policy table is data. */
    regex: z.string().min(1),
    /** Regex flags. `g` is implied by the engine; declare only the rest. */
    flags: z.string().default("i"),
    strategy: RedactionStrategy,
    replacement: z.string().default("[REDACTED]"),
  })
  .strict();
export type PatternRedaction = z.infer<typeof PatternRedaction>;

/**
 * One row of the output-policy table, evaluated at `/post`.
 *
 * Two mechanisms in one type because they are two answers to the same
 * question — what must not reach the model — and a single rule commonly wants
 * both: pull the fields you can name, then sweep what is left for the shapes
 * you can recognise.
 */
export const OutputRule = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    match: ToolMatcher,
    subjects: SubjectMatcher.nullable().default(null),
    fields: z.array(FieldRedaction).default([]),
    patterns: z.array(PatternRedaction).default([]),
    /** Recorded on the resulting event, and shown on the control-plane panel. */
    reason: z.string(),
    priority: z.number().int(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type OutputRule = z.infer<typeof OutputRule>;

/**
 * One thing that was taken out of a tool's output — the unit `redactions[]` is
 * made of, and the only thing the control-plane panel has to draw a `modify`
 * from (#21, #101).
 *
 * **It names where and why, never what.** There is deliberately no field for
 * the removed value, because this record is written to the audit log and drawn
 * on a projector: a shape that *could* carry an account number eventually
 * would, and the redaction would have leaked the thing it removed into the two
 * places most likely to be read aloud.
 *
 * `path` is canonical JSONPath into the tool's output — `$.bank_holder`,
 * `$.history[0].note`, `$` for the whole payload — so a reader can point at the
 * field without the value being present. `kind` is the strategy that fired, and
 * `pattern_id` names the individual scanner on a pattern sweep, or is `null`
 * when a named field path did the work. Which mechanism found it is therefore
 * readable off the record rather than guessed at.
 */
export const RedactionRecord = z
  .object({
    /** Canonical JSONPath to what was redacted. Never accompanied by its value. */
    path: z.string().min(1),
    /**
     * The `OutputRule` that fired, or `null` when the engine itself withheld the
     * value rather than a rule — the same convention `Decision.rule_id` and
     * `GovernanceEvent.rule_id` use for an engine-authored outcome.
     */
    rule_id: z.string().min(1).nullable().default(null),
    /** The `PatternRedaction` that matched, or `null` for a field-path redaction. */
    pattern_id: z.string().nullable().default(null),
    kind: RedactionKind,
  })
  .strict();
export type RedactionRecord = z.infer<typeof RedactionRecord>;

// ---------------------------------------------------------------------------
// Decision — what every hook returns
// ---------------------------------------------------------------------------

/**
 * The outcome of evaluating one hook. This is the internal shape; translating
 * it into a `PreHookResult` / `PostHookResult` / `AccessHookResult` is the hook
 * handler's job (#12).
 *
 * `override` carries the rewritten payload when `effect` is `modify` — inputs
 * at `/pre`, output at `/post` — and is absent otherwise. It is `unknown`
 * because what gets rewritten differs per hook point, and narrowing it here
 * would push a discriminated union into every consumer that only wants to log
 * the effect.
 */
export const Decision = z
  .object({
    effect: Effect,
    reason: z.string(),
    /** The rule that decided, or `null` for a default (no rule matched, or fail-closed). */
    rule_id: z.string().nullable(),
    override: z.unknown().optional(),
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------------------
// Approvals and grants
// ---------------------------------------------------------------------------

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/**
 * A blocked call, escalated to a human.
 *
 * `approver_id` is chosen deterministically from `candidate_approver_ids` —
 * minimum sufficient clearance, requester excluded (#9). The model does not
 * pick, and the candidate list is recorded so the panel can show *who was not*
 * bothered, which is the point being demonstrated.
 *
 * `required_clearance` is the numeric bar the approver had to clear, in the
 * same unit-free scale as `Subject.clearance`.
 */
export const ApprovalRequest = z
  .object({
    id: z.string().min(1),
    requester_id: z.string().min(1),
    approver_id: z.string().nullable(),
    candidate_approver_ids: z.array(z.string()).default([]),
    /** The call being escalated. */
    match: ToolMatcher,
    /** Opaque identifier of the thing being acted on, if the action names one. */
    resource_id: z.string().nullable(),
    /** The inputs as submitted. A grant is issued against exactly these. */
    inputs: Inputs,
    justification: z.string(),
    required_clearance: z.number().nonnegative().nullable(),
    status: ApprovalStatus,
    /** The approver's note, once they have decided. */
    note: z.string().nullable().default(null),
    /** Correlates back to the `/pre` payload that triggered the escalation. */
    execution_id: z.string().nullable().default(null),
    created_at: Timestamp,
    decided_at: Timestamp.nullable().default(null),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * The **wire record** the approvals store returns — one shape from all three
 * record-returning endpoints of the contract in `tools/approvals/README.md`.
 *
 * Distinct from `ApprovalRequest` above, and deliberately so. That type is the
 * control plane's internal view: a `ToolMatcher` and the raw `inputs` a grant
 * is pinned against. This one is what crosses the wire to the Python toolkit
 * that writes it and the approval page that renders it, and it is sized to
 * what that page must show from an opaque id alone — display names resolved,
 * the rule already named, no join left for the reader to make.
 *
 * There is deliberately **no `decision` field**: once decided, `status` *is*
 * the decision. Two fields carrying one fact are two fields that can disagree,
 * and a page rendering "approved" beside a status of `denied` would be worse
 * than one rendering nothing.
 */
export const ApprovalRecord = z
  .object({
    /** Opaque. Minted by the store, never by a caller. */
    id: z.string().min(1),
    /** Email. The `context.user_id` of whoever was refused. */
    requester_id: z.string().min(1),
    /** From the roster, so the page need not join. */
    requester_display_name: z.string(),
    /** Email of the one person routing chose. */
    approver_id: z.string().min(1),
    approver_display_name: z.string(),
    /** Everyone sufficient, lowest clearance first. `[0]` is the approver. */
    candidate_approver_ids: z.array(z.string()).default([]),
    /** The refused action as a bare name, e.g. `approve_loan`. */
    action: z.string().min(1),
    resource_id: z.string().min(1),
    amount: z.number(),
    /** The bar a candidate had to clear: the amount. */
    required_clearance: z.number().nonnegative(),
    /**
     * The policy rule the blocked call tripped, when the control plane can
     * name it. `null` when it cannot — the page and the DM both still state
     * the authority that was exceeded.
     */
    rule: z
      .object({ id: z.string().min(1), description: z.string() })
      .strict()
      .nullable()
      .default(null),
    /** The requester's own words, rendered verbatim. */
    justification: z.string(),
    status: ApprovalStatus,
    created_at: Timestamp,
    decided_at: Timestamp.nullable().default(null),
    /** Email of whoever decided. `null` while pending. */
    decided_by: z.string().nullable().default(null),
    note: z.string().nullable().default(null),
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

/**
 * A narrow, expiring permission produced by an approval — the thing the pre-hook
 * looks for on the retry.
 *
 * Deliberately not a role change. It is scoped to one tool and one resource,
 * pinned to the inputs that were approved, bounded above on the one input that
 * carries a numeric bound, limited in uses and time-boxed — so replaying it
 * against a larger value, a different resource, or next week all fail. `granted_by` is stored rather than
 * derived because separation of duties (#10) is checked against it: a grant
 * whose `granted_by` equals its `subject_id` is invalid no matter what the
 * approval record says.
 */
export const Grant = z
  .object({
    id: z.string().min(1),
    /** Who the grant empowers. */
    subject_id: z.string().min(1),
    /** Who approved it. Must differ from `subject_id`. */
    granted_by: z.string().min(1),
    /** The approval this grant came from. */
    request_id: z.string().min(1),
    match: ToolMatcher,
    resource_id: z.string().nullable(),
    /**
     * Inputs the retry must present *exactly*. Anything not named here is
     * unconstrained except by `ceiling`, and the input `ceiling` names is not
     * matched here — a ceiling is an upper bound, not an equality.
     */
    pinned_inputs: Inputs,
    /**
     * The numeric ceiling this grant authorises, if it authorises one.
     *
     * #10 has to reject a replay at a higher value while accepting a retry at or
     * below the approved one, so an exact-match input map cannot express it:
     * `{ input: "quantity", max: 95 }` means the named input must be present, be
     * a number, and be no greater than 95. Which input carries the bound is data,
     * so nothing here learns what the number counts.
     *
     * `null` for a grant with no numeric dimension at all.
     */
    ceiling: z
      .object({ input: z.string().min(1), max: z.number() })
      .strict()
      .nullable()
      .default(null),
    issued_at: Timestamp,
    expires_at: Timestamp,
    /** `null` means unlimited within the expiry window. */
    uses_remaining: z.number().int().nonnegative().nullable().default(1),
    revoked_at: Timestamp.nullable().default(null),
  })
  .strict();
export type Grant = z.infer<typeof Grant>;

/**
 * Why a grant did not authorise a call.
 *
 * A boolean would be cheaper and useless. The audit log has to *explain* an
 * outcome to a compliance reviewer (PRD stories 19–22) — "the grant was for
 * WID-1 and the call named WID-9" is the explanation; "invalid" is not —
 * and the control-plane panel renders the same records. So every rejection
 * carries the values that produced it, and this is a discriminated union
 * rather than a string so both consumers can branch on `kind` and neither has
 * to parse prose.
 *
 * The grouping, which is also `GrantChecker`'s (#10) order of checks:
 *
 * - `unenforceable` — the grant itself is malformed or self-contradictory, so
 *   it constrains nothing. A grant that constrains nothing is worse than no
 *   grant: it is indistinguishable from a grant that permits.
 * - **who** — `self_approved`, `subject_mismatch`
 * - **when** — `revoked`, `not_yet_valid`, `expired`
 * - **how many** — `consumed`
 * - **what** — `tool_mismatch`, `resource_mismatch`, `pinned_input_mismatch`
 * - **how much** — `ceiling_exceeded`, `ceiling_input_missing`,
 *   `ceiling_input_not_numeric`
 *
 * `checked_at` is on the time-based arms because the reviewer's first question
 * about an expiry is always "expired relative to what". It is the `now` the
 * checker was handed, never a clock it read.
 */
export const GrantRejectionReason = z.discriminatedUnion("kind", [
  /** `problem` is one sentence naming the contradiction. */
  z.object({ kind: z.literal("unenforceable"), problem: z.string().min(1) }).strict(),

  // who ---------------------------------------------------------------------
  /** `granted_by` equals `subject_id`: the approver approved themselves. */
  z
    .object({
      kind: z.literal("self_approved"),
      subject_id: z.string(),
      granted_by: z.string(),
    })
    .strict(),
  /** The grant empowers someone other than the subject making this call. */
  z
    .object({
      kind: z.literal("subject_mismatch"),
      granted_to: z.string(),
      presented_by: z.string(),
    })
    .strict(),

  // when --------------------------------------------------------------------
  z
    .object({ kind: z.literal("revoked"), revoked_at: Timestamp, checked_at: Timestamp })
    .strict(),
  /** Presented before it was issued — a forged or mis-stamped record. */
  z
    .object({ kind: z.literal("not_yet_valid"), issued_at: Timestamp, checked_at: Timestamp })
    .strict(),
  z
    .object({ kind: z.literal("expired"), expires_at: Timestamp, checked_at: Timestamp })
    .strict(),

  // how many ----------------------------------------------------------------
  /** Single use is the default, so this is the replay of an already-used grant. */
  z.object({ kind: z.literal("consumed"), uses_remaining: z.number().int() }).strict(),

  // what --------------------------------------------------------------------
  /** Both sides are `Toolkit.tool`, the form `GovernanceEvent.tool` carries. */
  z
    .object({ kind: z.literal("tool_mismatch"), granted_for: z.string(), called: z.string() })
    .strict(),
  /** The pinned input carrying the grant's `resource_id` named something else. */
  z
    .object({
      kind: z.literal("resource_mismatch"),
      input: z.string(),
      granted_resource_id: z.string(),
      actual: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pinned_input_mismatch"),
      input: z.string(),
      expected: z.unknown(),
      actual: z.unknown(),
    })
    .strict(),

  // how much ----------------------------------------------------------------
  /** The replay this module exists to stop: approved for `max`, called with `actual`. */
  z
    .object({
      kind: z.literal("ceiling_exceeded"),
      input: z.string(),
      max: z.number(),
      actual: z.number(),
    })
    .strict(),
  /** A ceiling on an input the call did not carry bounds nothing. */
  z.object({ kind: z.literal("ceiling_input_missing"), input: z.string() }).strict(),
  /** `"95000"` is not ninety-five thousand. Numbers are never coerced. */
  z
    .object({
      kind: z.literal("ceiling_input_not_numeric"),
      input: z.string(),
      actual: z.unknown(),
    })
    .strict(),
]);
export type GrantRejectionReason = z.infer<typeof GrantRejectionReason>;

/** Every `kind` the union carries, for exhaustiveness checks in tests. */
export const GRANT_REJECTION_KINDS = GrantRejectionReason.options.map(
  (option) => option.shape.kind.value,
);

// ---------------------------------------------------------------------------
// GovernanceEvent — the audit row and the SSE frame
// ---------------------------------------------------------------------------

/**
 * One decision by one hook: the audit record, and the frame the control-plane
 * panel renders. Same shape for both on purpose — the panel shows the audit
 * log rather than a prettier parallel story.
 *
 * `redactions` is what a `/post` `modify` says it did: one `RedactionRecord`
 * per thing removed — path, `rule_id`, `pattern_id`, kind — and never the
 * removed value. It is absent everywhere else.
 *
 * **There is no slot for a payload at all.** `before` and `after` used to sit
 * here as `z.unknown().optional()`, and they are gone (#101, finishing what #16
 * decided). The obvious thing to put in `before` is the tool's raw output,
 * which for `Loan.GetLoan` is the borrower's bank account number and tax id —
 * and this row is written to `audit_log` and streamed on an unauthenticated
 * `GET /events`, so it would persist the secret and broadcast it to anyone who
 * can reach the hook host. `after` is no safer: a rule conditioned on clearance
 * does not fire for a privileged subject, so the "after" of *their* modify is a
 * payload still holding the identifiers.
 *
 * Deleting the fields rather than documenting them as unused is the whole
 * point, and it is the same move `RedactionRecord` makes one screen up: this
 * object is `.strict()`, so an event carrying `before` is now a parse error
 * instead of a code review someone has to catch. An optional `unknown` left
 * standing is exactly where the next contributor would park the raw output.
 * What a `modify` did is said by `redactions[]` — where and why — and the panel
 * renders the mask from the path rather than from a value it was handed.
 *
 * `execution_id` is Arcade's, and correlates `/pre` with `/post` exactly. It is
 * empty at `/access`, which has no execution to identify, and spike 02 found it
 * never reaches an MCP client — so the panel joins on it server-side and cannot
 * expect the browser to supply it.
 */
export const GovernanceEvent = z
  .object({
    id: z.string().min(1),
    ts: Timestamp,
    execution_id: z.string(),
    hook: HookPoint,
    user_id: z.string(),
    /** Fully-qualified `Toolkit.tool_name`, as the panel displays it. */
    tool: z.string(),
    decision: Effect,
    reason: z.string(),
    rule_id: z.string().nullable(),
    /** What a `/post` `modify` removed. Absent on every other event. */
    redactions: z.array(RedactionRecord).optional(),
  })
  .strict();
export type GovernanceEvent = z.infer<typeof GovernanceEvent>;

/**
 * The three hooks against the seeded cast: the four acts as Arcade would see
 * them, plus the fail-closed paths and the response shape spike #2 measured.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { AccessHookResult, type GovernanceEvent, PostHookResult, PreHookResult } from "@cg/policy-schema";

import { loanFixture } from "./loan-fixture.ts";
import { createApprovalControl } from "../src/approval-governance.ts";
import { CORRELATION_TOKEN, correlationId } from "../src/correlation.ts";
import { handleAccess, handlePost, handlePre, type HandlerContext } from "../src/handlers.ts";
import { createPolicyCache, type CacheState } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";

const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";
const RILEY = "riley.chen@bank.example";
const MORGAN = "morgan.ellis@bank.example";

const governance = (): Database =>
  openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} });

let n = 0;

/**
 * A context bound to one database. `/pre` reads approvals and grants from it,
 * so the handler and the store a test inspects have to be looking at the same
 * file — hence the binding rather than a free-standing object.
 */
const contextFor = (db: Database): HandlerContext => ({
  now: () => "2026-01-01T00:00:00.000Z",
  newId: () => `evt_${String(++n).padStart(10, "0")}`,
  approvals: createApprovalControl(db, { toolkit: "Approvals", grantTtlSeconds: 900 }),
});

const ready = (): CacheState => createPolicyCache(governance()).reload();

const cold: CacheState = { status: "cold" };

const failed: CacheState = {
  status: "failed",
  revision: 7,
  failed_at: "2026-01-01T00:00:00.000Z",
  error: "Policy failed to compile: rule x",
};

const ctx: HandlerContext = contextFor(governance());

/**
 * The single audit row a handler wrote.
 *
 * `events[0]` is `GovernanceEvent | undefined` under `noUncheckedIndexedAccess`,
 * and the two callers below feed its `id` to `toBe`. `events[0]!.id` would
 * typecheck and turn "the handler recorded nothing" — the failure these tests
 * exist to catch — into a `toBe(undefined)` that reads as a mismatched
 * correlation token. Fail here instead, naming what actually went wrong.
 */
function onlyEvent(events: readonly GovernanceEvent[]): GovernanceEvent {
  const [event, ...rest] = events;
  if (event === undefined || rest.length > 0) {
    throw new Error(`expected exactly one audit row, got ${events.length}`);
  }
  return event;
}

const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const pre = (user_id: string, name: string, inputs: Record<string, unknown>) => ({
  execution_id: "tc_1",
  tool: { name, toolkit: "Loan", version: "1.0.0" },
  inputs,
  context: { authorization: [{}], user_id },
});

describe("/access — act 1", () => {
  test("hides ApproveLoan from Sam, in the request's own shape down to the version array", () => {
    const { response, events } = handleAccess(
      { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: { ApproveLoan: V } } } });
    expect(AccessHookResult.parse(response)).toEqual(response);

    const hidden = events.filter((e) => e.decision === "deny");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({
      hook: "access",
      user_id: SAM,
      tool: "Loan.ApproveLoan",
      rule_id: "access.analysts-cannot-see-approve",
      execution_id: "",
    });
    // One row per governed tool, allowed or not.
    expect(events.map((e) => e.tool).sort()).toEqual(
      ["Loan.ApproveLoan", "Loan.DenyLoan", "Loan.GetLoan", "Loan.SearchLoans"],
    );
  });

  test.each([DANA, RILEY, MORGAN])("shows everything to %s", (user) => {
    const { response } = handleAccess({ user_id: user, toolkits: { Loan: { tools: LOAN_TOOLS } } }, ready(), ctx);
    expect(response).toEqual({ deny: {} });
  });

  test("never returns a bare {} — an empty deny map is still a map", () => {
    const { response } = handleAccess({ user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } }, ready(), ctx);
    expect(response).toHaveProperty("deny");
  });

  test("matches the user id case-insensitively — the join key is an email", () => {
    const { response } = handleAccess(
      { user_id: SAM.toUpperCase(), toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(response.deny?.Loan?.tools).toHaveProperty("ApproveLoan");
  });

  test("hides every tool from a user the roster does not know", () => {
    const { response, events } = handleAccess(
      { user_id: "stranger@bank.example", toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(Object.keys(response.deny?.Loan?.tools ?? {}).sort()).toEqual(Object.keys(LOAN_TOOLS).sort());
    expect(events.every((e) => e.decision === "deny" && e.rule_id === null)).toBe(true);
    expect(events[0]?.reason).toMatch(/no registered subject/);
  });

  test("hides an ungoverned toolkit and audits every one of its tools, so each decision is reconstructible", () => {
    const { response, events } = handleAccess(
      {
        user_id: DANA,
        toolkits: {
          Loan: { tools: LOAN_TOOLS },
          Github: { tools: { CreateIssue: [{ version: "2.0.0" }], ListRepos: [{ version: "2.0.0" }] } },
        },
      },
      ready(),
      ctx,
    );
    expect(response.deny).toEqual({
      Github: { tools: { CreateIssue: [{ version: "2.0.0" }], ListRepos: [{ version: "2.0.0" }] } },
    });
    const github = events.filter((e) => e.tool.startsWith("Github."));
    expect(github.map((e) => e.tool).sort()).toEqual(["Github.CreateIssue", "Github.ListRepos"]);
    for (const e of github) {
      expect(e).toMatchObject({ decision: "deny", rule_id: null, user_id: DANA });
      expect(e.reason).toMatch(/not governed/);
    }
    // And one row for every Loan tool too: six decisions, six rows.
    expect(events).toHaveLength(6);
  });

  test("fails closed when the policy is unavailable: denies everything named, one row per tool, says why", () => {
    const { response, events } = handleAccess(
      { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      failed,
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });
    expect(events.map((e) => e.tool).sort()).toEqual(
      ["Loan.ApproveLoan", "Loan.DenyLoan", "Loan.GetLoan", "Loan.SearchLoans"],
    );
    for (const e of events) {
      expect(e).toMatchObject({ decision: "deny", rule_id: null });
      expect(e.reason).toContain("FAIL-CLOSED");
      expect(e.reason).toContain("Policy failed to compile");
    }
  });

  test("a cold cache denies everything — it never loads policy on a hook call", () => {
    const { response, events } = handleAccess(
      { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      cold,
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });
    expect(events).toHaveLength(4);
    expect(events[0]?.reason).toMatch(/has not loaded its policy yet/);
  });

  test("copes with a toolkit that lists no tools", () => {
    const { response, events } = handleAccess({ user_id: DANA, toolkits: { Empty: {} } }, ready(), ctx);
    expect(response).toEqual({ deny: {} });
    expect(events).toEqual([]);
  });
});

describe("/pre — act 2", () => {
  test("blocks Dana's $95K with the remediation instruction and a correlation token", () => {
    const { response, events } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }), ready(), ctx);

    expect(response.code).toBe("CHECK_FAILED");
    expect(PreHookResult.parse(response)).toEqual(response);
    const message = response.error_message ?? "";
    expect(message).toContain("95000 exceeds your approval authority of 50000");
    expect(message).toContain("Approvals.RequestApproval");
    expect(message).toContain("resource_id=LN-2291");
    expect(message).toContain("Loan.ApproveLoan");
    expect(message).toMatch(CORRELATION_TOKEN);

    // The token is the audit row's id, so the panel can join exactly.
    expect(events).toHaveLength(1);
    expect(correlationId(message)).toBe(onlyEvent(events).id);
    expect(events[0]).toMatchObject({
      hook: "pre",
      execution_id: "tc_1",
      user_id: DANA,
      tool: "Loan.ApproveLoan",
      decision: "deny",
      rule_id: "pre.approve-within-clearance",
    });
    // The audit row carries the reason without the token — the token is the row.
    expect(events[0]?.reason).not.toMatch(CORRELATION_TOKEN);
  });

  test("the token reads as a reference, not an instruction", () => {
    const { response } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }), ready(), ctx);
    expect(response.error_message).toMatch(/ \[ref evt_[0-9a-z]{10}\]$/);
  });

  test.each([
    ["Dana at her limit", DANA, 50_000],
    ["Dana under her limit", DANA, 40_000],
    ["Riley, the minimum-sufficient approver", RILEY, 95_000],
    ["Morgan", MORGAN, 4_000_000],
  ])("allows %s", (_label, user, amount) => {
    const { response, events } = handlePre(pre(user, "ApproveLoan", { loan_id: "LN-2291", amount }), ready(), ctx);
    expect(response).toEqual({ code: "OK" });
    expect(events[0]).toMatchObject({ decision: "allow", rule_id: null, user_id: user });
  });

  test("Sam's $0 clearance denies any positive approval even if the tool were reached", () => {
    const { response } = handlePre(pre(SAM, "ApproveLoan", { loan_id: "LN-2291", amount: 1 }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
  });

  test("allows reads for everyone in the cast", () => {
    for (const user of [DANA, SAM, RILEY, MORGAN]) {
      const { response } = handlePre(pre(user, "GetLoan", { loan_id: "LN-2291" }), ready(), ctx);
      expect(response).toEqual({ code: "OK" });
    }
  });

  test("denies an unknown user with a message that says no retry helps", () => {
    const { response, events } = handlePre(pre("stranger@bank.example", "GetLoan", { loan_id: "LN-2291" }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/no registered subject/);
    expect(events[0]).toMatchObject({ decision: "deny", rule_id: null, user_id: "stranger@bank.example" });
  });

  test("denies a payload with no user id at all", () => {
    const request = pre(DANA, "GetLoan", { loan_id: "LN-2291" });
    const { response, events } = handlePre({ ...request, context: { authorization: [{}] } }, ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(events[0]?.user_id).toBe("");
  });

  test("denies a call missing a catalogued argument, and says which", () => {
    const { response } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291" }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toContain('"amount"');
  });

  test("denies a tool name in the wrong case — the silent-permit trap, closed", () => {
    const { response } = handlePre(pre(DANA, "approve_loan", { loan_id: "LN-2291", amount: 1 }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toContain('"approve_loan"');
  });

  test("fails closed when the policy is unavailable: full error in the audit row, one sentence to the model", () => {
    const { response, events } = handlePre(pre(DANA, "GetLoan", { loan_id: "LN-2291" }), failed, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/policy is unavailable/);
    expect(response.error_message).not.toContain("Policy failed to compile");
    expect(response.error_message).toMatch(CORRELATION_TOKEN);
    expect(events[0]?.reason).toContain("FAIL-CLOSED");
    expect(events[0]?.reason).toContain("Policy failed to compile");
    expect(events[0]).toMatchObject({ decision: "deny", rule_id: null, tool: "Loan.GetLoan" });
  });
});

describe("/pre — cold cache", () => {
  test("denies with a short message and audits the reason", () => {
    const { response, events } = handlePre(pre(DANA, "GetLoan", { loan_id: "LN-2291" }), cold, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/policy is unavailable/);
    expect(events[0]?.reason).toMatch(/has not loaded its policy yet/);
  });
});

describe("/post — acts 3 and 4", () => {
  /** `LN-2291` exactly as the loan book holds it, read from `apps/loan-app`'s own fixture. */
  const LOAN = loanFixture("LN-2291");
  /** Everything before the pasted block — the half of the note an underwriter wrote. */
  const LEGITIMATE_NOTE = (LOAN.underwriter_notes as string).split(
    "\n\n--- pasted from committee thread ---",
  )[0] as string;

  const postBody = (user_id: string, output: unknown = LOAN, execution_id = "tc_9") => ({
    execution_id,
    tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
    inputs: { loan_id: "LN-2291" },
    success: true,
    output,
    context: { user_id },
  });

  test.each([
    ["cold", cold],
    ["failed", failed],
  ])("fails closed when the cache is %s: CHECK_FAILED, output withheld, deny row", (_label, state) => {
    const { response, events } = handlePost(postBody(DANA), state, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/cannot release the output of Loan\.GetLoan/);
    expect(response.error_message).toMatch(CORRELATION_TOKEN);
    expect(response).not.toHaveProperty("override");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ hook: "post", execution_id: "tc_9", tool: "Loan.GetLoan", decision: "deny", rule_id: null });
    expect(events[0]?.reason).toContain("FAIL-CLOSED");
    expect(correlationId(response.error_message ?? "")).toBe(onlyEvent(events).id);
  });

  test("a tool no output rule names passes through unchanged, and the row says so", () => {
    const { response, events } = handlePost(
      { ...postBody(DANA), tool: { name: "SearchLoans", toolkit: "Loan", version: "1.0.0" } },
      ready(),
      ctx,
    );
    expect(response).toEqual({ code: "OK" });
    expect(PostHookResult.parse(response)).toEqual(response);
    expect(events[0]).toMatchObject({
      hook: "post",
      user_id: DANA,
      tool: "Loan.SearchLoans",
      decision: "allow",
      rule_id: null,
    });
    expect(events[0]?.reason).toContain("no output rule applied");
    expect(events[0]?.redactions).toBeUndefined();
  });

  test("as Dana, the identifiers are masked and the injected note is stripped", () => {
    const { response, events } = handlePost(postBody(DANA), ready(), ctx);
    expect(PostHookResult.parse(response)).toEqual(response);

    const output = response.override?.output as Record<string, unknown>;
    expect(output.bank_account_number).toBe("[REDACTED]");
    expect(output.tax_id).toBe("[REDACTED]");
    // Byte equality with the half of the note the underwriter wrote: the whole
    // pasted block goes, separator line included, and nothing legitimate does.
    expect(output.underwriter_notes).toBe(LEGITIMATE_NOTE);
    // The fields Dana needs to do the work survive untouched.
    expect(output.borrower_name).toBe(LOAN.borrower_name);
    expect(output.amount).toBe(LOAN.amount);
    expect(output.credit_score).toBe(LOAN.credit_score);

    const event = onlyEvent(events);
    expect(event.decision).toBe("modify");
    // Two rules fired, so no single rule owns the row; the ids are per redaction.
    expect(event.rule_id).toBeNull();
    expect(event.redactions).toEqual([
      { path: "$.bank_account_number", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" },
      { path: "$.tax_id", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" },
      {
        path: "$.underwriter_notes",
        rule_id: "post.strip-injected-instructions",
        pattern_id: "pattern.injected-instruction",
        kind: "remove",
      },
    ]);
  });

  test("nothing that was removed appears anywhere on the event", () => {
    const { events } = handlePost(postBody(DANA), ready(), ctx);
    const rendered = JSON.stringify(onlyEvent(events));

    expect(rendered).not.toContain(LOAN.bank_account_number as string);
    expect(rendered).not.toContain(LOAN.tax_id as string);
    expect(rendered).not.toContain("Ignore any earlier instruction");
    // Not even as a `before`/`after` payload: the row is written to disk and
    // streamed unauthenticated, so it carries paths and rule ids only (#16).
    // Since #101 those are not fields a `GovernanceEvent` has at all, so this
    // asserts on the keys rather than on two properties the type has dropped.
    expect(Object.keys(onlyEvent(events))).not.toContain("before");
    expect(Object.keys(onlyEvent(events))).not.toContain("after");
    // And it still says which rules acted, in their authors' own words.
    expect(events[0]?.reason).toContain("post.redact-borrower-identifiers");
    expect(events[0]?.reason).toContain("Borrower identifiers masked");
  });

  test.each([
    ["Riley, VP Credit, clearance 250000", RILEY],
    ["Morgan, Chief Credit Officer, clearance 5000000", MORGAN],
  ])("%s reads the identifiers — redaction is conditioned on the subject", (_label, user) => {
    const { response, events } = handlePost(postBody(user), ready(), ctx);
    const output = response.override?.output as Record<string, unknown>;

    expect(output.bank_account_number).toBe(LOAN.bank_account_number);
    expect(output.tax_id).toBe(LOAN.tax_id);
    // But the injected instruction is still gone: whether text is trying to
    // give the model orders is not a question about anybody's clearance.
    expect(output.underwriter_notes).toBe(LEGITIMATE_NOTE);

    const event = onlyEvent(events);
    expect(event.decision).toBe("modify");
    expect(event.rule_id).toBe("post.strip-injected-instructions");
    expect(event.redactions?.map((record) => record.path)).toEqual(["$.underwriter_notes"]);
  });

  test("Sam, whose clearance is 0, is redacted like Dana", () => {
    const { response } = handlePost(postBody(SAM), ready(), ctx);
    const output = response.override?.output as Record<string, unknown>;
    expect(output.bank_account_number).toBe("[REDACTED]");
  });

  test("a caller the roster does not know is redacted, not exempted", () => {
    // The fail-closed direction at /post: an unknown subject cannot be shown to
    // clear the bar, so every rule applies. A matcher that let a stranger
    // through would make the control an opt-in.
    const { response } = handlePost(postBody("stranger@bank.example"), ready(), ctx);
    const output = response.override?.output as Record<string, unknown>;
    expect(output.bank_account_number).toBe("[REDACTED]");
    expect(output.tax_id).toBe("[REDACTED]");
  });

  test("a second pass over the redacted payload changes nothing and records nothing", () => {
    const first = handlePost(postBody(DANA), ready(), ctx);
    const second = handlePost(postBody(DANA, first.response.override?.output), ready(), ctx);

    expect(second.response).toEqual({ code: "OK" });
    expect(second.events[0]?.decision).toBe("allow");
    expect(second.events[0]?.redactions).toBeUndefined();
  });

  test("the tool's own output object is never mutated", () => {
    const output = loanFixture("LN-2291");
    handlePost(postBody(DANA, output), ready(), ctx);
    expect(output.bank_account_number).toBe(LOAN.bank_account_number);
  });
});

describe("the correlation token", () => {
  test("round-trips and fails soft on a message without one", () => {
    expect(correlationId("DENIED: x. [ref evt_0123456789]")).toBe("evt_0123456789");
    expect(correlationId("Tool execution was denied by an extension policy: DENIED: x. [ref evt_0123456789]")).toBe(
      "evt_0123456789",
    );
    expect(correlationId("DENIED: x.")).toBeNull();
    expect(correlationId("[ref evt_0123456789] then more text")).toBeNull();
  });
});

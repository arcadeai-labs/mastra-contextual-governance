/**
 * The governance vocabulary.
 *
 * These schemas are a contract between five slices that are being built in
 * parallel and cannot ask each other questions, so what is asserted here is
 * mostly the parts a consumer would otherwise have to guess: which fields
 * `parse()` fills in, which are nullable, and which are refused.
 */
import { describe, expect, it } from "bun:test";

import {
  ApprovalRequest,
  Condition,
  Decision,
  Effect,
  GovernanceEvent,
  Grant,
  HookPoint,
  OutputRule,
  PolicyRule,
  RedactionKind,
  RedactionRecord,
  Subject,
  Timestamp,
} from "../src/domain.ts";

describe("enumerations", () => {
  it("names Arcade's three control points", () => {
    expect(HookPoint.options).toEqual(["access", "pre", "post"]);
  });

  it("names the three effects a decision can have", () => {
    expect(Effect.options).toEqual(["allow", "deny", "modify"]);
  });
});

describe("Subject", () => {
  it("defaults attributes to an empty map so rules can read it unconditionally", () => {
    const subject = Subject.parse({
      user_id: "a@example.com",
      display_name: "A",
      role: "operator",
      clearance: 0,
    });
    expect(subject.attributes).toEqual({});
  });

  it("allows a clearance of zero — no numeric authority at all", () => {
    expect(
      Subject.parse({
        user_id: "a@example.com",
        display_name: "A",
        role: "operator",
        clearance: 0,
      }).clearance,
    ).toBe(0);
  });

  it("rejects a negative clearance", () => {
    expect(() =>
      Subject.parse({
        user_id: "a@example.com",
        display_name: "A",
        role: "operator",
        clearance: -1,
      }),
    ).toThrow();
  });
});

describe("PolicyRule", () => {
  const minimal = {
    id: "rule.1",
    description: "",
    hook: "pre" as const,
    match: { toolkit: "Widgets", tool: "update_widget" },
    effect: "deny" as const,
    reason: "Denied.",
    priority: 10,
  };

  it("fills in the fields seed data should not have to spell out", () => {
    const rule = PolicyRule.parse(minimal);
    expect(rule.enabled).toBe(true);
    expect(rule.conditions).toEqual([]);
    expect(rule.subjects).toBeNull();
  });

  it("applies only at /access or /pre — /post is OutputRule's job", () => {
    expect(() => PolicyRule.parse({ ...minimal, hook: "post" })).toThrow();
  });

  it("defaults a condition's value to null, for operators that take none", () => {
    const condition = Condition.parse({
      input: "quantity",
      operator: "exceeds_clearance",
    });
    expect(condition.value).toBeNull();
  });

  it("rejects an empty tool matcher segment, which would match nothing", () => {
    // A rule that matches nothing is indistinguishable from a rule that
    // permits — the exact silent fail-open this demo exists to disprove.
    expect(() =>
      PolicyRule.parse({ ...minimal, match: { toolkit: "", tool: "update_widget" } }),
    ).toThrow();
  });
});

describe("OutputRule", () => {
  const minimal = {
    id: "rule.redact",
    description: "",
    match: { toolkit: "Widgets", tool: "get_widget" },
    reason: "Redacted.",
    priority: 10,
  };

  it("allows either mechanism alone, or both together", () => {
    expect(OutputRule.parse(minimal).fields).toEqual([]);
    expect(OutputRule.parse(minimal).patterns).toEqual([]);

    const both = OutputRule.parse({
      ...minimal,
      fields: [{ path: "identifier", strategy: "mask" }],
      patterns: [{ id: "p", regex: "secret", strategy: "remove" }],
    });
    expect(both.fields).toHaveLength(1);
    expect(both.patterns).toHaveLength(1);
  });

  it("supplies a redaction placeholder rather than leaving one undefined", () => {
    const rule = OutputRule.parse({
      ...minimal,
      fields: [{ path: "identifier", strategy: "mask" }],
    });
    expect(rule.fields[0]?.replacement).toBe("[REDACTED]");
  });

  it("defaults pattern matching to case-insensitive", () => {
    const rule = OutputRule.parse({
      ...minimal,
      patterns: [{ id: "p", regex: "ignore previous instructions", strategy: "remove" }],
    });
    expect(rule.patterns[0]?.flags).toBe("i");
  });
});

describe("Decision", () => {
  it("is the shape #1 and DESIGN.md specify", () => {
    const decision = Decision.parse({
      effect: "deny",
      reason: "Denied.",
      rule_id: "rule.1",
    });
    expect(decision).toEqual({ effect: "deny", reason: "Denied.", rule_id: "rule.1" });
  });

  it("allows a null rule_id, for a default rather than a matched rule", () => {
    expect(
      Decision.parse({ effect: "allow", reason: "No rule matched.", rule_id: null })
        .rule_id,
    ).toBeNull();
  });

  it("carries an override of any shape, for a modify", () => {
    const decision = Decision.parse({
      effect: "modify",
      reason: "Redacted.",
      rule_id: "rule.redact",
      override: { output: { identifier: "[REDACTED]" } },
    });
    expect(decision.override).toEqual({ output: { identifier: "[REDACTED]" } });
  });
});

describe("Grant", () => {
  const minimal = {
    id: "grant_1",
    subject_id: "a@example.com",
    granted_by: "b@example.com",
    request_id: "req_1",
    match: { toolkit: "Widgets", tool: "update_widget" },
    resource_id: null,
    pinned_inputs: {},
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T00:15:00.000Z",
  };

  it("defaults to a single use, so a grant is not a standing permission", () => {
    expect(Grant.parse(minimal).uses_remaining).toBe(1);
  });

  it("carries an upper bound, not an equality, on the one numeric input", () => {
    // #10 has to accept a retry at or below the approved value and reject a
    // replay above it. An exact-match input map cannot express that, so the
    // bound is its own field and names which input carries it.
    const grant = Grant.parse({
      ...minimal,
      pinned_inputs: { widget_id: "WID-1" },
      ceiling: { input: "quantity", max: 95 },
    });
    expect(grant.ceiling).toEqual({ input: "quantity", max: 95 });
    expect(grant.pinned_inputs).toEqual({ widget_id: "WID-1" });
  });

  it("has no ceiling by default, for a grant with no numeric dimension", () => {
    expect(Grant.parse(minimal).ceiling).toBeNull();
  });

  it("rejects a ceiling that names no input", () => {
    expect(() =>
      Grant.parse({ ...minimal, ceiling: { input: "", max: 95 } }),
    ).toThrow();
  });

  it("allows unlimited uses within the expiry window, spelled null", () => {
    expect(Grant.parse({ ...minimal, uses_remaining: null }).uses_remaining).toBeNull();
  });

  it("requires both parties, so #10 has something to compare for separation of duties", () => {
    expect(() => Grant.parse({ ...minimal, granted_by: "" })).toThrow();
  });

  it("insists timestamps are ISO 8601 instants", () => {
    expect(() => Grant.parse({ ...minimal, expires_at: "tomorrow" })).toThrow();
  });
});

describe("ApprovalRequest", () => {
  const minimal = {
    id: "req_1",
    requester_id: "a@example.com",
    approver_id: null,
    match: { toolkit: "Widgets", tool: "update_widget" },
    resource_id: null,
    inputs: {},
    justification: "",
    required_clearance: null,
    status: "pending" as const,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("starts undecided, with the routing fields empty rather than absent", () => {
    const request = ApprovalRequest.parse(minimal);
    expect(request.approver_id).toBeNull();
    expect(request.candidate_approver_ids).toEqual([]);
    expect(request.decided_at).toBeNull();
    expect(request.note).toBeNull();
  });

  it("records who was eligible, not just who was asked", () => {
    // The panel shows the approver who was *not* bothered — that is the point
    // minimum-sufficient-clearance routing is making.
    const request = ApprovalRequest.parse({
      ...minimal,
      candidate_approver_ids: ["b@example.com", "c@example.com"],
      approver_id: "b@example.com",
    });
    expect(request.candidate_approver_ids).toEqual(["b@example.com", "c@example.com"]);
  });
});

describe("GovernanceEvent", () => {
  const minimal = {
    id: "evt_1",
    ts: "2026-01-01T00:00:00.000Z",
    execution_id: "tc_1",
    hook: "pre" as const,
    user_id: "a@example.com",
    tool: "Widgets.update_widget",
    decision: "deny" as const,
    reason: "Denied.",
    rule_id: "rule.1",
  };

  it("matches the event contract in DESIGN.md", () => {
    expect(Object.keys(GovernanceEvent.parse(minimal)).sort()).toEqual(
      [
        "decision",
        "execution_id",
        "hook",
        "id",
        "reason",
        "rule_id",
        "ts",
        "tool",
        "user_id",
      ].sort(),
    );
  });

  it("allows an empty execution_id, which is what /access has", () => {
    // `/access` governs discovery; there is no execution to identify yet.
    expect(
      GovernanceEvent.parse({ ...minimal, hook: "access", execution_id: "" })
        .execution_id,
    ).toBe("");
  });

  it("says what a modify did through redactions[], and carries no payload", () => {
    const modified = GovernanceEvent.parse({
      ...minimal,
      decision: "modify",
      redactions: [
        { path: "$.identifier", rule_id: "rule.redact", pattern_id: null, kind: "mask" },
      ],
    });
    expect(modified.redactions).toEqual([
      { path: "$.identifier", rule_id: "rule.redact", pattern_id: null, kind: "mask" },
    ]);
    expect(Object.keys(modified)).not.toContain("before");
    expect(Object.keys(modified)).not.toContain("after");
  });

  it("has nowhere to put the payload either side of a modify", () => {
    // The same argument `RedactionRecord` makes, one level up. This row is
    // persisted to `audit_log` and streamed on an unauthenticated `GET /events`,
    // so `before` holding `Loan.GetLoan`'s raw output would write the borrower's
    // account number to disk and broadcast it — and `after` is no safer, because
    // a clearance-conditioned rule does not fire for a privileged subject and
    // *their* "after" still holds the identifiers (#16, #101). `.strict()` is
    // what makes that a parse error rather than a code review someone has to
    // catch.
    for (const leak of ["before", "after", "output", "payload", "value"]) {
      expect(() =>
        GovernanceEvent.parse({ ...minimal, decision: "modify", [leak]: { tax_id: "12-3456789" } }),
      ).toThrow();
    }
  });

  it("survives a JSON round-trip, which is how it reaches the panel", () => {
    const event = GovernanceEvent.parse(minimal);
    expect(GovernanceEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
});

describe("subject matching", () => {
  const rule = {
    id: "rule.redact",
    description: "",
    match: { toolkit: "Widgets", tool: "get_widget" },
    reason: "Redacted.",
    priority: 10,
  };

  it("can be conditioned on clearance, not just on role", () => {
    // #8: "rules can be conditioned on the subject's role or clearance" — a
    // redaction that applies to junior subjects and not to senior ones.
    const parsed = OutputRule.parse({
      ...rule,
      subjects: { clearance_below: 50 },
    });
    expect(parsed.subjects).toEqual({
      user_ids: null,
      roles: null,
      clearance_below: 50,
      clearance_at_least: null,
    });
  });

  it("expresses a band with both bounds", () => {
    const parsed = OutputRule.parse({
      ...rule,
      subjects: { clearance_at_least: 10, clearance_below: 50 },
    });
    expect(parsed.subjects?.clearance_at_least).toBe(10);
    expect(parsed.subjects?.clearance_below).toBe(50);
  });

  it("narrows on nothing by default, which is a blanket rule", () => {
    expect(OutputRule.parse({ ...rule, subjects: {} })).toMatchObject({
      subjects: {
        user_ids: null,
        roles: null,
        clearance_below: null,
        clearance_at_least: null,
      },
    });
  });

  it("rejects a predicate it does not recognise instead of dropping it", () => {
    // The failure this prevents: Zod 3 strips unknown keys by default, so a
    // typo would leave a matcher that narrows on nothing — a rule meant for one
    // role silently governing everybody.
    expect(() =>
      OutputRule.parse({ ...rule, subjects: { clearance_under: 50 } }),
    ).toThrow();
  });
});

describe("strictness", () => {
  it("rejects an unknown key on every hand-written schema", () => {
    const valid = {
      Subject: {
        user_id: "a@example.com",
        display_name: "A",
        role: "operator",
        clearance: 0,
      },
      Decision: { effect: "allow", reason: "", rule_id: null },
      GovernanceEvent: {
        id: "evt_1",
        ts: "2026-01-01T00:00:00.000Z",
        execution_id: "",
        hook: "pre",
        user_id: "a@example.com",
        tool: "Widgets.update_widget",
        decision: "allow",
        reason: "",
        rule_id: null,
      },
    } as const;

    const schemas = { Subject, Decision, GovernanceEvent };
    for (const [name, schema] of Object.entries(schemas)) {
      const input = valid[name as keyof typeof valid];
      expect(schema.parse(input)).toBeDefined();
      expect(() => schema.parse({ ...input, surprise: 1 })).toThrow();
    }
  });
});

describe("Timestamp", () => {
  const at = (ts: string) => () => Timestamp.parse(ts);

  it("accepts a Z-suffixed UTC instant", () => {
    expect(at("2026-01-01T00:00:00.000Z")()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an offset and SQLite's own datetime format", () => {
    // Pinned because it constrains #11 and #12: rows must be stamped with
    // `new Date().toISOString()`. Letting SQLite's `datetime('now')` supply the
    // value would make every read back through these schemas fail.
    expect(at("2026-01-01T00:00:00+00:00")).toThrow();
    expect(at("2026-01-01 00:00:00")).toThrow();
  });
});

describe("RedactionRecord", () => {
  const minimal = { path: "$.identifier", rule_id: "rule.redact", kind: "mask" as const };

  it("defaults pattern_id to null, so a field redaction says so rather than omitting it", () => {
    expect(RedactionRecord.parse(minimal).pattern_id).toBeNull();
  });

  it("carries the pattern that fired when a sweep found it", () => {
    const record = RedactionRecord.parse({ ...minimal, pattern_id: "pattern.instruction" });
    expect(record.pattern_id).toBe("pattern.instruction");
  });

  it("has nowhere to put the value that was removed", () => {
    // The whole point of the shape. This record is written to the audit log and
    // drawn on a projector; a field that could hold the removed value would
    // eventually hold a real identifier in both places. `.strict()` is what
    // makes that a parse error rather than a code review someone has to catch.
    for (const leak of ["value", "before", "removed", "matched", "original"]) {
      expect(() => RedactionRecord.parse({ ...minimal, [leak]: "4000000000000002" })).toThrow();
    }
  });

  it("refuses an empty path or rule_id, which would name nothing on the panel", () => {
    expect(() => RedactionRecord.parse({ ...minimal, path: "" })).toThrow();
    expect(() => RedactionRecord.parse({ ...minimal, rule_id: "" })).toThrow();
  });

  it("lets the engine own a redaction no rule asked for", () => {
    // Same convention as `Decision.rule_id` and `GovernanceEvent.rule_id`: null
    // means the engine decided, not a policy row. The post hook needs it for a
    // value it withheld because the redaction would not settle — no single rule
    // did that, and blaming one would be fiction in the audit log.
    const record = RedactionRecord.parse({
      path: "$.note",
      rule_id: null,
      pattern_id: null,
      kind: "unsettled",
    });
    expect(record.rule_id).toBeNull();
    expect(record.kind).toBe("unsettled");
  });

  it("defaults rule_id to null rather than requiring it", () => {
    expect(RedactionRecord.parse({ path: "$.note", kind: "mask" }).rule_id).toBeNull();
  });

  it("accepts every strategy as a kind, and refuses one that is neither", () => {
    for (const kind of RedactionKind.options) {
      expect(RedactionRecord.parse({ ...minimal, kind }).kind).toBe(kind);
    }
    expect(() => RedactionRecord.parse({ ...minimal, kind: "withheld" })).toThrow();
  });

  it("survives a JSON round-trip, which is how it reaches the panel", () => {
    const record = RedactionRecord.parse(minimal);
    expect(RedactionRecord.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
});

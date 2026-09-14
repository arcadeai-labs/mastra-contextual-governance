/**
 * PolicyEngine, from the outside.
 *
 * Every assertion here is about a `Decision` — its `effect`, its `rule_id`,
 * and what its `reason` tells a model to do next — or about what
 * `compilePolicy` refuses. Nothing asserts evaluation order, helper names or
 * internal structure: renaming a private function must not break a test.
 *
 * Fixtures come from `@cg/policy-schema` and describe an invented `Widgets`
 * toolkit, so nothing here names the demo's business domain.
 */
import { describe, expect, it } from "bun:test";

import {
  aGrant,
  aPolicyRule,
  aSubject,
  PolicyRule as PolicyRuleSchema,
  SAMPLE_READ_TOOL,
  SAMPLE_SUBJECT_IDS,
  SAMPLE_TOOLKIT,
  SAMPLE_WRITE_TOOL,
  type PolicyRule,
  type PolicyRuleInput,
  type Subject,
} from "@cg/policy-schema";

import {
  attestGrantValidated,
  compilePolicy,
  evaluatePermission,
  hiddenTools,
  NO_REMEDIATION,
  PolicyCompileError,
  resolveVisibility,
  type Policy,
  type ToolRef,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// A small world
// ---------------------------------------------------------------------------

const READ: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_READ_TOOL };
const WRITE: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL };
const ESCALATE: ToolRef = { toolkit: "Approvals", name: "RequestApproval" };
/**
 * What the gateway serves, keyed by the toolkit names config carries: each
 * tool with the arguments a call to it must supply.
 */
const CATALOGUE = {
  [SAMPLE_TOOLKIT]: {
    [SAMPLE_READ_TOOL]: ["widget_id", "verbose?"],
    // Required arguments, then the optional ones (`?`) the condition tests read.
    [SAMPLE_WRITE_TOOL]: [
      "widget_id",
      "quantity",
      "status?",
      "region?",
      "note?",
      "target?",
      "override_code?",
      "justification?",
    ],
  },
  Approvals: {
    RequestApproval: ["resource_id", "quantity", "justification"],
    Decide: ["request_id", "decision"],
  },
};

const operator: Subject = aSubject({
  user_id: SAMPLE_SUBJECT_IDS.operator,
  display_name: "Operator",
  role: "operator",
  clearance: 0,
});
const supervisor: Subject = aSubject(); // role "supervisor", clearance 50
const director: Subject = aSubject({
  user_id: SAMPLE_SUBJECT_IDS.director,
  display_name: "Director",
  role: "director",
  clearance: 500,
});

const REMEDIATION =
  "DENIED: {{inputs.quantity}} exceeds your {{subject.clearance}} clearance for " +
  "{{tool.toolkit}}.{{tool.name}}. To proceed, call Approvals_RequestApproval with " +
  "resource_id={{inputs.widget_id}}, quantity={{inputs.quantity}} and justification=<why " +
  "this is needed>, then retry this call unchanged once it is approved.";

/** The rule every act-2 test is about: deny when quantity exceeds clearance. */
const clearanceRule = aPolicyRule({ reason: REMEDIATION });

/** Act 1: operators do not see the write tool at all. */
const hideWriteFromOperators = aPolicyRule({
  id: "rule.hide-write",
  description: "Operators never see the write tool.",
  hook: "access",
  match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
  subjects: { roles: ["operator"] },
  conditions: [],
  effect: "deny",
  reason: "Your role cannot use this tool.",
  priority: 10,
});

/** Every catalogued argument of `tool`, filled with a placeholder value. */
function fullInputs(tool: ToolRef): Record<string, unknown> {
  const args = (CATALOGUE as Record<string, Record<string, readonly string[]>>)[tool.toolkit]?.[
    tool.name
  ];
  return Object.fromEntries(
    (args ?? []).filter((arg) => !arg.endsWith("?")).map((arg) => [arg, `${arg}-value`]),
  );
}

/** A reason that passes the remediation check without saying anything specific. */
const ESCALATE_FIRST =
  "Blocked. To proceed, call Approvals_RequestApproval with resource_id={{inputs.widget_id}}, " +
  "quantity={{inputs.quantity}} and justification=<why>, then retry.";

function policy(rules: PolicyRule[], overrides: Partial<Policy> = {}) {
  return compilePolicy({ catalogue: CATALOGUE, rules, ...overrides });
}

/** A rule written from scratch — no fixture defaults merged in. */
const rule = (input: PolicyRuleInput): PolicyRule => PolicyRuleSchema.parse(input);

// ---------------------------------------------------------------------------
// Visibility — the /access question
// ---------------------------------------------------------------------------

describe("resolveVisibility", () => {
  const compiled = policy([hideWriteFromOperators, clearanceRule]);
  const tools = [READ, WRITE];

  const cases: ReadonlyArray<
    readonly [label: string, subject: Subject, hidden: readonly ToolRef[]]
  > = [
    ["hides the write tool from an operator", operator, [WRITE]],
    ["shows everything to a supervisor", supervisor, []],
    ["shows everything to a director", director, []],
  ];

  for (const [label, subject, hidden] of cases) {
    it(label, () => {
      const result = hiddenTools(subject, tools, compiled).map(({ tool }) => tool);
      expect(result).toEqual([...hidden]);
    });
  }

  it("returns one decision per tool, in the order asked, each carrying its rule_id", () => {
    const result = resolveVisibility(operator, tools, compiled);
    expect(result.map(({ tool }) => tool)).toEqual(tools);
    expect(result.map(({ decision }) => decision)).toEqual([
      { effect: "allow", reason: "No rule matched.", rule_id: null },
      { effect: "deny", reason: "Your role cannot use this tool.", rule_id: "rule.hide-write" },
    ]);
  });

  it("does not let a pre rule hide a tool — that is a different question", () => {
    // clearanceRule is a pre rule on WRITE. Visibility must ignore it.
    const [write] = hiddenTools(supervisor, [WRITE], policy([clearanceRule]));
    expect(write).toBeUndefined();
  });

  it("hides every tool from an unknown user, and says no retry can fix it", () => {
    const result = resolveVisibility(null, tools, compiled);
    expect(result.every(({ decision }) => decision.effect === "deny")).toBe(true);
    expect(result.every(({ decision }) => decision.rule_id === null)).toBe(true);
    expect(result[0]?.decision.reason).toMatch(/no registered subject/i);
    expect(result[0]?.decision.reason).toMatch(/administrator/i);
  });

  it("hides a tool the catalogue does not list, inside a governed toolkit", () => {
    const stranger: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: "delete_everything" };
    const [decision] = resolveVisibility(director, [stranger], compiled).map((v) => v.decision);
    expect(decision?.effect).toBe("deny");
    expect(decision?.rule_id).toBeNull();
    expect(decision?.reason).toContain('"delete_everything"');
  });

  it("hides a tool from a toolkit the configuration does not know", () => {
    const stranger: ToolRef = { toolkit: "Elsewhere", name: "do_thing" };
    const [decision] = resolveVisibility(director, [stranger], compiled).map((v) => v.decision);
    expect(decision?.effect).toBe("deny");
    expect(decision?.rule_id).toBeNull();
    expect(decision?.reason).toContain('"Elsewhere"');
    expect(decision?.reason).toMatch(/configuration/i);
  });

  it("lets a higher-priority allow rule carve an exception out of a blanket deny", () => {
    const compiledWithException = policy([
      rule({
        id: "rule.hide-all",
        description: "",
        hook: "access",
        match: { toolkit: "*", tool: "*" },
        effect: "deny",
        reason: "Hidden.",
        priority: 100,
      }),
      rule({
        id: "rule.show-read",
        description: "",
        hook: "access",
        match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL },
        effect: "allow",
        reason: "Everyone may read.",
        priority: 1,
      }),
    ]);
    const decisions = resolveVisibility(operator, tools, compiledWithException).map(
      ({ decision }) => [decision.effect, decision.rule_id],
    );
    expect(decisions).toEqual([
      ["allow", "rule.show-read"],
      ["deny", "rule.hide-all"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Permission — the /pre question
// ---------------------------------------------------------------------------

describe("evaluatePermission: amounts against clearance", () => {
  const compiled = policy([clearanceRule]);
  const call = (subject: Subject, quantity: unknown) =>
    evaluatePermission({
      subject,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity },
      policy: compiled,
    });

  const cases: ReadonlyArray<
    readonly [label: string, subject: Subject, quantity: number, effect: "allow" | "deny"]
  > = [
    ["under the limit is allowed", supervisor, 49, "allow"],
    ["exactly at the limit is allowed — the limit is inclusive", supervisor, 50, "allow"],
    ["one over the limit is denied", supervisor, 51, "deny"],
    ["far over the limit is denied", supervisor, 95, "deny"],
    ["zero clearance denies any positive quantity", operator, 1, "deny"],
    ["zero clearance still allows exactly zero", operator, 0, "allow"],
    ["a higher clearance allows what a lower one could not", director, 95, "allow"],
  ];

  for (const [label, subject, quantity, effect] of cases) {
    it(label, () => {
      expect(call(subject, quantity).effect).toBe(effect);
    });
  }

  it("an allowed call that no rule denied carries no rule_id", () => {
    expect(call(supervisor, 10)).toEqual({
      effect: "allow",
      reason: "No rule matched.",
      rule_id: null,
    });
  });

  it("a denial carries the rule that produced it", () => {
    expect(call(supervisor, 95).rule_id).toBe("rule.clearance");
  });

  it("a denial reason is the remediation instruction, with the call's values filled in", () => {
    const { reason } = call(supervisor, 95);
    expect(reason).toBe(
      "DENIED: 95 exceeds your 50 clearance for Widgets.update_widget. To proceed, call " +
        "Approvals_RequestApproval with resource_id=WID-1, quantity=95 and justification=<why " +
        "this is needed>, then retry this call unchanged once it is approved.",
    );
  });
});

describe("evaluatePermission: missing and malformed parameters fail closed", () => {
  const compiled = policy([clearanceRule]);
  const call = (inputs: Record<string, unknown>) =>
    evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: compiled });

  // A catalogued argument that is absent is malformed before any rule is
  // consulted, so no rule id. A present-but-wrong-typed one is caught by the
  // rule that tried to read it.
  const cases: ReadonlyArray<
    readonly [label: string, inputs: Record<string, unknown>, rule_id: string | null, tells: RegExp]
  > = [
    ["missing entirely", { widget_id: "WID-1" }, null, /"quantity".*not provided/],
    ["present but null", { widget_id: "WID-1", quantity: null }, null, /"quantity".*not provided/],
    ["a numeric string", { widget_id: "WID-1", quantity: "95" }, "rule.clearance", /must be a number.*string "95"/],
    ["a boolean", { widget_id: "WID-1", quantity: true }, "rule.clearance", /must be a number.*boolean true/],
    ["an object", { widget_id: "WID-1", quantity: { value: 95 } }, "rule.clearance", /must be a number.*an object/],
    ["an array", { widget_id: "WID-1", quantity: [95] }, "rule.clearance", /must be a number.*an array/],
    ["NaN", { widget_id: "WID-1", quantity: Number.NaN }, "rule.clearance", /must be a number/],
    ["Infinity", { widget_id: "WID-1", quantity: Number.POSITIVE_INFINITY }, "rule.clearance", /must be a number/],
  ];

  for (const [label, inputs, rule_id, tells] of cases) {
    it(`denies when the governed input is ${label}`, () => {
      const decision = call(inputs);
      expect(decision.effect).toBe("deny");
      expect(decision.rule_id).toBe(rule_id);
      expect(decision.reason).toMatch(tells);
    });
  }

  it("lists every missing catalogued argument at once, and names the tool to retry", () => {
    const { reason, effect } = call({});
    expect(effect).toBe("deny");
    expect(reason).toContain('"widget_id", "quantity"');
    expect(reason).toMatch(/Retry Widgets\.update_widget with/);
  });

  it("denies a call missing a catalogued argument even when no rule reads it", () => {
    // READ has no rule at all; its catalogued argument is still required.
    const decision = evaluatePermission({ subject: director, tool: READ, inputs: {}, policy: compiled });
    expect(decision).toMatchObject({ effect: "deny", rule_id: null });
    expect(decision.reason).toMatch(/"widget_id".*not provided/);
  });

  it("does not require catalogued arguments at /access, which carries no inputs", () => {
    expect(hiddenTools(director, [READ, WRITE], compiled)).toEqual([]);
  });

  it("names the tool to retry and the input to fix", () => {
    const { reason } = call({ widget_id: "WID-1" });
    expect(reason).toContain("Widgets.update_widget");
    expect(reason).toMatch(/retry/i);
    expect(reason).toContain('"quantity"');
  });

  it("does not care about inputs no rule mentions", () => {
    expect(call({ widget_id: "WID-1", quantity: 10, note: undefined, extra: [1, 2] }).effect).toBe(
      "allow",
    );
  });
});

describe("evaluatePermission: who is calling", () => {
  const compiled = policy([clearanceRule]);

  it("denies an unknown user with no rule_id and an instruction that a retry will not help", () => {
    const decision = evaluatePermission({
      subject: null,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 1 },
      policy: compiled,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBeNull();
    expect(decision.reason).toMatch(/no registered subject/i);
    expect(decision.reason).toMatch(/no tool call can fix this/i);
  });

  it("applies a rule scoped by role only to that role", () => {
    const compiledScoped = policy([
      aPolicyRule({ subjects: { roles: ["supervisor"] }, reason: ESCALATE_FIRST }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({
        subject,
        tool: WRITE,
        inputs: { widget_id: "WID-1", quantity: 1_000 },
        policy: compiledScoped,
      }).effect;
    expect(call(supervisor)).toBe("deny");
    expect(call(director)).toBe("allow");
  });

  it("applies a rule scoped by user_id only to that user", () => {
    const compiledScoped = policy([
      aPolicyRule({ subjects: { user_ids: [SAMPLE_SUBJECT_IDS.director] }, reason: ESCALATE_FIRST }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({
        subject,
        tool: WRITE,
        inputs: { widget_id: "WID-1", quantity: 1_000 },
        policy: compiledScoped,
      }).effect;
    expect(call(director)).toBe("deny");
    expect(call(supervisor)).toBe("allow");
  });

  it("applies a clearance band: at_least is inclusive, below is exclusive", () => {
    const compiledBand = policy([
      aPolicyRule({
        subjects: { clearance_at_least: 50, clearance_below: 500 },
        conditions: [],
        reason: ESCALATE_FIRST,
      }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({ subject, tool: WRITE, inputs: fullInputs(WRITE), policy: compiledBand })
        .effect;
    expect(call(operator)).toBe("allow"); // 0 < 50
    expect(call(supervisor)).toBe("deny"); // 50 >= 50 and < 500
    expect(call(director)).toBe("allow"); // 500 is not below 500
  });
});

describe("evaluatePermission: which tool is being called", () => {
  const compiled = policy([clearanceRule]);

  it("allows a known tool that no rule speaks about, with no rule_id", () => {
    const decision = evaluatePermission({
      subject: operator,
      tool: READ,
      inputs: { widget_id: "WID-1" },
      policy: compiled,
    });
    expect(decision).toEqual({ effect: "allow", reason: "No rule matched.", rule_id: null });
  });

  it("denies a tool from a toolkit the configuration does not know, naming the toolkit", () => {
    const decision = evaluatePermission({
      subject: director,
      tool: { toolkit: "Elsewhere", name: SAMPLE_WRITE_TOOL },
      inputs: { quantity: 1 },
      policy: compiled,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBeNull();
    expect(decision.reason).toContain('"Elsewhere"');
    expect(decision.reason).toContain(`"${SAMPLE_TOOLKIT}"`);
    expect(decision.reason).toMatch(/do not retry/i);
  });

  it("denies a tool the catalogue does not list, even inside a governed toolkit", () => {
    const decision = evaluatePermission({
      subject: director,
      tool: { toolkit: SAMPLE_TOOLKIT, name: "delete_everything" },
      inputs: {},
      policy: compiled,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBeNull();
    expect(decision.reason).toContain('"delete_everything"');
    expect(decision.reason).toContain(`"${SAMPLE_WRITE_TOOL}"`);
    expect(decision.reason).toMatch(/do not retry/i);
  });

  it("does not match a governed tool by case or prefix — those are unknown tools, denied", () => {
    const call = (tool: ToolRef) =>
      evaluatePermission({
        subject: director, // clearance high enough that the clearance rule would allow
        tool,
        inputs: { widget_id: "WID-1", quantity: 95 },
        policy: compiled,
      });
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL })).toMatchObject({
      effect: "allow",
      rule_id: null,
    });
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL.toUpperCase() })).toMatchObject(
      { effect: "deny", rule_id: null },
    );
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: `${SAMPLE_WRITE_TOOL}_v2` })).toMatchObject({
      effect: "deny",
      rule_id: null,
    });
    expect(call({ toolkit: SAMPLE_TOOLKIT.toLowerCase(), name: SAMPLE_WRITE_TOOL })).toMatchObject(
      { effect: "deny", rule_id: null },
    );
  });

  it("honours a wildcard on either segment", () => {
    const compiledWild = policy([
      rule({
        id: "rule.freeze",
        description: "",
        hook: "pre",
        match: { toolkit: "*", tool: "*" },
        subjects: { roles: ["operator"] },
        effect: "deny",
        reason: "Operators may not call anything right now. Do not retry.",
        priority: 1,
      }),
    ]);
    for (const tool of [READ, WRITE, ESCALATE]) {
      const inputs = fullInputs(tool);
      expect(
        evaluatePermission({ subject: operator, tool, inputs, policy: compiledWild }).effect,
      ).toBe("deny");
      expect(
        evaluatePermission({ subject: supervisor, tool, inputs, policy: compiledWild }).effect,
      ).toBe("allow");
    }
  });
});

describe("evaluatePermission: grants", () => {
  const compiled = policy([clearanceRule]);
  const blocked = { subject: supervisor, tool: WRITE, inputs: { widget_id: "WID-1", quantity: 95 } };

  it("denies without a grant", () => {
    expect(evaluatePermission({ ...blocked, policy: compiled }).effect).toBe("deny");
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [] }).effect).toBe("deny");
  });

  it("allows with an applicable grant, keeping the rule the grant lifted", () => {
    const decision = evaluatePermission({ ...blocked, policy: compiled, grants: [attestGrantValidated(aGrant())] });
    expect(decision.effect).toBe("allow");
    expect(decision.rule_id).toBe("rule.clearance");
    expect(decision.reason).toMatch(/grant/i);
    expect(decision.reason).toContain("grant_0001");
  });

  it("ignores a grant issued to somebody else", () => {
    const grant = attestGrantValidated(aGrant({ subject_id: SAMPLE_SUBJECT_IDS.director }));
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [grant] }).effect).toBe(
      "deny",
    );
  });

  it("ignores a grant for a different tool", () => {
    const grant = attestGrantValidated(
      aGrant({ match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL } }),
    );
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [grant] }).effect).toBe(
      "deny",
    );
  });

  it("a grant does not turn a missing parameter into an allowed call", () => {
    // A grant lifts a policy denial; it cannot make an unevaluable call evaluable.
    const decision = evaluatePermission({
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1" },
      policy: compiled,
      grants: [attestGrantValidated(aGrant())],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/not provided/);
  });

  it("a grant is irrelevant to visibility", () => {
    // Grants are a /pre concept. An operator with a grant still cannot see the tool.
    const compiledAccess = policy([hideWriteFromOperators]);
    expect(hiddenTools(operator, [WRITE], compiledAccess)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conditions beyond the clearance check
// ---------------------------------------------------------------------------

describe("evaluatePermission: condition operators", () => {
  const deny = (conditions: PolicyRuleInput["conditions"]) =>
    policy([
      rule({
        id: "rule.cond",
        description: "",
        hook: "pre",
        match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
        conditions,
        effect: "deny",
        reason: ESCALATE_FIRST,
        priority: 1,
      }),
    ]);
  // The catalogued arguments are always supplied; each case adds the input
  // its condition is about.
  const call = (conditions: PolicyRuleInput["conditions"], inputs: Record<string, unknown>) =>
    evaluatePermission({
      subject: director,
      tool: WRITE,
      inputs: { ...fullInputs(WRITE), ...inputs },
      policy: deny(conditions),
    });

  const cases: ReadonlyArray<
    readonly [
      label: string,
      conditions: PolicyRuleInput["conditions"],
      inputs: Record<string, unknown>,
      effect: "allow" | "deny",
    ]
  > = [
    ["eq fires on an equal string", [{ input: "status", operator: "eq", value: "closed" }], { status: "closed" }, "deny"],
    ["eq does not fire on a different string", [{ input: "status", operator: "eq", value: "closed" }], { status: "open" }, "allow"],
    ["eq compares structurally", [{ input: "target", operator: "eq", value: { id: 1 } }], { target: { id: 1 } }, "deny"],
    ["neq fires on a different value", [{ input: "status", operator: "neq", value: "open" }], { status: "closed" }, "deny"],
    ["neq does not fire on the same value", [{ input: "status", operator: "neq", value: "open" }], { status: "open" }, "allow"],
    ["gt is exclusive", [{ input: "quantity", operator: "gt", value: 10 }], { quantity: 10 }, "allow"],
    ["gt fires above", [{ input: "quantity", operator: "gt", value: 10 }], { quantity: 11 }, "deny"],
    ["gte is inclusive", [{ input: "quantity", operator: "gte", value: 10 }], { quantity: 10 }, "deny"],
    ["lt is exclusive", [{ input: "quantity", operator: "lt", value: 10 }], { quantity: 10 }, "allow"],
    ["lt fires below", [{ input: "quantity", operator: "lt", value: 10 }], { quantity: 9 }, "deny"],
    ["lte is inclusive", [{ input: "quantity", operator: "lte", value: 10 }], { quantity: 10 }, "deny"],
    ["in fires on membership", [{ input: "region", operator: "in", value: ["eu", "uk"] }], { region: "uk" }, "deny"],
    ["in does not fire outside the set", [{ input: "region", operator: "in", value: ["eu", "uk"] }], { region: "us" }, "allow"],
    ["nin fires outside the set", [{ input: "region", operator: "nin", value: ["eu", "uk"] }], { region: "us" }, "deny"],
    ["nin does not fire on membership", [{ input: "region", operator: "nin", value: ["eu", "uk"] }], { region: "eu" }, "allow"],
    ["matches fires on a regex hit", [{ input: "note", operator: "matches", value: "^urgent" }], { note: "urgent: now" }, "deny"],
    ["matches does not fire on a miss", [{ input: "note", operator: "matches", value: "^urgent" }], { note: "routine" }, "allow"],
    ["exists fires when present", [{ input: "override_code", operator: "exists" }], { override_code: "x" }, "deny"],
    ["exists does not fire when absent", [{ input: "override_code", operator: "exists" }], {}, "allow"],
    ["exists does not fire on null", [{ input: "override_code", operator: "exists" }], { override_code: null }, "allow"],
    ["exists=false fires when absent", [{ input: "justification", operator: "exists", value: false }], {}, "deny"],
    ["exists=false does not fire when present", [{ input: "justification", operator: "exists", value: false }], { justification: "because" }, "allow"],
    ["a dot path reaches a nested input", [{ input: "target.region", operator: "eq", value: "eu" }], { target: { region: "eu" } }, "deny"],
    ["all conditions must hold", [{ input: "region", operator: "eq", value: "eu" }, { input: "quantity", operator: "gt", value: 10 }], { region: "eu", quantity: 5 }, "allow"],
    ["all conditions holding fires", [{ input: "region", operator: "eq", value: "eu" }, { input: "quantity", operator: "gt", value: 10 }], { region: "eu", quantity: 50 }, "deny"],
  ];

  for (const [label, conditions, inputs, effect] of cases) {
    it(label, () => {
      expect(call(conditions, inputs).effect).toBe(effect);
    });
  }

  it("matches against a non-string fails closed as malformed", () => {
    const decision = call([{ input: "note", operator: "matches", value: "^urgent" }], { note: 7 });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/must be a string/);
  });

  it("a missing input under eq fails closed rather than silently not matching", () => {
    const decision = call([{ input: "status", operator: "eq", value: "closed" }], {});
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/"status".*not provided/);
  });

  it("a dot path through a missing parent is a missing input", () => {
    const decision = call([{ input: "target.region", operator: "eq", value: "eu" }], {});
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/"target.region".*not provided/);
  });

  it("a regex is stateless across calls", () => {
    const conditions: PolicyRuleInput["conditions"] = [
      { input: "note", operator: "matches", value: "urgent" },
    ];
    const first = call(conditions, { note: "urgent" }).effect;
    const second = call(conditions, { note: "urgent" }).effect;
    expect([first, second]).toEqual(["deny", "deny"]);
  });
});

// ---------------------------------------------------------------------------
// Priority and enablement, observed from the outside
// ---------------------------------------------------------------------------

describe("evaluatePermission: several rules", () => {
  it("the lowest priority number wins, whatever order the rules arrive in", () => {
    const allowSmall = rule({
      id: "rule.allow-small",
      description: "",
      hook: "pre",
      match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
      conditions: [{ input: "quantity", operator: "lte", value: 5 }],
      effect: "allow",
      reason: "Small quantities are always fine.",
      priority: 1,
    });
    const denyAll = rule({
      id: "rule.deny-all",
      description: "",
      hook: "pre",
      match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
      effect: "deny",
      reason: "Writes are frozen. Do not retry.",
      priority: 50,
    });
    for (const rules of [
      [allowSmall, denyAll],
      [denyAll, allowSmall],
    ]) {
      const compiled = policy(rules);
      const call = (quantity: number) =>
        evaluatePermission({
          subject: director,
          tool: WRITE,
          inputs: { widget_id: "WID-1", quantity },
          policy: compiled,
        });
      expect(call(3)).toMatchObject({ effect: "allow", rule_id: "rule.allow-small" });
      expect(call(30)).toMatchObject({ effect: "deny", rule_id: "rule.deny-all" });
    }
  });

  it("equal priorities resolve the same way regardless of input order", () => {
    const a = aPolicyRule({ id: "rule.a", priority: 10, reason: `A. ${ESCALATE_FIRST}` });
    const b = aPolicyRule({ id: "rule.b", priority: 10, reason: `B. ${ESCALATE_FIRST}` });
    const inputs = { widget_id: "WID-1", quantity: 95 };
    const one = evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: policy([a, b]) });
    const two = evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: policy([b, a]) });
    expect(one).toEqual(two);
  });

  it("a disabled rule has no effect", () => {
    const compiled = policy([aPolicyRule({ enabled: false, reason: ESCALATE_FIRST })]);
    const decision = evaluatePermission({
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 95 },
      policy: compiled,
    });
    expect(decision).toEqual({ effect: "allow", reason: "No rule matched.", rule_id: null });
  });

  it("does not mutate its inputs", () => {
    const compiled = policy([clearanceRule]);
    const inputs = { widget_id: "WID-1", nested: { quantity: 1 }, quantity: 95 };
    const snapshot = structuredClone(inputs);
    const subject = aSubject();
    const subjectSnapshot = structuredClone(subject);
    evaluatePermission({ subject, tool: WRITE, inputs, policy: compiled, grants: [attestGrantValidated(aGrant())] });
    expect(inputs).toEqual(snapshot);
    expect(subject).toEqual(subjectSnapshot);
  });

  it("is deterministic: the same call gives the same decision every time", () => {
    const compiled = policy([clearanceRule, hideWriteFromOperators]);
    const input = {
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 95 },
      policy: compiled,
    };
    const decisions = new Set(
      Array.from({ length: 20 }, () => JSON.stringify(evaluatePermission(input))),
    );
    expect(decisions.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compilation — a rule that would match nothing is refused up front
// ---------------------------------------------------------------------------

describe("compilePolicy refuses a policy that cannot mean what it says", () => {
  const base = (): PolicyRuleInput => ({
    id: "rule.x",
    description: "",
    hook: "pre",
    match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
    effect: "deny",
    reason: ESCALATE_FIRST,
    priority: 1,
  });
  const withRules = (...rules: PolicyRule[]): Policy => ({ catalogue: CATALOGUE, rules });
  /** A reason with no placeholders and no remediation tool: valid anywhere. */
  const STOP = `Frozen. ${NO_REMEDIATION}.`;

  const cases: ReadonlyArray<readonly [label: string, policy: Policy, tells: RegExp]> = [
    [
      "a rule naming a toolkit that is not configured",
      withRules(rule({ ...base(), match: { toolkit: "Widgetz", tool: "*" } })),
      /"Widgetz".*not configured.*"Widgets".*matching nothing/s,
    ],
    [
      "a rule naming a tool its toolkit does not serve — a typo would otherwise permit",
      withRules(rule({ ...base(), match: { toolkit: SAMPLE_TOOLKIT, tool: "udpate_widget" } })),
      /"udpate_widget".*does not serve.*"update_widget".*matching nothing/s,
    ],
    [
      "a wildcard-toolkit rule naming a tool no toolkit serves",
      withRules(rule({ ...base(), match: { toolkit: "*", tool: "approve_widget" } })),
      /"approve_widget".*no configured toolkit serves/,
    ],
    [
      "an empty catalogue",
      { catalogue: {}, rules: [] },
      /catalogue is empty/,
    ],
    [
      "a toolkit that lists no tools",
      { catalogue: { ...CATALOGUE, Empty: {} }, rules: [] },
      /"Empty" lists no tools/,
    ],
    [
      "a pre denial whose reason is an apology, not an instruction",
      withRules(rule({ ...base(), reason: "Insufficient authority." })),
      /must tell the model what to do next.*"Insufficient authority\."/,
    ],
    [
      // #89. The rule is otherwise perfect: right tool, right arguments, right
      // toolkit. It just names the tool the way an audit row does, and the
      // model's tool list has no such entry — so the one sentence that was
      // going to un-stick the turn instructs nothing. Refused at compile time,
      // because at run time it looks exactly like a working denial.
      "a pre denial naming a catalogued tool in the dot spelling the model never sees",
      withRules(
        rule({
          ...base(),
          reason:
            "Blocked. To proceed, call Approvals.RequestApproval with resource_id={{inputs.widget_id}}, " +
            "quantity={{inputs.quantity}} and justification=<why>, then retry.",
        }),
      ),
      /names "Approvals\.RequestApproval", the spelling hook payloads and audit rows use.*"Approvals_RequestApproval" — write that instead/s,
    ],
    [
      "a pre denial naming a tool that a catalogued toolkit does not serve",
      withRules(rule({ ...base(), reason: "Call Approvals_Escalate with resource_id=1." })),
      /names "Approvals_Escalate", which toolkit "Approvals" does not serve.*must tell the model what to do next/s,
    ],
    [
      "a pre denial whose argument values are empty placeholders",
      withRules(
        rule({
          ...base(),
          reason: "Call Approvals_RequestApproval with resource_id={{}}, quantity={{}}, justification={{}}.",
        }),
      ),
      /does not form a placeholder.*no value for argument\(s\) "resource_id", "quantity", "justification"/s,
    ],
    [
      "a pre denial whose argument values are empty quotes",
      withRules(
        rule({
          ...base(),
          reason: `Call Approvals_RequestApproval with resource_id="", quantity='', justification=<>.`,
        }),
      ),
      /no value for argument\(s\) "resource_id", "quantity", "justification"/,
    ],
    [
      "a reason with an unterminated placeholder",
      withRules(rule({ ...base(), reason: `{{inputs.quantity is too much. ${NO_REMEDIATION}.` })),
      /"\{\{" that does not form a placeholder/,
    ],
    [
      "a reason with a stray closing brace pair",
      withRules(rule({ ...base(), reason: `Too much }}. ${NO_REMEDIATION}.` })),
      /"\}\}" that does not form a placeholder/,
    ],
    [
      "a pre denial that says Do not retry and then instructs a call anyway",
      withRules(
        rule({
          ...base(),
          reason: `${NO_REMEDIATION}. Instead call Bogus_Escalate with ticket=1.`,
        }),
      ),
      /says "Do not retry" but also instructs a call \("Bogus_Escalate"\)/,
    ],
    [
      "a pre denial that says Do not retry and then names a catalogued tool",
      withRules(rule({ ...base(), reason: `${NO_REMEDIATION}; Approvals_RequestApproval is closed.` })),
      /says "Do not retry" but also instructs a call \("Approvals_RequestApproval"\)/,
    ],
    [
      "a subject matcher with an empty roles list, which matches nobody",
      withRules(rule({ ...base(), subjects: { roles: [] }, reason: STOP })),
      /subjects\.roles is an empty list, which matches nobody/,
    ],
    [
      "a subject matcher with an empty user_ids list, which matches nobody",
      withRules(rule({ ...base(), subjects: { user_ids: [] }, reason: STOP })),
      /subjects\.user_ids is an empty list, which matches nobody/,
    ],
    [
      "a subject matcher below a clearance of zero, which no subject can be",
      withRules(rule({ ...base(), subjects: { clearance_below: 0 }, reason: STOP })),
      /clearance_below is 0, but clearance is never negative/,
    ],
    [
      "a subject matcher whose clearance band is empty",
      withRules(
        rule({ ...base(), subjects: { clearance_at_least: 50, clearance_below: 50 }, reason: STOP }),
      ),
      /band is empty and matches nobody/,
    ],
    [
      "a condition on an input no matched tool accepts — a typo that would fail closed forever",
      withRules(
        rule({
          ...base(),
          conditions: [{ input: "quantitiy", operator: "gt", value: 50 }],
          reason: STOP,
        }),
      ),
      /condition on "quantitiy" reads an input that is not a catalogued argument.*"quantity".*fail closed forever/s,
    ],
    [
      "a condition on an input not common to every tool a wildcard rule matches",
      withRules(
        rule({
          ...base(),
          match: { toolkit: SAMPLE_TOOLKIT, tool: "*" },
          conditions: [{ input: "quantity", operator: "gt", value: 50 }],
          reason: STOP,
        }),
      ),
      /condition on "quantity" reads an input that is not a catalogued argument of every tool/,
    ],
    [
      "exists: false on a required argument, which can never be true",
      withRules(
        rule({
          ...base(),
          conditions: [{ input: "quantity", operator: "exists", value: false }],
          reason: STOP,
        }),
      ),
      /"exists: false" on an argument every matched tool requires.*can never be true/s,
    ],
    [
      "a catalogue argument that is not a valid name",
      { catalogue: { ...CATALOGUE, Odd: { do_thing: ["has space"] } }, rules: [] },
      /"Odd\.do_thing" declares argument "has space", which is not a valid name/,
    ],
    [
      "a catalogue argument declared twice",
      { catalogue: { ...CATALOGUE, Odd: { do_thing: ["a", "a?"] } }, rules: [] },
      /"Odd\.do_thing" declares argument "a" twice/,
    ],
    [
      "a pre denial whose arguments follow an uncatalogued tool reference",
      withRules(
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval; then Bogus_DoThing with resource_id=WID-1, " +
            "quantity=95, justification=needed.",
        }),
      ),
      /"Approvals_RequestApproval" but not the argument\(s\) it needs.*gives argument\(s\) "resource_id", "quantity", "justification" to "Bogus_DoThing", which is not a catalogued tool/s,
    ],
    [
      "a pre denial naming a remediation tool but none of its arguments",
      withRules(rule({ ...base(), reason: "Call Approvals_RequestApproval first." })),
      /"Approvals_RequestApproval" but not the argument\(s\) it needs: "resource_id", "quantity", "justification"/,
    ],
    [
      "a pre denial naming a remediation tool but only some of its arguments",
      withRules(
        rule({ ...base(), reason: "Call Approvals_RequestApproval with resource_id=1, quantity=2." }),
      ),
      /"Approvals_RequestApproval" but not the argument\(s\) it needs: "justification"/,
    ],
    [
      "a pre denial naming every argument but giving none of them a value",
      withRules(
        rule({
          ...base(),
          reason: "Call Approvals_RequestApproval with resource_id=, quantity=, justification=.",
        }),
      ),
      /no value for argument\(s\) "resource_id", "quantity", "justification"/,
    ],
    [
      "a pre denial giving a value to some arguments but not others",
      withRules(
        rule({
          ...base(),
          reason: "Call Approvals_RequestApproval with resource_id=1, quantity= and justification=x.",
        }),
      ),
      /no value for argument\(s\) "quantity"/,
    ],
    [
      "a pre denial naming an argument the remediation tool does not accept",
      withRules(rule({ ...base(), reason: "Call Approvals_RequestApproval with banana=1." })),
      /gives "Approvals_RequestApproval" argument\(s\) "banana", which it does not accept/,
    ],
    [
      "a pre denial whose one argument is a value placeholder with no argument name",
      withRules(
        rule({ ...base(), reason: "Call Approvals_RequestApproval for {{inputs.widget_id}}." }),
      ),
      /not the argument\(s\) it needs/,
    ],
    [
      "an access rule with conditions, which /access could never evaluate",
      withRules(
        rule({ ...base(), hook: "access", conditions: [{ input: "quantity", operator: "exists" }] }),
      ),
      /access rule cannot have conditions/,
    ],
    [
      "a modify effect, which a PolicyRule has no override to carry",
      withRules(rule({ ...base(), effect: "modify" })),
      /"modify"/,
    ],
    [
      "two rules with the same id",
      withRules(rule(base()), rule({ ...base(), priority: 2 })),
      /duplicate id/,
    ],
    [
      "gt with a non-numeric value",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "gt", value: "10" }] })),
      /"gt" with a non-numeric value/,
    ],
    [
      "in with a value that is not an array",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "in", value: "eu" }] })),
      /"in" with a value that is not an array/,
    ],
    [
      "matches with an invalid regular expression",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "matches", value: "(" }] })),
      /invalid regular expression/,
    ],
    [
      "matches with a non-string value",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "matches", value: 1 }] })),
      /"matches" with a value that is not a string/,
    ],
    [
      "eq with nothing to compare against",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "eq" }] })),
      /"eq" with no value/,
    ],
    [
      "exceeds_clearance given a value it would ignore",
      withRules(rule({ ...base(), conditions: [{ input: "quantity", operator: "exceeds_clearance", value: 5 }] })),
      /takes no value/,
    ],
    [
      "a reason placeholder rooted somewhere the engine cannot read",
      withRules(rule({ ...base(), reason: `Ask {{approver.name}}. ${NO_REMEDIATION}.` })),
      /placeholder "\{\{approver\.name\}\}" must start with inputs, subject or tool/,
    ],
    [
      "a reason placeholder for an input the matched tool is not catalogued to carry",
      withRules(
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval with resource_id={{inputs.missing_id}}, " +
            "quantity={{inputs.missing_quantity}}, justification={{inputs.missing_reason}}.",
        }),
      ),
      /"\{\{inputs\.missing_id\}\}" names an input that is not a required argument/,
    ],
    [
      "a reason placeholder for an input not common to every tool a wildcard rule matches",
      withRules(
        rule({
          ...base(),
          match: { toolkit: "*", tool: "*" },
          reason: `{{inputs.widget_id}} is frozen. ${NO_REMEDIATION}.`,
        }),
      ),
      /"\{\{inputs\.widget_id\}\}" names an input that is not a required argument of every tool/,
    ],
    [
      "a reason placeholder into subject.attributes, which nothing guarantees",
      withRules(rule({ ...base(), reason: `Ask {{subject.attributes.manager}}. ${NO_REMEDIATION}.` })),
      /"\{\{subject\.attributes\.manager\}\}" must be exactly/,
    ],
    [
      "a reason placeholder for a subject field that does not exist",
      withRules(rule({ ...base(), reason: `Hi {{subject.email}}. ${NO_REMEDIATION}.` })),
      /"\{\{subject\.email\}\}" must name one of user_id, display_name, role, clearance/,
    ],
    [
      "a remediation whose arguments come before the tool they belong to",
      withRules(
        rule({
          ...base(),
          reason:
            "With resource_id=1, quantity=2, justification=x, call Approvals_RequestApproval.",
        }),
      ),
      /before naming the tool they belong to/,
    ],
    [
      "a remediation naming two tools with their argument lists swapped",
      withRules(
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval with request_id=<id>, decision=approve; then " +
            "Approvals_Decide with resource_id=1, quantity=2, justification=x.",
        }),
      ),
      /"Approvals_RequestApproval" but not the argument\(s\) it needs: "resource_id", "quantity", "justification"/,
    ],
  ];

  for (const [label, input, tells] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => compilePolicy(input)).toThrow(PolicyCompileError);
      expect(() => compilePolicy(input)).toThrow(tells);
    });
  }

  it("reports every problem at once, naming the rule each belongs to", () => {
    let caught: unknown;
    try {
      compilePolicy(
        withRules(
          rule({ ...base(), id: "rule.one", match: { toolkit: "Nope", tool: "*" }, reason: STOP }),
          rule({ ...base(), id: "rule.two", effect: "modify", reason: STOP }),
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyCompileError);
    const { problems } = caught as PolicyCompileError;
    expect(problems).toHaveLength(2);
    expect(problems.filter((p) => p.includes('rule "rule.one"'))).toHaveLength(1);
    expect(problems.filter((p) => p.includes('rule "rule.two"'))).toHaveLength(1);
  });

  it("accepts a wildcard on either or both segments", () => {
    const wild = (toolkit: string, tool: string) =>
      rule({ ...base(), match: { toolkit, tool }, reason: STOP });
    expect(() => policy([wild("*", "*")])).not.toThrow();
    expect(() => policy([wild("*", SAMPLE_WRITE_TOOL)])).not.toThrow();
    expect(() => policy([wild(SAMPLE_TOOLKIT, "*")])).not.toThrow();
  });

  it("accepts a pre denial that tells the model to stop instead of naming a tool", () => {
    expect(() =>
      policy([rule({ ...base(), reason: "Writes are frozen for this role. Do not retry." })]),
    ).not.toThrow();
  });

  it("accepts a pre denial that names every argument the remediation tool needs", () => {
    expect(() =>
      policy([
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval with resource_id={{inputs.widget_id}}, " +
            "quantity={{inputs.quantity}}, justification=<your reason>; then retry.",
        }),
      ]),
    ).not.toThrow();
  });

  it("accepts a value in any of the forms a model can act on", () => {
    const forms = [
      'resource_id={{inputs.widget_id}}, quantity={{inputs.quantity}}, justification="why"',
      "resource_id=<the widget id>, quantity=<the quantity requested>, justification=<why>",
      "resource_id=WID-1, quantity=95, justification=needed",
      "resource_id='WID-1', quantity=95.5, justification=x",
    ];
    for (const args of forms) {
      expect(() =>
        policy([rule({ ...base(), reason: `Call Approvals_RequestApproval with ${args}.` })]),
      ).not.toThrow();
    }
  });

  it("accepts conditions on optional arguments, nested under them, and exists: false on them", () => {
    expect(() =>
      policy([
        rule({
          ...base(),
          conditions: [
            { input: "status", operator: "eq", value: "closed" },
            { input: "target.region", operator: "eq", value: "eu" },
            { input: "justification", operator: "exists", value: false },
          ],
          reason: STOP,
        }),
      ]),
    ).not.toThrow();
  });

  it("does not require optional arguments on the call, and lets a placeholder name only required ones", () => {
    // `verbose?` is optional on READ: absent is fine, and it cannot be a placeholder.
    const compiled = policy([]);
    expect(
      evaluatePermission({ subject: director, tool: READ, inputs: { widget_id: "W" }, policy: compiled })
        .effect,
    ).toBe("allow");
    expect(() =>
      policy([
        rule({
          ...base(),
          match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL },
          reason: `{{inputs.verbose}} is not allowed. ${NO_REMEDIATION}.`,
        }),
      ]),
    ).toThrow(/"\{\{inputs\.verbose\}\}" names an input that is not a required argument/);
  });

  it("does not mistake a placeholder's dotted path for a tool reference", () => {
    // `{{inputs.widget_id}}` must not open an invocation that swallows the
    // arguments after it.
    expect(() =>
      policy([
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval with resource_id={{inputs.widget_id}}, " +
            "quantity={{inputs.quantity}}, justification=<why>.",
        }),
      ]),
    ).not.toThrow();
  });

  it("does not mistake ordinary abbreviations for tool references", () => {
    expect(() =>
      policy([
        rule({
          ...base(),
          reason:
            "Call Approvals_RequestApproval with resource_id={{inputs.widget_id}}, " +
            "quantity={{inputs.quantity}}, justification=<e.g. why the customer needs it>.",
        }),
      ]),
    ).not.toThrow();
  });

  it("accepts a placeholder for an input common to every tool a wildcard rule matches", () => {
    // Both Widgets tools carry widget_id, so a Widgets.* rule may print it.
    expect(() =>
      policy([
        rule({
          ...base(),
          match: { toolkit: SAMPLE_TOOLKIT, tool: "*" },
          reason: `{{inputs.widget_id}} is frozen. ${NO_REMEDIATION}.`,
        }),
      ]),
    ).not.toThrow();
  });

  it("checks each remediation tool named, when a reason names more than one", () => {
    const both =
      "Call Approvals_RequestApproval with resource_id=1, quantity=2, justification=x; " +
      "once approved, Approvals_Decide is called with request_id=<id>, decision=approve.";
    expect(() => policy([rule({ ...base(), reason: both })])).not.toThrow();

    const halfDone =
      "Call Approvals_RequestApproval with resource_id=1, quantity=2, justification=x; " +
      "then Approvals_Decide with request_id=<id>.";
    expect(() => policy([rule({ ...base(), reason: halfDone })])).toThrow(
      /"Approvals_Decide" but not the argument\(s\) it needs: "decision"/,
    );
  });

  it("does not hold access denials or allows to the remediation standard", () => {
    // An access denial hides the tool; the model never reads its reason.
    expect(() => policy([hideWriteFromOperators])).not.toThrow();
    expect(() => policy([rule({ ...base(), effect: "allow", reason: "Fine." })])).not.toThrow();
  });

  it("accepts the sample policy", () => {
    expect(() => policy([clearanceRule, hideWriteFromOperators])).not.toThrow();
  });
});

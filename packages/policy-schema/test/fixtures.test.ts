/**
 * Fixtures, checked for the two properties everything downstream assumes:
 * they are valid instances of their schema, and they are deterministic.
 *
 * The first matters because a fixture is shared test data — an invalid one
 * fails in whichever module happens to touch it, a long way from the cause. The
 * second matters because the UI lane snapshots them.
 */
import { describe, expect, it } from "bun:test";

import {
  ApprovalRequest,
  Condition,
  Decision,
  GovernanceEvent,
  Grant,
  OutputRule,
  PolicyRule,
  Subject,
} from "../src/domain.ts";
import {
  AccessHookRequest,
  AccessHookResult,
  PostHookRequest,
  PostHookResult,
  PreHookRequest,
  PreHookResult,
  ToolContext,
  ToolInfo,
} from "../src/generated/hook-contract.ts";
import {
  aCondition,
  aDecision,
  aGovernanceEvent,
  aGovernanceEventSequence,
  aGrant,
  aHookExchange,
  anAccessHookRequest,
  anAccessHookResult,
  anApprovalRequest,
  anOutputRule,
  aPolicyRule,
  aPostHookRequest,
  aPostHookResult,
  aPreHookRequest,
  aPreHookResult,
  aSubject,
  aToolContext,
  aToolInfo,
  FIXTURE_EXECUTION_ID,
  qualify,
  SAMPLE_TOOLKIT,
  SAMPLE_WRITE_TOOL,
} from "../src/fixtures.ts";

const builders = [
  ["aSubject", aSubject, Subject],
  ["aCondition", aCondition, Condition],
  ["aPolicyRule", aPolicyRule, PolicyRule],
  ["anOutputRule", anOutputRule, OutputRule],
  ["aDecision", aDecision, Decision],
  ["anApprovalRequest", anApprovalRequest, ApprovalRequest],
  ["aGrant", aGrant, Grant],
  ["aGovernanceEvent", aGovernanceEvent, GovernanceEvent],
  ["aToolInfo", aToolInfo, ToolInfo],
  ["aToolContext", aToolContext, ToolContext],
  ["anAccessHookRequest", anAccessHookRequest, AccessHookRequest],
  ["anAccessHookResult", anAccessHookResult, AccessHookResult],
  ["aPreHookRequest", aPreHookRequest, PreHookRequest],
  ["aPreHookResult", aPreHookResult, PreHookResult],
  ["aPostHookRequest", aPostHookRequest, PostHookRequest],
  ["aPostHookResult", aPostHookResult, PostHookResult],
] as const;

describe("every builder produces a valid instance", () => {
  for (const [name, build, schema] of builders) {
    it(`${name}() parses`, () => {
      expect(() => schema.parse(build())).not.toThrow();
    });

    it(`${name}() is deterministic`, () => {
      expect(build()).toEqual(build());
    });
  }
});

describe("overrides", () => {
  it("replaces a scalar", () => {
    expect(aSubject({ clearance: 250 }).clearance).toBe(250);
  });

  it("reaches into a nested object without restating its siblings", () => {
    const rule = aPolicyRule({ match: { tool: "delete_widget" } });
    expect(rule.match).toEqual({ toolkit: SAMPLE_TOOLKIT, tool: "delete_widget" });
  });

  it("replaces a free-form payload wholesale rather than merging into it", () => {
    // `output` holds caller-supplied data, not a record with fields. Merging it
    // would leave the default's sensitive identifier and injected note sitting
    // underneath a payload the caller wrote to be clean — a fixture that
    // contradicts its own description, and a UI snapshot that bakes it in.
    const request = aPostHookRequest({ output: { widget_id: "WID-1", status: "ok" } });
    expect(request.output).toEqual({ widget_id: "WID-1", status: "ok" });
  });

  it("replaces inputs wholesale too, so a fixture cannot smuggle a stale argument", () => {
    expect(aPreHookRequest({ inputs: { widget_id: "WID-2" } }).inputs).toEqual({
      widget_id: "WID-2",
    });
  });

  it("still merges a record, so a matcher override need not restate its siblings", () => {
    expect(aPostHookRequest({ tool: { name: "delete_widget" } }).tool).toEqual({
      name: "delete_widget",
      toolkit: SAMPLE_TOOLKIT,
      version: "1.0.0",
    });
  });

  it("replaces an array wholesale rather than appending to it", () => {
    // "These conditions", never "these as well as the defaults" — a fixture
    // that quietly kept a default condition would make a policy test lie.
    const rule = aPolicyRule({
      conditions: [{ input: "quantity", operator: "gt", value: 10 }],
    });
    expect(rule.conditions).toHaveLength(1);
    expect(rule.conditions[0]?.operator).toBe("gt");
  });

  it("still validates, so an invalid override fails at the fixture", () => {
    expect(() => aSubject({ clearance: -1 })).toThrow();
    expect(() => aPolicyRule({ effect: "shrug" as never })).toThrow();
  });

  it("leaves the defaults untouched for the next caller", () => {
    aPolicyRule({ match: { tool: "delete_widget" }, conditions: [] });
    expect(aPolicyRule().match.tool).toBe(SAMPLE_WRITE_TOOL);
    expect(aPolicyRule().conditions).toHaveLength(1);
  });
});

describe("aGovernanceEventSequence", () => {
  const events = aGovernanceEventSequence();

  it("is valid, in order, and deterministic", () => {
    expect(() => events.map((event) => GovernanceEvent.parse(event))).not.toThrow();
    expect(events.map((event) => event.ts)).toEqual(
      [...events.map((event) => event.ts)].sort(),
    );
    expect(aGovernanceEventSequence()).toEqual(events);
  });

  it("covers all three lanes and all three effects", () => {
    expect(new Set(events.map((event) => event.hook))).toEqual(
      new Set(["access", "pre", "post"]),
    );
    expect(new Set(events.map((event) => event.decision))).toEqual(
      new Set(["allow", "deny", "modify"]),
    );
  });

  it("gives the panel the shape a live /post modify arrives in: redactions[], no payload", () => {
    // The regression #101 fixed. The replay used to emit `before`/`after`, which
    // `apps/hooks` stopped sending on #16, so the demo everyone reads first
    // taught a contract the hook no longer speaks.
    const modified = events.filter((event) => event.decision === "modify");
    expect(modified).not.toHaveLength(0);
    for (const event of modified) {
      expect(event.redactions ?? []).not.toHaveLength(0);
      expect(Object.keys(event)).not.toContain("before");
      expect(Object.keys(event)).not.toContain("after");
    }
  });

  it("represents both redaction mechanisms, so the panel draws both annotations", () => {
    const modified = events.find((event) => event.decision === "modify");
    const records = modified?.redactions ?? [];

    // A named field path attributes to a rule alone; a pattern sweep also names
    // the scanner that matched. `apps/web`'s Post lane renders the two
    // differently, and a fixture carrying only one leaves the other undrawn.
    expect(records.some((record) => record.pattern_id === null)).toBe(true);
    expect(records.some((record) => record.pattern_id !== null)).toBe(true);
    expect(records.every((record) => record.path.startsWith("$"))).toBe(true);
  });

  it("puts no removed value anywhere in the replay", () => {
    // The fixture it replaced carried the sample identifier and the injected
    // sentence in plain sight, on records the panel draws on a projector.
    // `execution_id` is excluded because Arcade's is a long run of zeros here
    // and would match the sample identifier by coincidence, not by leak.
    const rendered = JSON.stringify(events, (key, value) =>
      key === "execution_id" ? undefined : value,
    );

    expect(rendered).not.toContain("0000000000");
    expect(rendered).not.toContain("Ignore all previous instructions");
  });

  it("uses distinct ids, so a keyed list does not collapse rows", () => {
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });
});

describe("aHookExchange", () => {
  const exchange = aHookExchange();

  it("describes one clean allowed call, with nothing to redact in its output", () => {
    // The regression this pins: `output` used to deep-merge, so the "allowed
    // call" exchange silently carried the read fixture's sensitive identifier
    // and injected note.
    expect(exchange.post.output).toEqual({ widget_id: "WID-1", status: "updated" });
  });

  it("correlates /pre and /post on one execution id", () => {
    // Arcade sends the same id on both, which is the only exact join the
    // control plane gets.
    expect(exchange.pre.execution_id).toBe(FIXTURE_EXECUTION_ID);
    expect(exchange.post.execution_id).toBe(exchange.pre.execution_id);
  });

  it("names one tool across all three payloads", () => {
    expect(exchange.pre.tool.name).toBe(SAMPLE_WRITE_TOOL);
    expect(exchange.post.tool.name).toBe(exchange.pre.tool.name);
    expect(Object.keys(exchange.access.toolkits)).toContain(SAMPLE_TOOLKIT);
  });
});

describe("aGrant", () => {
  it("carries a ceiling the GrantChecker can compare against", () => {
    const grant = aGrant();
    expect(grant.ceiling).toEqual({ input: "quantity", max: 95 });
    expect(grant.pinned_inputs).toEqual({ widget_id: "WID-1" });
  });

  it("names two different parties, so separation of duties has something to check", () => {
    const grant = aGrant();
    expect(grant.granted_by).not.toBe(grant.subject_id);
  });
});

describe("qualify", () => {
  it("builds the Toolkit.tool form GovernanceEvent.tool carries", () => {
    expect(qualify(SAMPLE_TOOLKIT, SAMPLE_WRITE_TOOL)).toBe("Widgets.update_widget");
  });
});

describe("the sample post-hook payload", () => {
  it("carries something to redact and something to strip", () => {
    // The redaction and injection modules both want a fixture with work to do.
    const output = aPostHookRequest().output as Record<string, string>;
    expect(output.identifier).toBeDefined();
    expect(output.notes).toMatch(/ignore all previous instructions/i);
  });

  it("is matched by the sample output rule's own pattern", () => {
    const rule = anOutputRule();
    const pattern = rule.patterns[0];
    expect(pattern).toBeDefined();
    const output = aPostHookRequest().output as Record<string, string>;
    expect(
      new RegExp(pattern?.regex as string, pattern?.flags).test(output.notes as string),
    ).toBe(true);
  });
});

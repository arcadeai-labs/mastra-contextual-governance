/**
 * GrantChecker (#10), from the outside.
 *
 * The security-critical module, so the tests are the most important in the
 * repo. Every assertion here is about what `checkGrant` returned — a validated
 * grant or a structured rejection — or about what the PolicyEngine does with
 * it. Nothing asserts a private helper, an evaluation order or a message's
 * exact wording.
 *
 * Table-driven: one row per way a grant can authorise a call or fail to. The
 * table is also checked for *coverage* — the row set must produce every `kind`
 * the rejection union declares, so adding a rejection reason without a row that
 * provokes it fails the suite. A rejection nothing exercises is the same
 * hazard as a rule that matches nothing.
 *
 * No mocks, no clock, no waiting: `now` is a `Date` this file constructs, and
 * the expiry rows sit either side of a boundary a millisecond apart.
 *
 * Fixtures come from `@cg/policy-schema` and describe an invented `Widgets`
 * toolkit, so nothing here names the demo's business domain.
 */
import { describe, expect, it } from "bun:test";

import {
  aGrant,
  aPolicyRule,
  aSubject,
  GRANT_REJECTION_KINDS,
  GrantRejectionReason as GrantRejectionReasonSchema,
  SAMPLE_READ_TOOL,
  SAMPLE_SUBJECT_IDS,
  SAMPLE_TOOLKIT,
  SAMPLE_WRITE_TOOL,
  type Grant,
  type GrantRejectionReason,
  type Inputs,
} from "@cg/policy-schema";

import {
  checkGrant,
  compilePolicy,
  consumeGrant,
  describeGrantRejection,
  evaluatePermission,
  isGrantRejection,
  selectGrant,
  type GrantRejection,
  type ToolRef,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// One call, one grant, one instant
// ---------------------------------------------------------------------------

/** The subject the default fixture grant empowers: clearance 50, asking for 95. */
const SUBJECT = aSubject();
const APPROVER = SAMPLE_SUBJECT_IDS.director;

const WRITE: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL };
const READ: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_READ_TOOL };

/** The call the fixture grant was issued for: resource WID-1, quantity 95. */
const CALL: Inputs = { widget_id: "WID-1", quantity: 95 };

/** Inside the fixture grant's window of [00:00:00.000Z, 00:15:00.000Z). */
const DURING = new Date("2026-01-01T00:05:00.000Z");
const ISSUED_AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date("2026-01-01T00:15:00.000Z");
const ONE_MS = 1;

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** Deep-partial overrides on the fixture grant, as `aGrant` takes them. */
type GrantOverrides = Parameters<typeof aGrant>[0];

type Row = {
  name: string;
  /** Overrides on the fixture grant. */
  grant?: GrantOverrides;
  /**
   * A grant that the `Grant` schema itself would refuse, for the checks that
   * guard against a malformed row arriving from the database rather than from
   * `parse()`. #12 reads the `grants` table; nothing guarantees every row in it
   * was written by this codebase.
   */
  raw?: (base: Grant) => Grant;
  inputs?: Inputs;
  /** The tool being called. The grant is scoped to `WRITE` unless overridden. */
  tool?: ToolRef;
  now?: Date;
  /** `"valid"`, or the `kind` the rejection must carry. */
  expect: "valid" | GrantRejectionReason["kind"];
  /** Fields the rejection reason must carry, so the audit row can explain itself. */
  reason?: Record<string, unknown>;
};

const rows: readonly Row[] = [
  // -- the happy path ------------------------------------------------------
  {
    name: "the grant it was issued for: same subject, tool, resource and amount",
    expect: "valid",
  },
  {
    name: "a retry below the granted ceiling",
    inputs: { widget_id: "WID-1", quantity: 1 },
    expect: "valid",
  },
  {
    name: "a retry exactly at the granted ceiling — a bound is inclusive",
    inputs: { widget_id: "WID-1", quantity: 95 },
    expect: "valid",
  },
  {
    name: "extra inputs the grant says nothing about are unconstrained",
    inputs: { widget_id: "WID-1", quantity: 95, note: "anything" },
    expect: "valid",
  },
  {
    name: "a grant with no numeric dimension ignores the numbers on the call",
    grant: { ceiling: null },
    inputs: { widget_id: "WID-1", quantity: 5_000_000 },
    expect: "valid",
  },
  {
    name: "unlimited uses within the window",
    grant: { uses_remaining: null },
    expect: "valid",
  },
  {
    name: "a nested pinned input matching structurally, whatever the key order",
    grant: {
      resource_id: "WID-1",
      pinned_inputs: { applicant: { id: "WID-1", region: "eu" } },
      ceiling: null,
    },
    inputs: { applicant: { region: "eu", id: "WID-1" } },
    expect: "valid",
  },

  {
    name: "a ceiling on a nested input, read as a dot path like a rule's condition",
    grant: {
      resource_id: null,
      pinned_inputs: {},
      ceiling: { input: "order.quantity", max: 95 },
    },
    inputs: { order: { quantity: 95 } },
    expect: "valid",
  },

  // -- how much: the replay this module exists to stop ---------------------
  {
    name: "a nested bounded input is bounded too",
    grant: {
      resource_id: null,
      pinned_inputs: {},
      ceiling: { input: "order.quantity", max: 95 },
    },
    inputs: { order: { quantity: 96 } },
    expect: "ceiling_exceeded",
    reason: { input: "order.quantity", max: 95, actual: 96 },
  },
  {
    name: "amount above the granted ceiling: $95K approved, $500K attempted",
    inputs: { widget_id: "WID-1", quantity: 500_000 },
    expect: "ceiling_exceeded",
    reason: { input: "quantity", max: 95, actual: 500_000 },
  },
  {
    name: "one over the ceiling",
    inputs: { widget_id: "WID-1", quantity: 96 },
    expect: "ceiling_exceeded",
    reason: { max: 95, actual: 96 },
  },
  {
    name: "the bounded input absent from the call bounds nothing",
    inputs: { widget_id: "WID-1" },
    expect: "ceiling_input_missing",
    reason: { input: "quantity" },
  },
  {
    name: "the bounded input as a numeric string is not a number",
    inputs: { widget_id: "WID-1", quantity: "95" },
    expect: "ceiling_input_not_numeric",
    reason: { input: "quantity", actual: "95" },
  },
  {
    name: "the bounded input as NaN is not a finite number",
    inputs: { widget_id: "WID-1", quantity: Number.NaN },
    expect: "ceiling_input_not_numeric",
    // Recorded as its name: JSON has no NaN, and `null` would be
    // indistinguishable from an input the call never sent.
    reason: { input: "quantity", actual: "NaN" },
  },

  // -- what: action and resource ------------------------------------------
  {
    name: "scope mismatch on action: a grant for one tool does not cover another",
    tool: READ,
    expect: "tool_mismatch",
    reason: {
      granted_for: `${SAMPLE_TOOLKIT}.${SAMPLE_WRITE_TOOL}`,
      called: `${SAMPLE_TOOLKIT}.${SAMPLE_READ_TOOL}`,
    },
  },
  {
    name: "scope mismatch on toolkit: same tool name, different toolkit",
    grant: { match: { toolkit: "Other", tool: SAMPLE_WRITE_TOOL } },
    expect: "tool_mismatch",
  },
  {
    name: "scope mismatch on resource: approved for WID-1, called against WID-9",
    inputs: { widget_id: "WID-9", quantity: 95 },
    expect: "resource_mismatch",
    reason: { input: "widget_id", granted_resource_id: "WID-1", actual: "WID-9" },
  },
  {
    name: "a resource replay is reported as such even when the amount is fine too",
    inputs: { widget_id: "WID-9", quantity: 1 },
    expect: "resource_mismatch",
  },
  {
    name: "the pinned resource absent from the call is recorded as null, not undefined",
    inputs: { quantity: 95 },
    expect: "resource_mismatch",
    reason: { input: "widget_id", actual: null },
  },
  {
    name: "a pinned input that is not the resource: mismatch reported as a pin",
    grant: {
      resource_id: null,
      pinned_inputs: { widget_id: "WID-1", region: "eu" },
      ceiling: null,
    },
    inputs: { widget_id: "WID-1", region: "us" },
    expect: "pinned_input_mismatch",
    reason: { input: "region", expected: "eu", actual: "us" },
  },

  // -- when ---------------------------------------------------------------
  {
    name: "expiry, one millisecond before the boundary: still valid",
    now: new Date(EXPIRES_AT.getTime() - ONE_MS),
    expect: "valid",
  },
  {
    name: "expiry, exactly at the boundary: expired — the window excludes its end",
    now: EXPIRES_AT,
    expect: "expired",
    reason: {
      expires_at: "2026-01-01T00:15:00.000Z",
      checked_at: "2026-01-01T00:15:00.000Z",
    },
  },
  {
    name: "expiry, one millisecond after the boundary",
    now: new Date(EXPIRES_AT.getTime() + ONE_MS),
    expect: "expired",
  },
  {
    name: "a week later, the classic replay",
    now: new Date("2026-01-08T00:05:00.000Z"),
    expect: "expired",
  },
  {
    name: "issue, exactly at the boundary: valid — the window includes its start",
    now: ISSUED_AT,
    expect: "valid",
  },
  {
    name: "issue, one millisecond before: a mis-stamped or forged record",
    now: new Date(ISSUED_AT.getTime() - ONE_MS),
    expect: "not_yet_valid",
    reason: { issued_at: "2026-01-01T00:00:00.000Z" },
  },
  {
    name: "revoked, whatever the window says",
    grant: { revoked_at: "2026-01-01T00:01:00.000Z" },
    expect: "revoked",
    reason: { revoked_at: "2026-01-01T00:01:00.000Z" },
  },

  // -- how many -----------------------------------------------------------
  {
    name: "single use: a grant with no uses left does not validate again",
    grant: { uses_remaining: 0 },
    expect: "consumed",
    reason: { uses_remaining: 0 },
  },

  // -- who ----------------------------------------------------------------
  {
    name: "requester equals approver: self-approval never validates",
    grant: { granted_by: SUBJECT.user_id },
    expect: "self_approved",
    reason: { subject_id: SUBJECT.user_id, granted_by: SUBJECT.user_id },
  },
  {
    name: "self-approval is refused before anything else, even for someone else's call",
    grant: { subject_id: APPROVER, granted_by: APPROVER },
    expect: "self_approved",
  },
  {
    name: "a grant issued to somebody else does not cover this subject",
    grant: { subject_id: APPROVER, granted_by: SAMPLE_SUBJECT_IDS.operator },
    expect: "subject_mismatch",
    reason: { granted_to: APPROVER, presented_by: SUBJECT.user_id },
  },

  // -- unenforceable: grants that would constrain nothing ------------------
  {
    name: "a wildcard tool is a standing permission, not a grant",
    grant: { match: { toolkit: SAMPLE_TOOLKIT, tool: "*" } },
    expect: "unenforceable",
  },
  {
    name: "a wildcard toolkit is refused too",
    grant: { match: { toolkit: "*", tool: SAMPLE_WRITE_TOOL } },
    expect: "unenforceable",
  },
  {
    name: "a resource nothing pins is decorative, so it is refused",
    grant: { resource_id: "WID-1", pinned_inputs: {}, ceiling: null },
    expect: "unenforceable",
  },
  {
    name: "pinning the input the ceiling bounds contradicts the ceiling",
    grant: {
      pinned_inputs: { widget_id: "WID-1", quantity: 95 },
      ceiling: { input: "quantity", max: 95 },
    },
    expect: "unenforceable",
  },
  {
    name: "the same contradiction reached through a dot path",
    grant: {
      resource_id: null,
      pinned_inputs: { order: { quantity: 95 } },
      ceiling: { input: "order.quantity", max: 95 },
    },
    inputs: { order: { quantity: 95 } },
    expect: "unenforceable",
  },
  {
    name: "a ceiling of Infinity bounds nothing (a row the schema would not write)",
    raw: (base) => ({ ...base, ceiling: { input: "quantity", max: Number.POSITIVE_INFINITY } }),
    expect: "unenforceable",
  },
  {
    name: "an unparseable expiry is refused, not treated as unexpiring",
    raw: (base) => ({ ...base, expires_at: "next week" }),
    expect: "unenforceable",
  },
  {
    name: "an unparseable issue timestamp is refused too",
    raw: (base) => ({ ...base, issued_at: "yesterday" }),
    expect: "unenforceable",
  },
];

function grantFor(row: Row): Grant {
  const base = aGrant(row.grant ?? {});
  return row.raw ? row.raw(base) : base;
}

function toolFor(row: Row): ToolRef {
  return row.tool ?? WRITE;
}

describe("checkGrant", () => {
  for (const row of rows) {
    it(row.name, () => {
      const grant = grantFor(row);
      const result = checkGrant({
        grant,
        subject: SUBJECT,
        tool: toolFor(row),
        inputs: row.inputs ?? CALL,
        now: row.now ?? DURING,
      });

      if (row.expect === "valid") {
        expect(isGrantRejection(result)).toBe(false);
        // A validated grant is the same grant, and it is the only thing the
        // engine will accept — asserted for real in "lifts the denial" below.
        expect((result as Grant).id).toBe(grant.id);
        return;
      }

      expect(isGrantRejection(result)).toBe(true);
      const rejection = result as GrantRejection;
      expect(rejection.reason.kind).toBe(row.expect);
      expect(rejection.grant_id).toBe(grant.id);
      if (row.reason) expect(rejection.reason).toMatchObject(row.reason);
    });
  }
});

describe("the table exercises every rejection the union declares", () => {
  it("provokes each kind at least once", () => {
    // A rejection reason no test provokes is the same hazard as a rule that
    // matches nothing: it looks like a control and might do nothing at all.
    const provoked = new Set(rows.map((row) => row.expect).filter((kind) => kind !== "valid"));
    const declared = [...GRANT_REJECTION_KINDS].sort();
    expect([...provoked].sort()).toEqual(declared);
  });
});

// ---------------------------------------------------------------------------
// What a validated grant is worth: the engine actually honours it
// ---------------------------------------------------------------------------

describe("a validated grant lifts the denial it was issued for", () => {
  // The fixture clearance rule — deny when quantity exceeds the subject's
  // clearance — with a reason `compilePolicy` accepts: a pre denial has to tell
  // the model what to call next, naming the tool the way the model's own tool
  // list spells it (#89). SUBJECT's clearance is 50; the call asks 95.
  //
  // `compilePolicy` runs here in a `describe` body rather than inside an `it`,
  // so a reason it rejects does not fail a test — it throws between tests, and
  // every `it` below silently never registers. That is how round 1 of this
  // slice's review found `Approvals.request_approval` still here: `bun test`
  // printed no failure and exited 1.
  const policy = compilePolicy({
    catalogue: {
      [SAMPLE_TOOLKIT]: { [SAMPLE_WRITE_TOOL]: ["widget_id", "quantity", "note?"] },
      Approvals: { RequestApproval: ["resource_id", "quantity", "justification"] },
    },
    rules: [
      aPolicyRule({
        reason:
          "Blocked. To proceed, call Approvals_RequestApproval with " +
          "resource_id={{inputs.widget_id}}, quantity={{inputs.quantity}} and " +
          "justification=<why>, then retry this call unchanged.",
      }),
    ],
  });

  const validated = () => {
    const result = checkGrant({
      grant: aGrant(),
      subject: SUBJECT,
      tool: WRITE,
      inputs: CALL,
      now: DURING,
    });
    if (isGrantRejection(result)) throw new Error(`expected a valid grant: ${result.message}`);
    return result;
  };

  it("denies the call with no grant at all", () => {
    const decision = evaluatePermission({ subject: SUBJECT, tool: WRITE, inputs: CALL, policy });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBe("rule.clearance");
  });

  it("allows the same call once the grant has been checked", () => {
    const decision = evaluatePermission({
      subject: SUBJECT,
      tool: WRITE,
      inputs: CALL,
      policy,
      grants: [validated()],
    });
    expect(decision.effect).toBe("allow");
    expect(decision.reason).toContain(aGrant().id);
  });

  it("still denies a call the checker rejected: the grant never reaches the engine", () => {
    const replay: Inputs = { widget_id: "WID-1", quantity: 500_000 };
    const result = checkGrant({
      grant: aGrant(),
      subject: SUBJECT,
      tool: WRITE,
      inputs: replay,
      now: DURING,
    });
    expect(isGrantRejection(result)).toBe(true);

    // The engine deliberately does not re-derive any of this, which is why the
    // checker is the only thing standing between the replay and an allow.
    const decision = evaluatePermission({
      subject: SUBJECT,
      tool: WRITE,
      inputs: replay,
      policy,
      grants: [],
    });
    expect(decision.effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Checking versus consuming
// ---------------------------------------------------------------------------

describe("checking is not consuming", () => {
  const args = { subject: SUBJECT, tool: WRITE, inputs: CALL, now: DURING } as const;

  it("checking twice validates twice: the checker has no side effect", () => {
    const grant = aGrant();
    expect(isGrantRejection(checkGrant({ ...args, grant }))).toBe(false);
    expect(isGrantRejection(checkGrant({ ...args, grant }))).toBe(false);
    expect(grant.uses_remaining).toBe(1);
  });

  it("does not mutate the grant or the call's inputs", () => {
    const grant = aGrant();
    const inputs: Inputs = { widget_id: "WID-1", quantity: 95 };
    const before = JSON.stringify({ grant, inputs });
    checkGrant({ ...args, grant, inputs });
    expect(JSON.stringify({ grant, inputs })).toBe(before);
  });

  it("a consumed grant does not validate again", () => {
    const grant = aGrant();
    expect(isGrantRejection(checkGrant({ ...args, grant }))).toBe(false);

    const spent = consumeGrant(grant);
    expect(spent.uses_remaining).toBe(0);

    const result = checkGrant({ ...args, grant: spent });
    expect(isGrantRejection(result)).toBe(true);
    expect((result as GrantRejection).reason.kind).toBe("consumed");
  });

  it("consuming leaves the original record alone — persisting is the caller's job", () => {
    const grant = aGrant();
    consumeGrant(grant);
    expect(grant.uses_remaining).toBe(1);
    expect(isGrantRejection(checkGrant({ ...args, grant }))).toBe(false);
  });

  it("spends one use at a time, and a multi-use grant survives the first", () => {
    const grant = aGrant({ uses_remaining: 2 });
    const once = consumeGrant(grant);
    expect(once.uses_remaining).toBe(1);
    expect(isGrantRejection(checkGrant({ ...args, grant: once }))).toBe(false);

    const twice = consumeGrant(once);
    expect(twice.uses_remaining).toBe(0);
    expect(isGrantRejection(checkGrant({ ...args, grant: twice }))).toBe(true);
  });

  it("leaves unlimited uses unlimited", () => {
    const grant = aGrant({ uses_remaining: null });
    expect(consumeGrant(grant).uses_remaining).toBeNull();
  });

  it("never goes negative: refusing a spent grant is the checker's job", () => {
    expect(consumeGrant(aGrant({ uses_remaining: 0 })).uses_remaining).toBe(0);
  });

  it("returns a plain grant the engine will not accept without a fresh check", () => {
    // The attestation does not survive consumption, so a consumed grant cannot
    // be passed straight back to `evaluatePermission`. This is a type-level
    // guarantee; what is observable at runtime is that re-checking refuses it.
    const spent = consumeGrant(aGrant());
    const result = checkGrant({ ...args, grant: spent });
    expect(isGrantRejection(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Several grants, and none
// ---------------------------------------------------------------------------

describe("selectGrant", () => {
  const args = { subject: SUBJECT, tool: WRITE, inputs: CALL, now: DURING } as const;

  it("no grants at all is an ordinary outcome, not an error", () => {
    const selection = selectGrant({ ...args, grants: [] });
    expect(selection.grant).toBeNull();
    expect(selection.rejected).toEqual([]);
  });

  it("finds the one grant that matches among several that do not", () => {
    const stale = aGrant({ id: "grant_stale", expires_at: "2026-01-01T00:01:00.000Z" });
    const otherTool = aGrant({
      id: "grant_other_tool",
      match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL },
    });
    const otherSubject = aGrant({
      id: "grant_other_subject",
      subject_id: APPROVER,
      granted_by: SAMPLE_SUBJECT_IDS.operator,
    });
    const spent = aGrant({ id: "grant_spent", uses_remaining: 0 });
    const good = aGrant({ id: "grant_good" });

    const selection = selectGrant({
      ...args,
      grants: [stale, otherTool, otherSubject, spent, good],
    });

    expect(selection.grant?.id).toBe("grant_good");
    // Every rejection is reported, so the audit row can show that a stale grant
    // was present and was not what authorised the call.
    expect(selection.rejected.map((r) => `${r.grant_id}:${r.reason.kind}`)).toEqual([
      "grant_stale:expired",
      "grant_other_tool:tool_mismatch",
      "grant_other_subject:subject_mismatch",
      "grant_spent:consumed",
    ]);
  });

  it("reports every rejection when nothing matches", () => {
    const selection = selectGrant({
      ...args,
      grants: [
        aGrant({ id: "spent", uses_remaining: 0 }),
        aGrant({ id: "revoked", revoked_at: "2026-01-01T00:01:00.000Z" }),
      ],
    });
    expect(selection.grant).toBeNull();
    expect(selection.rejected.map((r) => `${r.grant_id}:${r.reason.kind}`)).toEqual([
      "spent:consumed",
      "revoked:revoked",
    ]);
  });

  it("a grant valid for one call is not valid for the next one at a higher amount", () => {
    const grants = [aGrant()];
    expect(selectGrant({ ...args, grants }).grant?.id).toBe("grant_0001");
    expect(
      selectGrant({ ...args, grants, inputs: { widget_id: "WID-1", quantity: 500_000 } }).grant,
    ).toBeNull();
  });

  it("keeps the whole picture when several grants are valid", () => {
    const first = aGrant({ id: "grant_first" });
    const second = aGrant({ id: "grant_second" });
    const selection = selectGrant({ ...args, grants: [first, second] });
    expect(selection.grant?.id).toBe("grant_first");
    expect(selection.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The injected clock
// ---------------------------------------------------------------------------

describe("the clock is an argument", () => {
  const grant = aGrant();
  const args = { grant, subject: SUBJECT, tool: WRITE, inputs: CALL } as const;

  it("decides the same grant differently on the strength of `now` alone", () => {
    expect(isGrantRejection(checkGrant({ ...args, now: DURING }))).toBe(false);
    expect(isGrantRejection(checkGrant({ ...args, now: EXPIRES_AT }))).toBe(true);
  });

  it("records the instant it was given, not one it read", () => {
    const result = checkGrant({ ...args, now: new Date("2027-06-01T12:00:00.000Z") });
    const rejection = result as GrantRejection;
    expect(rejection.reason).toMatchObject({ checked_at: "2027-06-01T12:00:00.000Z" });
  });

  it("refuses an invalid Date rather than reporting it as a governance outcome", () => {
    expect(() => checkGrant({ ...args, now: new Date("not a date") })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Rejections an audit log and a panel can render
// ---------------------------------------------------------------------------

describe("every rejection is fit for the audit log", () => {
  const rejections: readonly GrantRejection[] = rows
    .filter((row) => row.expect !== "valid")
    .map((row) => {
      const result = checkGrant({
        grant: grantFor(row),
        subject: SUBJECT,
        tool: toolFor(row),
        inputs: row.inputs ?? CALL,
        now: row.now ?? DURING,
      });
      if (!isGrantRejection(result)) throw new Error(`expected a rejection: ${row.name}`);
      return result;
    });

  it("survives the round trip through JSON that SQLite and SSE both make", () => {
    for (const rejection of rejections) {
      const revived: unknown = JSON.parse(JSON.stringify(rejection.reason));
      expect(GrantRejectionReasonSchema.parse(revived)).toEqual(rejection.reason);
    }
  });

  it("explains itself in a sentence naming the values that produced it", () => {
    for (const rejection of rejections) {
      expect(rejection.message).toBe(describeGrantRejection(rejection.reason));
      expect(rejection.message.length).toBeGreaterThan(20);
      expect(rejection.message).not.toContain("undefined");
      expect(rejection.message).not.toContain("[object Object]");
    }
  });

  it("names the approved value and the attempted one on a ceiling replay", () => {
    const result = checkGrant({
      grant: aGrant(),
      subject: SUBJECT,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 500_000 },
      now: DURING,
    });
    // The one message a compliance reviewer reads out loud.
    expect((result as GrantRejection).message).toBe(
      'The grant authorises "quantity" up to 95, but the call passed 500000.',
    );
  });

  it("names both resources on a resource replay", () => {
    const result = checkGrant({
      grant: aGrant(),
      subject: SUBJECT,
      tool: WRITE,
      inputs: { widget_id: "WID-9", quantity: 95 },
      now: DURING,
    });
    expect((result as GrantRejection).message).toContain("WID-1");
    expect((result as GrantRejection).message).toContain("WID-9");
  });
});

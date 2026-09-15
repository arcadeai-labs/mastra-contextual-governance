/**
 * ApproverRouter (#9), driven by the cross-language case file at
 * `packages/policy-schema/contract/approver-routing-cases.json`.
 *
 * The rows used to live here as a TypeScript literal. They moved out on #18,
 * which reimplements this rule in Python for `tools/approvals`: two
 * implementations of one rule in two languages is a real divergence risk, and
 * the cheap defence is that both read the same file. `tools/approvals/tests/
 * test_routing.py` loads exactly these rows. A row added here is checked on
 * both sides; a row deleted here stops being checked on both sides.
 *
 * The roster is the demo cast from DESIGN.md, because "$95K goes to Charlie, not
 * Michael" is a line the presenter says out loud and this is where it is pinned.
 */
import { describe, expect, it } from "bun:test";
import { Subject } from "@cg/policy-schema";
import { routeApproval, type RoutingResult } from "../src/approver-router.ts";
import cases from "@cg/policy-schema/contract/approver-routing-cases.json" with { type: "json" };

/** The file's `subjects` map, parsed once, so every case shares one object per key. */
const subjects: Record<string, Subject> = Object.fromEntries(
  Object.entries(cases.subjects).map(([key, value]) => [key, Subject.parse(value)]),
);

const roster = (keys: readonly string[]): Subject[] =>
  keys.map((key) => {
    const subject = subjects[key];
    if (subject === undefined) throw new Error(`case file names an unknown subject: ${key}`);
    return subject;
  });

/** JSON cannot hold a non-finite number, so the file spells them. */
const NON_FINITE: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
};
const amountOf = (raw: number | string): number =>
  typeof raw === "number" ? raw : (NON_FINITE[raw] ?? Number.NaN);

describe("the shared case file is actually loaded", () => {
  // A case file that failed to load would make every loop below vacuous, which
  // is the same failure mode as a policy rule that matches nothing.
  it("has cases and invalid amounts to run", () => {
    expect(cases.cases.length).toBeGreaterThan(0);
    expect(cases.invalid_amounts.length).toBeGreaterThan(0);
  });
});

describe("routeApproval", () => {
  for (const row of cases.cases) {
    it(row.name, () => {
      const result = routeApproval(row.amount, row.requester, roster(row.roster));

      expect(result.required_clearance).toBe(row.amount);
      expect(result.candidates.map((s) => s.user_id)).toEqual([...row.candidates]);

      if (row.approver === null) {
        expect(result.outcome).toBe("no_eligible_approver");
        expect(result.approver).toBeNull();
      } else {
        expect(result.outcome).toBe("routed");
        expect(result.approver?.user_id).toBe(row.approver);
        // The approver is always the head of the candidate list.
        expect(result.approver).toBe(result.candidates[0] as Subject);
      }
    });
  }
});

describe("routeApproval is pure", () => {
  const cast = () => roster(cases.cast);
  const dana = subjects.dana as Subject;
  const riley = subjects.riley as Subject;

  it("does not mutate the roster it is given", () => {
    const given = cast();
    const before = [...given];
    routeApproval(95_000, dana.user_id, given);
    expect(given).toEqual(before);
  });

  it("returns the same answer for the same inputs", () => {
    const first = routeApproval(95_000, dana.user_id, cast());
    const second = routeApproval(95_000, dana.user_id, cast());
    expect(second).toEqual(first);
  });

  it("returns the roster's own Subject objects, not copies", () => {
    const result = routeApproval(95_000, dana.user_id, cast()) as Extract<
      RoutingResult,
      { outcome: "routed" }
    >;
    expect(result.approver).toBe(riley);
  });
});

describe("invalid amounts are programming errors, not routing outcomes", () => {
  for (const row of cases.invalid_amounts) {
    it(`rejects ${row.name} rather than reporting no eligible approver`, () => {
      expect(() =>
        routeApproval(amountOf(row.amount), subjects.dana!.user_id, roster(cases.cast)),
      ).toThrow(RangeError);
    });
  }
});

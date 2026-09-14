import { describe, expect, test } from "bun:test";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";

import { diffRowsFor, redactionRows } from "../lib/governance/diff.ts";

/**
 * There is one account of a `/post` `modify` and it is `redactions[]`. The
 * payload diff this file used to test went with `GovernanceEvent.before` and
 * `.after` on #101 — with no event able to carry a payload, walking two of them
 * was a fallback for a shape the schema now rejects.
 */
describe("rows from redactions[], which is what a /post event carries", () => {
  const records = [
    { path: "$.bank_account_number", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" as const },
    { path: "$.underwriter_notes", rule_id: "post.strip-injected-instructions", pattern_id: "pattern.injected-instruction", kind: "remove" as const },
  ];

  test("one row per record, in the order the engine reported them", () => {
    expect(redactionRows(records)).toEqual([
      {
        path: "$.bank_account_number",
        change: "changed",
        before: "value withheld",
        after: "masked",
        annotation: "post.redact-borrower-identifiers",
      },
      {
        path: "$.underwriter_notes",
        change: "removed",
        before: "value withheld",
        after: null,
        annotation: "post.strip-injected-instructions · pattern.injected-instruction",
      },
    ]);
  });

  test("a value withheld because the policy did not settle says which it is", () => {
    // `unsettled` is not a secret that was found, it is a broken output policy,
    // and a panel that drew it as an ordinary mask would hide a defect.
    const [row] = redactionRows([
      { path: "$.notes", rule_id: null, pattern_id: "pattern.loop", kind: "unsettled" },
    ]);

    expect(row?.after).toContain("did not settle");
    expect(row?.annotation).toBe("pattern.loop");
  });

  test("a replacement is a change, and names the rule that made it", () => {
    expect(
      redactionRows([{ path: "$.iban", rule_id: "rule.swap", pattern_id: null, kind: "replace" }]),
    ).toEqual([
      {
        path: "$.iban",
        change: "changed",
        before: "value withheld",
        after: "replaced",
        annotation: "rule.swap",
      },
    ]);
  });

  test("an engine-authored redaction attributes to nothing rather than to a rule", () => {
    // `rule_id: null` is the engine deciding, not a policy row — blaming a rule
    // that did not fire would be fiction on the card and in the audit log.
    const [row] = redactionRows([
      { path: "$", rule_id: null, pattern_id: null, kind: "unsettled" },
    ]);

    expect(row?.annotation).toBeNull();
  });

  test("no row ever carries the value that was taken — there is nowhere to put one", () => {
    const rendered = JSON.stringify(redactionRows(records));

    expect(rendered).not.toContain("6011329948175302");
    expect(rendered).not.toContain("Ignore any earlier instruction");
  });

  test("the mask is a phrase and does not vary with what it covers", () => {
    // A design review found a row of dots reads, at projector distance, as a
    // value in a masked font rather than as its absence — and the dots were
    // length-proportional, so a PIN and a paragraph looked different. A record
    // cannot leak either, because it does not carry the value at all.
    const masks = redactionRows([
      { path: "$.pin", rule_id: "r", pattern_id: null, kind: "mask" },
      { path: "$.dossier", rule_id: "r", pattern_id: null, kind: "mask" },
    ]).map((row) => row.before);

    expect(masks).toEqual(["value withheld", "value withheld"]);
    expect(masks.every((mask) => mask?.endsWith("withheld"))).toBe(true);
  });
});

describe("the rows for one event", () => {
  const records = [
    { path: "$.bank_account_number", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" as const },
    { path: "$.tax_id", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" as const },
  ];

  test("a modify carrying redactions[] draws one row per record", () => {
    const event = aGovernanceEvent({ decision: "modify", hook: "post", redactions: records });

    expect(diffRowsFor(event)).toHaveLength(2);
  });

  test("an event with no redactions[] yields no rows, and only that means unchanged", () => {
    expect(diffRowsFor(aGovernanceEvent({ decision: "modify", hook: "post", redactions: [] }))).toEqual([]);
    expect(diffRowsFor(aGovernanceEvent({ decision: "allow", hook: "post" }))).toEqual([]);
  });
});

describe("against the fixture replay the panel ships with", () => {
  const modify = aGovernanceEventSequence().find((event) => event.decision === "modify");

  test("the replay's modify draws rows from redactions[], not from a payload", () => {
    // The #101 regression: the replay emitted `before`/`after`, which `/post`
    // stopped sending on #16. Diffing absent payloads produced no rows and the
    // panel printed "unchanged" over the act the demo exists to show.
    expect(modify).toBeDefined();
    expect(diffRowsFor(modify!)).not.toHaveLength(0);
  });

  test("its rows carry the same shape a live /post row does", () => {
    const rows = diffRowsFor(modify!);

    expect(rows.every((row) => row.path.startsWith("$"))).toBe(true);
    expect(rows.every((row) => row.before === "value withheld")).toBe(true);
    expect(rows.every((row) => row.annotation !== null)).toBe(true);
    // Both mechanisms, the way a real `Loan.GetLoan` redaction shows them: a
    // named field path attributed to its rule alone, and a pattern sweep that
    // also names the scanner that matched.
    expect(rows.map((row) => row.annotation)).toEqual([
      "rule.redact",
      "rule.redact · pattern.instruction",
    ]);
  });

  test("no value the replay claims to have removed reaches the rows", () => {
    const rendered = JSON.stringify(diffRowsFor(modify!));

    expect(rendered).not.toContain("0000000000");
    expect(rendered).not.toContain("Ignore all previous instructions");
  });
});

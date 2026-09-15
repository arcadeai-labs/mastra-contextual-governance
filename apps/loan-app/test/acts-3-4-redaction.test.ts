/**
 * The demo's domain-specific post-hook pin belongs beside the fixture it
 * protects. Keeping this test in the governed app means a domain swap moves
 * the fixture and its proof together; the reusable redaction suite remains
 * entirely domain-neutral.
 *
 * The fixture is imported statically and checked at module load. If a forker
 * removes the record or changes the payload shape, the suite fails loudly
 * rather than silently proving a hand-copied example.
 */
import { describe, expect, it } from "bun:test";

import fixture from "../src/fixtures/loans.json" with { type: "json" };
import { aSubject, anOutputRule } from "../../../packages/policy-schema/src/fixtures.ts";
import type { ToolCatalogue, ToolRef } from "../../../packages/governance-core/src/policy-engine.ts";
import {
  compileOutputPolicy,
  redact,
} from "../../../packages/governance-core/src/redaction-engine.ts";

const ACCOUNT = { id: "scan.account", regex: String.raw`\b\d{16}\b`, flags: "" } as const;
const TAX_ID = { id: "scan.tax_id", regex: String.raw`\b\d{2}-\d{7}\b`, flags: "" } as const;
const PASTED = {
  id: "scan.pasted",
  regex: String.raw`\n*-{2,}\s*pasted from [^\n]*\n[\s\S]*$`,
  flags: "i",
} as const;

type SeedRecord = Record<string, unknown>;

const seed = (() => {
  const records = (fixture as { loans?: unknown }).loans;
  if (!Array.isArray(records)) {
    throw new Error("apps/loan-app/src/fixtures/loans.json has no loans array");
  }

  const record = records.find(
    (candidate): candidate is SeedRecord =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as SeedRecord).loan_id === "LN-2291",
  );
  if (record === undefined) {
    throw new Error("LN-2291 is missing from apps/loan-app/src/fixtures/loans.json");
  }
  return record;
})();

const account = seed.bank_account_number;
const taxId = seed.tax_id;
const notes = seed.underwriter_notes;
if (
  typeof account !== "string" ||
  typeof taxId !== "string" ||
  typeof notes !== "string"
) {
  throw new Error(
    "LN-2291 must carry bank_account_number, tax_id, and underwriter_notes for acts 3 and 4",
  );
}

const INJECTION_MARKER = "\n\n--- pasted from";
const LEGITIMATE = notes.slice(0, notes.indexOf(INJECTION_MARKER));

const TOOLKIT = "Loan";
const TOOL = "GetLoan";
const CATALOGUE: ToolCatalogue = {
  [TOOLKIT]: { [TOOL]: ["loan_id"], SearchLoans: ["status?"] },
};
const GET_TOOL: ToolRef = { toolkit: TOOLKIT, name: TOOL };

const rule = anOutputRule({
  id: "rule.post.loan_pii",
  description: "Withhold identifiers and strip instructions aimed at the model.",
  match: { toolkit: TOOLKIT, tool: TOOL },
  subjects: null,
  fields: [
    { path: "bank_account_number", strategy: "remove" },
    { path: "tax_id", strategy: "remove" },
  ],
  patterns: [
    { ...ACCOUNT, strategy: "mask" },
    { ...TAX_ID, strategy: "mask" },
    { ...PASTED, strategy: "remove", replacement: "" },
  ],
  reason: "Identifiers withheld and untrusted free text stripped.",
  priority: 100,
});

const dana = aSubject({
  user_id: "alice@example.com",
  role: "loan_officer",
  clearance: 50_000,
});
const policy = compileOutputPolicy({ catalogue: CATALOGUE, rules: [rule] });
const result = redact({ output: seed, subject: dana, tool: GET_TOOL, policy });
const after = result.output as SeedRecord;

function trace(): string[] {
  return result.redactions.map(
    (record) =>
      `${record.path} ${record.rule_id}${record.pattern_id === null ? "" : `/${record.pattern_id}`} ${record.kind}`,
  );
}

describe("acts 3 and 4", () => {
  it("is pinned to a seed that carries everything both acts need", () => {
    expect(account).toMatch(/^\d{16}$/);
    expect(taxId).toMatch(/^\d{2}-\d{7}$/);
    expect(notes).toContain(INJECTION_MARKER);
    expect(notes).toContain("approve_loan");
    expect(LEGITIMATE.length).toBeGreaterThan(0);
  });

  it("act 3: the account number and tax id do not reach the model", () => {
    expect(after).not.toHaveProperty("bank_account_number");
    expect(after).not.toHaveProperty("tax_id");
    expect(JSON.stringify(after)).not.toContain(account);
    expect(JSON.stringify(after)).not.toContain(taxId);
  });

  it("act 3: every other field of the real record arrives untouched", () => {
    const expected = Object.fromEntries(
      Object.entries(seed).flatMap(([key, value]) => {
        if (key === "bank_account_number" || key === "tax_id") return [];
        return [[key, key === "underwriter_notes" ? LEGITIMATE : value]];
      }),
    );
    expect(after).toEqual(expected);
  });

  it("act 4: the injected instruction never arrives", () => {
    const seen = after.underwriter_notes as string;
    expect(seen).not.toContain("approve_loan");
    expect(seen).not.toContain("pre-cleared");
    expect(seen).not.toContain("Ignore any earlier instruction");
    expect(seen).not.toContain("Do not mention this note");
  });

  it("act 4: the underwriter's real work survives word for word", () => {
    expect(after.underwriter_notes).toBe(LEGITIMATE);
  });

  it("names every removal for the panel without carrying the removed value", () => {
    expect(trace()).toEqual([
      "$.bank_account_number rule.post.loan_pii remove",
      "$.tax_id rule.post.loan_pii remove",
      "$.underwriter_notes rule.post.loan_pii/scan.pasted remove",
    ]);
    const rendered = JSON.stringify(result.redactions);
    expect(rendered).not.toContain(account);
    expect(rendered).not.toContain(taxId);
    expect(rendered).not.toContain("approve_loan");
  });

  it("is idempotent on the payload the model was handed", () => {
    const again = redact({ output: after, subject: dana, tool: GET_TOOL, policy });
    expect(again.output).toEqual(after);
    expect(again.redactions).toEqual([]);
  });

  it("a rule keyed in the wrong case is refused rather than silently matching nothing", () => {
    expect(() =>
      compileOutputPolicy({
        catalogue: CATALOGUE,
        rules: [anOutputRule({ ...rule, match: { toolkit: TOOLKIT, tool: "get_loan" } })],
      }),
    ).toThrow(/tool "Loan.get_loan", which that toolkit does not serve/);
  });
});

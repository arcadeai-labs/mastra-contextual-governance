/**
 * governance.db: seeding, persistence, the revision counter, the append-only
 * audit log.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compilePolicy } from "@cg/governance-core";

import { count as auditCount, byExecution, newEventId, recent, record } from "../src/audit-log.ts";
import {
  counts,
  hasSchema,
  loadSeed,
  openGovernance,
  readOutputRules,
  readPolicy,
  readRevision,
  seed,
  type SeedOptions,
} from "../src/policy-store.ts";

const OPTIONS: SeedOptions = { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} };

const fresh = () => openGovernance(":memory:", OPTIONS);

const anEvent = (overrides: Partial<Parameters<typeof record>[1][number]> = {}) => ({
  id: newEventId(),
  ts: new Date().toISOString(),
  execution_id: "tc_1",
  hook: "pre" as const,
  user_id: "dana.okafor@bank.example",
  tool: "Loan.ApproveLoan",
  decision: "deny" as const,
  reason: "because",
  rule_id: "pre.approve-within-clearance",
  ...overrides,
});

describe("the seed", () => {
  test("compiles against the configured toolkit names", () => {
    const data = loadSeed(OPTIONS);
    expect(() => compilePolicy({ catalogue: data.catalogue, rules: data.policy_rules })).not.toThrow();
  });

  test("carries the cast with the limits DESIGN.md names", () => {
    const byName = Object.fromEntries(loadSeed(OPTIONS).subjects.map((s) => [s.display_name, s]));
    expect(byName["Dana Okafor"]).toMatchObject({ role: "loan_officer", clearance: 50_000 });
    expect(byName["Sam Reyes"]).toMatchObject({ role: "credit_analyst", clearance: 0 });
    expect(byName["Riley Chen"]).toMatchObject({ role: "vp_credit", clearance: 250_000 });
    expect(byName["Morgan Ellis"]).toMatchObject({ role: "chief_credit_officer", clearance: 5_000_000 });
  });

  test("uses the same fallback emails as apps/idp, the join key", async () => {
    const people = (await import("../../idp/src/fixtures/people.json")).default.people;
    const ours = loadSeed(OPTIONS).subjects.map((s) => s.user_id).sort();
    expect(ours).toEqual(people.map((p) => p.email).sort());
  });

  test("substitutes PERSONA_<KEY>_EMAIL at seed time", () => {
    const data = loadSeed({ ...OPTIONS, personaEmails: { dana: "dana@corp.example" } });
    expect(data.subjects.find((s) => s.display_name === "Dana Okafor")?.user_id).toBe("dana@corp.example");
    expect(data.subjects.find((s) => s.display_name === "Sam Reyes")?.user_id).toBe("sam.reyes@bank.example");
  });

  // #58. The override carries whatever capitalisation the Arcade account was
  // invited under, and `apps/idp` now stores the same person lowercase. A
  // roster seeded `Dana.Okafor@…` would be one `subjectKey` can never hit, so
  // every call Dana makes would be denied as an unregistered subject.
  test("lowercases the address a PERSONA_<KEY>_EMAIL override carries", () => {
    const data = loadSeed({ ...OPTIONS, personaEmails: { dana: "Dana.Okafor@MegaForce.Tech" } });

    expect(data.subjects.find((s) => s.display_name === "Dana Okafor")?.user_id).toBe(
      "dana.okafor@megaforce.tech",
    );
    expect(data.subjects.every((s) => s.user_id === s.user_id.toLowerCase())).toBe(true);
  });

  test("keys every rule and the catalogue on the configured toolkit names, not on literals", () => {
    const data = loadSeed({ ...OPTIONS, loanToolkit: "LoanBook", approvalsToolkit: "Escalations" });
    expect(Object.keys(data.catalogue).sort()).toEqual(["Escalations", "LoanBook"]);
    // Every rule is keyed on one of the two configured names and on no
    // literal: a rule left pointing at "$LOAN", or at the default "Loan" when
    // the deployment calls it something else, would match nothing.
    expect([...new Set(data.policy_rules.map((r) => r.match.toolkit))].sort()).toEqual([
      "Escalations",
      "LoanBook",
    ]);
    expect(data.output_rules.every((r) => r.match.toolkit === "LoanBook")).toBe(true);
    const escalation = data.policy_rules.find((r) => r.hook === "pre");
    expect(escalation?.reason).toContain("Escalations.RequestApproval");
    expect(escalation?.reason).toContain("LoanBook.ApproveLoan");
    expect(JSON.stringify(data)).not.toContain("$LOAN");
    expect(JSON.stringify(data)).not.toContain("$APPROVALS");
    expect(() => compilePolicy({ catalogue: data.catalogue, rules: data.policy_rules })).not.toThrow();
  });

  test("keys tools on the PascalCase names arcade-mcp actually produces", () => {
    const tools = Object.keys(loadSeed(OPTIONS).catalogue.Loan ?? {}).sort();
    expect(tools).toEqual(["ApproveLoan", "DenyLoan", "GetLoan", "SearchLoans"]);
  });
});

describe("seeding", () => {
  test("bootstraps the fixture into an empty database", () => {
    const db = fresh();
    expect(counts(db)).toMatchObject({
      subjects: 4,
      catalogue: 6,
      policy_rules: 6,
      output_rules: 2,
      grants: 0,
      approval_requests: 0,
      audit_log: 0,
    });
    // Two since #16: the borrower-identifier fields, conditioned on clearance,
    // and the injected-instruction sweep, which is conditioned on nobody.
    expect(readOutputRules(db).map((rule) => rule.id)).toEqual([
      "post.redact-borrower-identifiers",
      "post.strip-injected-instructions",
    ]);
  });

  test("a seed that fails leaves no schema, so the next boot retries", () => {
    const db = new Database(":memory:");
    const data = loadSeed(OPTIONS);
    const duplicated = { ...data, subjects: [...data.subjects, data.subjects[0]!] };

    expect(() => seed(db, duplicated)).toThrow(/UNIQUE/);
    expect(hasSchema(db)).toBe(false);

    seed(db, data);
    expect(counts(db).subjects).toBe(4);
  });

  test("leaves an existing database alone — a restart is not a reset", () => {
    const path = join(tmpdir(), `cg-governance-${crypto.randomUUID()}`, "governance.db");

    const first = openGovernance(path, OPTIONS);
    first.run("UPDATE subjects SET clearance = 100000 WHERE display_name = 'Dana Okafor'");
    record(first, [anEvent()]);
    first.close();

    const second = openGovernance(path, OPTIONS);
    const dana = readPolicy(second).subjects.find((s) => s.display_name === "Dana Okafor");
    const audit = auditCount(second);
    second.close();
    rmSync(dirname(path), { recursive: true, force: true });

    expect(dana?.clearance).toBe(100_000);
    expect(audit).toBe(1);
  });
});

describe("the revision counter", () => {
  test("moves on every write to a cached table, from any statement", () => {
    const db = fresh();
    const r0 = readRevision(db);

    db.run("UPDATE subjects SET clearance = 1 WHERE display_name = 'Sam Reyes'");
    const r1 = readRevision(db);
    db.run("UPDATE policy_rules SET enabled = 0 WHERE id = 'access.analysts-cannot-see-approve'");
    const r2 = readRevision(db);
    db.run("INSERT INTO catalogue (toolkit, tool, arguments) VALUES ('Loan', 'Ping', '[]')");
    const r3 = readRevision(db);

    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(r3).toBeGreaterThan(r2);
  });

  test("does not move on an audit write — those are not policy", () => {
    const db = fresh();
    const before = readRevision(db);
    record(db, [anEvent()]);
    expect(readRevision(db)).toBe(before);
  });

  test("is visible across connections to the same file", () => {
    const path = join(tmpdir(), `cg-governance-${crypto.randomUUID()}`, "governance.db");
    const server = openGovernance(path, OPTIONS);
    const before = readRevision(server);

    // A presenter's sqlite3 shell.
    const shell = new Database(path);
    shell.run("UPDATE subjects SET clearance = 100000 WHERE display_name = 'Dana Okafor'");
    shell.close();

    const after = readRevision(server);
    server.close();
    rmSync(dirname(path), { recursive: true, force: true });
    expect(after).toBeGreaterThan(before);
  });
});

describe("readPolicy", () => {
  test("refuses a hand-edited row that no longer conforms, loudly", () => {
    const db = fresh();
    db.run(`UPDATE policy_rules SET subjects = '{"role": ["credit_analyst"]}' WHERE hook = 'access'`);
    // `role` is not `roles`; the strict schema refuses it rather than treating
    // the rule as applying to everyone.
    expect(() => readPolicy(db)).toThrow(/role/);
  });

  test("reads back exactly what was seeded", () => {
    const db = fresh();
    const data = loadSeed(OPTIONS);
    const snapshot = readPolicy(db);
    expect(snapshot.catalogue).toEqual(data.catalogue);
    expect(snapshot.rules).toEqual([...data.policy_rules].sort((a, b) => a.priority - b.priority));
    expect(snapshot.subjects.map((s) => s.user_id).sort()).toEqual(data.subjects.map((s) => s.user_id).sort());
  });
});

describe("the audit log", () => {
  test("appends and reads back in GovernanceEvent shape", () => {
    const db = fresh();
    const event = anEvent({ before: { a: 1 }, after: { a: "[REDACTED]" } });
    record(db, [event]);
    expect(recent(db)).toEqual([event]);
    expect(byExecution(db, "tc_1")).toEqual([event]);
  });

  test("is append-only: the database itself refuses UPDATE and DELETE", () => {
    const db = fresh();
    record(db, [anEvent()]);
    expect(() => db.run("UPDATE audit_log SET decision = 'allow'")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM audit_log")).toThrow(/append-only/);
    expect(auditCount(db)).toBe(1);
  });

  test("writes a batch atomically", () => {
    const db = fresh();
    const good = anEvent();
    const bad = anEvent({ ts: "not a timestamp" });
    expect(() => record(db, [good, bad])).toThrow();
    expect(auditCount(db)).toBe(0);
  });

  test("event ids are short, unambiguous, and parseable as correlation tokens", () => {
    const ids = new Set(Array.from({ length: 1000 }, newEventId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^evt_[0-9a-hj-km-np-tv-z]{10}$/);
  });
});

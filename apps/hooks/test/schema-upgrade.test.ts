/**
 * A `governance.db` from before a table existed must still open, keep its
 * rows, and gain the table — the disk persists across deploys (#29), so every
 * schema change after the first meets a database that predates it.
 *
 * #60: this went wrong in production. `hasSchema` probed for one table
 * (`policy_rules`) as a stand-in for a schema version, so the disk that
 * predated `approval_requests` read as "already seeded", never gained the
 * table, and `cg-hooks` crash-looped on `no such table: approval_requests`
 * from a health-count helper at boot.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { count as auditCount, newEventId, record, recent } from "../src/audit-log.ts";
import {
  SCHEMA_VERSION,
  counts,
  hasSchema,
  loadSeed,
  openGovernance,
  readPolicy,
  readSchemaVersion,
  seed,
  type SeedOptions,
} from "../src/policy-store.ts";

const OPTIONS: SeedOptions = {
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
};

/** A fresh directory per test; the caller removes it. */
function tempPath(tag: string): string {
  const path = join(tmpdir(), `cg-governance-${tag}-${crypto.randomUUID()}`, "governance.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function withPath(tag: string, body: (path: string) => void): void {
  const path = tempPath(tag);
  try {
    body(path);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

/**
 * A disk as it stood before #52 added `approval_requests`: `policy_rules`
 * exists and carries rows, `PRAGMA user_version` is the SQLite default 0
 * because nothing recorded one. Only the columns the assertions read are
 * spelled out; this is a stand-in for an old disk, not a museum copy.
 */
const SCHEMA_BEFORE_APPROVAL_REQUESTS = `
  CREATE TABLE subjects (
    user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
    clearance REAL NOT NULL CHECK (clearance >= 0), attributes TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE catalogue (
    toolkit TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (toolkit, tool)
  );
  CREATE TABLE policy_rules (
    id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '',
    hook TEXT NOT NULL CHECK (hook IN ('access', 'pre')),
    toolkit TEXT NOT NULL, tool TEXT NOT NULL, subjects TEXT,
    conditions TEXT NOT NULL DEFAULT '[]',
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    reason TEXT NOT NULL, priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  CREATE TABLE output_rules (
    id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '',
    toolkit TEXT NOT NULL, tool TEXT NOT NULL, subjects TEXT,
    fields TEXT NOT NULL DEFAULT '[]', patterns TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL, priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL,
    execution_id TEXT NOT NULL DEFAULT '',
    hook TEXT NOT NULL CHECK (hook IN ('access', 'pre', 'post')),
    user_id TEXT NOT NULL, tool TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'modify')),
    reason TEXT NOT NULL, rule_id TEXT, before TEXT, after TEXT
  );
  CREATE TABLE policy_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
  );
  INSERT INTO policy_revision (id, revision) VALUES (1, 7);

  INSERT INTO subjects (user_id, display_name, role, clearance)
    VALUES ('dana.okafor@bank.example', 'Dana Okafor', 'loan_officer', 100000);
  INSERT INTO catalogue (toolkit, tool, arguments)
    VALUES ('Loan', 'GetLoan', '["loan_id"]');
  INSERT INTO policy_rules (id, hook, toolkit, tool, effect, reason, priority)
    VALUES ('access.stale-fixture', 'access', 'Loan', '*', 'allow', 'from the old disk', 100);
  INSERT INTO audit_log (id, ts, hook, user_id, tool, decision, reason)
    VALUES ('ev_old', '2026-01-01T00:00:00.000Z', 'pre', 'dana.okafor@bank.example',
            'Loan.GetLoan', 'allow', 'recorded before the upgrade');
`;

function writeOldDisk(path: string): void {
  const legacy = new Database(path, { create: true });
  legacy.exec(SCHEMA_BEFORE_APPROVAL_REQUESTS);
  // The SQLite default, and what every disk written before #60 reads back.
  expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(0);
  legacy.close();
}

describe("a database written before a table existed", () => {
  test("gains the table, with no rows inserted into it", () => {
    withPath("old", (path) => {
      writeOldDisk(path);

      const db = openGovernance(path, OPTIONS);
      try {
        // The bug, stated as an assertion: the table the old disk lacks.
        const tally = counts(db);
        expect(tally.approval_requests).toBe(0);
        expect(tally.grants).toBe(0);

        // ...and it is a real table, not an absence that counted as zero.
        expect(
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'",
            )
            .get(),
        ).not.toBeNull();

        // Not reseeded. The old disk's single rule and raised clearance survive;
        // the fixture's six rules and four subjects are nowhere near it.
        expect(tally.policy_rules).toBe(1);
        expect(tally.subjects).toBe(1);
        expect(readPolicy(db).subjects[0]?.clearance).toBe(100_000);
        expect(auditCount(db)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("records the version, and a second open is a no-op", () => {
    withPath("stamp", (path) => {
      writeOldDisk(path);

      const first = openGovernance(path, OPTIONS);
      expect(readSchemaVersion(first)).toBe(SCHEMA_VERSION);
      const revision = first.query<{ revision: number }, []>(
        "SELECT revision FROM policy_revision WHERE id = 1",
      ).get()?.revision;
      first.close();

      // `INSERT OR IGNORE` on policy_revision: the old disk's counter is kept,
      // not reset to 1. Resetting it would make every cached policy look stale
      // exactly once per deploy.
      expect(revision).toBe(7);

      const second = openGovernance(path, OPTIONS);
      try {
        expect(readSchemaVersion(second)).toBe(SCHEMA_VERSION);
        expect(counts(second).policy_rules).toBe(1);
        expect(
          second.query<{ revision: number }, []>(
            "SELECT revision FROM policy_revision WHERE id = 1",
          ).get()?.revision,
        ).toBe(7);
      } finally {
        second.close();
      }
    });
  });

  test("gains the triggers too, so a live edit still bumps the revision", () => {
    withPath("triggers", (path) => {
      writeOldDisk(path);

      const db = openGovernance(path, OPTIONS);
      try {
        const before = db
          .query<{ revision: number }, []>("SELECT revision FROM policy_revision WHERE id = 1")
          .get()?.revision;
        db.run("UPDATE subjects SET clearance = 1 WHERE user_id = 'dana.okafor@bank.example'");
        const after = db
          .query<{ revision: number }, []>("SELECT revision FROM policy_revision WHERE id = 1")
          .get()?.revision;
        expect(after).toBeGreaterThan(before!);
      } finally {
        db.close();
      }
    });
  });
  test("gains audit_log.redactions, which no CREATE IF NOT EXISTS could have added", () => {
    // The first *column* this schema has ever added (#16, version 2). Replaying
    // `SCHEMA` cannot do it — the table already exists, so `CREATE TABLE IF NOT
    // EXISTS` is a no-op and the disk would open green and fail on the first
    // `/post` that redacts anything. `MIGRATIONS` is what makes it happen.
    withPath("redactions-column", (path) => {
      writeOldDisk(path);

      const db = openGovernance(path, OPTIONS);
      try {
        const columns = db
          .query<{ name: string }, []>("PRAGMA table_info(audit_log)")
          .all()
          .map((row) => row.name);
        expect(columns).toContain("redactions");

        // And the column is usable: a /post modify row round-trips through it.
        record(db, [
          {
            id: newEventId(),
            ts: new Date().toISOString(),
            execution_id: "tc_post",
            hook: "post",
            user_id: "dana.okafor@bank.example",
            tool: "Loan.GetLoan",
            decision: "modify",
            reason: "redacted",
            rule_id: "post.redact-borrower-identifiers",
            redactions: [
              {
                path: "$.bank_account_number",
                rule_id: "post.redact-borrower-identifiers",
                pattern_id: null,
                kind: "mask",
              },
            ],
          },
        ]);
        const [row] = recent(db, 1);
        expect(row?.redactions).toEqual([
          {
            path: "$.bank_account_number",
            rule_id: "post.redact-borrower-identifiers",
            pattern_id: null,
            kind: "mask",
          },
        ]);
        // The old disk's own row is still there and still has no redactions.
        expect(auditCount(db)).toBe(2);
      } finally {
        db.close();
      }
    });
  });
});

describe("a fresh database", () => {
  test("still seeds the whole fixture, and records the version", () => {
    withPath("fresh", (path) => {
      const db = openGovernance(path, OPTIONS);
      try {
        expect(counts(db)).toMatchObject({
          subjects: 4,
          catalogue: 6,
          policy_rules: 6,
          output_rules: 2,
          grants: 0,
          approval_requests: 0,
          audit_log: 0,
        });
        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    });
  });

  test("reopening it changes nothing — a restart is not a reset", () => {
    withPath("reopen", (path) => {
      const first = openGovernance(path, OPTIONS);
      first.run("UPDATE subjects SET clearance = 123456 WHERE display_name = 'Dana Okafor'");
      record(first, [
        {
          id: newEventId(),
          ts: new Date().toISOString(),
          execution_id: "tc_1",
          hook: "pre",
          user_id: "dana.okafor@bank.example",
          tool: "Loan.ApproveLoan",
          decision: "allow",
          reason: "because",
          rule_id: null,
        },
      ]);
      first.close();

      const second = openGovernance(path, OPTIONS);
      try {
        expect(
          readPolicy(second).subjects.find((s) => s.display_name === "Dana Okafor")?.clearance,
        ).toBe(123_456);
        expect(auditCount(second)).toBe(1);
        expect(counts(second).subjects).toBe(4);
      } finally {
        second.close();
      }
    });
  });
});

describe("a seed that fails", () => {
  test("leaves no schema and no version, so the next boot retries", () => {
    const db = new Database(":memory:");
    try {
      const data = loadSeed(OPTIONS);
      const duplicated = { ...data, subjects: [...data.subjects, data.subjects[0]!] };

      expect(() => seed(db, duplicated)).toThrow(/UNIQUE/);
      expect(hasSchema(db)).toBe(false);
      // The version is stamped inside the same transaction as the DDL and the
      // rows. A rolled-back seed that left version 1 behind would be read as
      // "current" forever after — the unrecoverable case #60 names.
      expect(readSchemaVersion(db)).toBe(0);

      seed(db, data);
      expect(counts(db).subjects).toBe(4);
      expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("on a real path, leaves a file the next boot seeds cleanly", () => {
    withPath("failed", (path) => {
      // Squat on the one table `hasSchema` probes, so the next open takes the
      // upgrade path rather than the seed path, then confirm the upgrade did
      // not invent rows.
      const broken = new Database(path, { create: true });
      broken.exec("CREATE TABLE policy_rules (id TEXT PRIMARY KEY)");
      broken.close();

      const db = openGovernance(path, OPTIONS);
      try {
        // `CREATE TABLE IF NOT EXISTS` does not reshape an existing table, so
        // the truncated `policy_rules` stays truncated: the upgrade path adds
        // tables, it does not repair them. Stated here because it is the limit.
        expect(counts(db).policy_rules).toBe(0);
        expect(counts(db).subjects).toBe(0);
        expect(counts(db).approval_requests).toBe(0);
        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    });
  });
});

describe("a database newer than this build", () => {
  test("fails at boot, naming the reset, before the port opens", () => {
    withPath("newer", (path) => {
      writeOldDisk(path);
      const future = new Database(path);
      future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      future.close();

      let thrown: unknown;
      try {
        openGovernance(path, OPTIONS).close();
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      // Names what it found, what it understands, and the way out — none of
      // which a `SQLiteError: no such table` from a count helper tells you.
      expect(message).toContain(`user_version ${SCHEMA_VERSION + 1}`);
      expect(message).toContain(`understands ${SCHEMA_VERSION}`);
      expect(message).toContain(path);
      expect(message).toMatch(/delete/i);
      expect((thrown as Error).name).toBe("SchemaTooNewError");
    });
  });

  test("is not silently downgraded — the disk keeps its version", () => {
    withPath("untouched", (path) => {
      writeOldDisk(path);
      const future = new Database(path);
      future.exec(`PRAGMA user_version = 99`);
      future.close();

      expect(() => openGovernance(path, OPTIONS)).toThrow(/user_version 99/);

      const check = new Database(path);
      try {
        expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(99);
        // And nothing was added on the way past.
        expect(
          check
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'",
            )
            .get(),
        ).toBeNull();
      } finally {
        check.close();
      }
    });
  });
});

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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HooksConfig } from "../src/config.ts";
import { createPolicyCache } from "../src/policy-cache.ts";
import { createServer } from "../src/server.ts";
import {
  count as auditCount,
  maxSeq,
  newEventId,
  pageAfter,
  record,
  recent,
} from "../src/audit-log.ts";
import {
  SCHEMA_VERSION,
  counts,
  describeMigration,
  hasSchema,
  loadSeed,
  openGovernance,
  readPolicy,
  readSchemaVersion,
  seed,
  type MigrationReport,
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

// ---------------------------------------------------------------------------
// #103: the payload columns go, and so do their bytes
// ---------------------------------------------------------------------------

/**
 * The account number a pre-#101 row carried in `audit_log.before`. Long enough
 * and odd enough that finding it in a 300KB file means it is *that* value and
 * not a coincidence of digits.
 */
const ACCOUNT = "4738299104857321";
const TAX_ID = "86-7530912";

/**
 * A disk at version 2 — the schema #16 left — carrying rows whose `before`
 * and `after` hold raw `Loan.GetLoan` output. This is the shape of the live
 * Render disk: ~745,000 rows, most of them written before #101 stopped
 * binding those columns.
 *
 * `rows` is a knob rather than a constant because two of the tests below want
 * a file big enough that the drop cannot happen entirely inside one page.
 */
function writeDiskAtVersion2(path: string, rows = 200): void {
  const legacy = new Database(path, { create: true });
  legacy.exec("PRAGMA journal_mode = WAL");
  legacy.exec(`
    ${SCHEMA_BEFORE_APPROVAL_REQUESTS}
    ALTER TABLE audit_log ADD COLUMN redactions TEXT;
  `);
  const insert = legacy.prepare(
    `INSERT INTO audit_log
       (id, ts, execution_id, hook, user_id, tool, decision, reason, rule_id, before, after)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  legacy.transaction(() => {
    for (let i = 0; i < rows; i++) {
      // The account number sits *after* 4KB of notes, so it lands on an
      // overflow page rather than in the row's b-tree page. That is not
      // decoration: measured, a bare `DROP COLUMN` zeroes what it defragments
      // inside a page and leaves the freed overflow pages verbatim, so the
      // same value ahead of the filler comes back clean and behind it does
      // not. The real `Loan.GetLoan` output has `underwriter_notes` in it.
      const payload = JSON.stringify({
        loan_id: "LN-2291",
        borrower: "Northwind Bakery LLC",
        underwriter_notes: "x".repeat(4096),
        bank_account_number: ACCOUNT,
        tax_id: TAX_ID,
      });
      insert.run(
        `evt_payload${i.toString().padStart(6, "0")}`,
        new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        `tc_${i}`,
        "post",
        "dana.okafor@bank.example",
        "Loan.GetLoan",
        "modify",
        "Sensitive field masked.",
        "post.redact-borrower-identifiers",
        payload,
        payload.replace(ACCOUNT, "****"),
      );
    }
  })();
  insert.finalize();
  legacy.exec("PRAGMA user_version = 2");
  legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  legacy.close();
}

/** How many times `needle` appears in the raw bytes of the db and its WAL. */
function occurrencesInFile(path: string, needle: string): number {
  let hits = 0;
  for (const suffix of ["", "-wal"]) {
    if (!existsSync(path + suffix)) continue;
    hits += readFileSync(path + suffix).toString("latin1").split(needle).length - 1;
  }
  return hits;
}

/** Every object in `sqlite_master`, as SQLite itself spells it. */
function schemaOf(db: Database): Array<{ type: string; name: string; sql: string | null }> {
  return db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

describe("a database carrying the retired payload columns (#103)", () => {
  test("loses the columns, keeps every row", () => {
    withPath("drop-columns", (path) => {
      writeDiskAtVersion2(path);

      const db = openGovernance(path, OPTIONS);
      try {
        const columns = db
          .query<{ name: string }, []>("PRAGMA table_info(audit_log)")
          .all()
          .map((row) => row.name);
        expect(columns).not.toContain("before");
        expect(columns).not.toContain("after");
        expect(columns).toEqual([
          "seq",
          "id",
          "ts",
          "execution_id",
          "hook",
          "user_id",
          "tool",
          "decision",
          "reason",
          "rule_id",
          "redactions",
        ]);

        // The decisions themselves are not what #103 removes. 200 payload rows
        // plus the one `SCHEMA_BEFORE_APPROVAL_REQUESTS` writes.
        expect(auditCount(db)).toBe(201);
        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);

        // And a SELECT naming them now fails, from this connection or any other.
        expect(() => db.query("SELECT before FROM audit_log").all()).toThrow(/no such column/);
      } finally {
        db.close();
      }
    });
  });

  test("leaves no account number in the file bytes", () => {
    withPath("residue", (path) => {
      writeDiskAtVersion2(path);
      // The premise: before the migration the value is right there in the file,
      // 200 times over, readable by anything that can open it. A test that
      // asserts absence without first proving presence proves nothing.
      expect(occurrencesInFile(path, ACCOUNT)).toBeGreaterThanOrEqual(200);

      const db = openGovernance(path, OPTIONS);
      db.close();

      expect(occurrencesInFile(path, ACCOUNT)).toBe(0);
      expect(occurrencesInFile(path, TAX_ID)).toBe(0);
      // The 4KB filler went with it: nothing of the old payload survives.
      expect(occurrencesInFile(path, "underwriter_notes")).toBe(0);
    });
  });

  test("leaves nothing for the audit read API or the stream to serve", () => {
    withPath("api-residue", (path) => {
      writeDiskAtVersion2(path, 5);

      const db = openGovernance(path, OPTIONS);
      try {
        // `recent` is what `GET /events`' replay and the audit API both read
        // rows through, and `pageAfter` is the resumable path.
        const rows = [...recent(db, 100), ...pageAfter(db, 0, maxSeq(db), 100).map((p) => p.event)];
        expect(rows.length).toBeGreaterThan(5);
        const serialised = JSON.stringify(rows);
        expect(serialised).not.toContain(ACCOUNT);
        expect(serialised).not.toContain(TAX_ID);
        for (const row of rows) {
          expect(Object.keys(row)).not.toContain("before");
          expect(Object.keys(row)).not.toContain("after");
        }
      } finally {
        db.close();
      }
    });
  });

  test("a second boot is a no-op, and reports no migration", () => {
    withPath("idempotent", (path) => {
      writeDiskAtVersion2(path, 20);

      const first: Array<{ from: number; to: number }> = [];
      const a = openGovernance(path, OPTIONS, (report) => first.push(report));
      const rowsAfterFirst = auditCount(a);
      a.close();
      expect(first).toHaveLength(1);
      expect(first[0]?.from).toBe(2);
      expect(first[0]?.to).toBe(SCHEMA_VERSION);

      const second: unknown[] = [];
      const b = openGovernance(path, OPTIONS, (report) => second.push(report));
      try {
        // Nothing ran, so nothing is reported: this is how a reader tells
        // "migrated on this boot" from "migrated some deploy ago".
        expect(second).toHaveLength(0);
        expect(readSchemaVersion(b)).toBe(SCHEMA_VERSION);
        expect(auditCount(b)).toBe(rowsAfterFirst);
      } finally {
        b.close();
      }
    });
  });

  test("ends at the same schema a fresh database is created with", () => {
    withPath("migrated", (migratedPath) => {
      withPath("brand-new", (freshPath) => {
        writeDiskAtVersion2(migratedPath, 10);

        // Twice, because a second pass must not add or reshape anything.
        openGovernance(migratedPath, OPTIONS).close();
        const migrated = openGovernance(migratedPath, OPTIONS);
        const brandNew = openGovernance(freshPath, OPTIONS);
        try {
          expect(readSchemaVersion(migrated)).toBe(readSchemaVersion(brandNew));

          // `audit_log` in particular, spelled out, since it is the table #103
          // reshapes and the one a DROP COLUMN could leave subtly different.
          const auditColumns = (db: Database) =>
            db.query<{ name: string; type: string; notnull: number }, []>(
              "PRAGMA table_info(audit_log)",
            ).all();
          expect(auditColumns(migrated)).toEqual(auditColumns(brandNew));

          // And every other object: the migrated disk predates `grants` and
          // `approval_requests` too, so this covers the whole upgrade path.
          expect(schemaOf(migrated).map((o) => `${o.type} ${o.name}`)).toEqual(
            schemaOf(brandNew).map((o) => `${o.type} ${o.name}`),
          );
        } finally {
          migrated.close();
          brandNew.close();
        }
      });
    });
  });

  test("the report carries the row count and the duration", () => {
    withPath("report", (path) => {
      writeDiskAtVersion2(path, 30);

      let report: MigrationReport | null = null;
      openGovernance(path, OPTIONS, (r) => {
        report = r;
      }).close();

      const seen = report as MigrationReport | null;
      expect(seen).not.toBeNull();
      // 30 payload rows plus the one the old disk already had. Counted before
      // the migration, which is the number that says how much work it was.
      expect(seen!.auditRows).toBe(31);
      expect(seen!.from).toBe(2);
      expect(seen!.to).toBe(SCHEMA_VERSION);
      expect(seen!.ddlMs).toBeGreaterThan(0);
      expect(seen!.vacuumMs).toBeGreaterThan(0);
      // The VACUUM reclaimed the space the 4KB payloads occupied.
      expect(seen!.bytesAfter!).toBeLessThan(seen!.bytesBefore!);

      const line = describeMigration(seen!);
      expect(line).toContain("MIGRATED ONCE");
      expect(line).toContain("schema 2 → 4");
      expect(line).toContain("31 audit rows");
      expect(line).toMatch(/DDL \d+ms/);
      expect(line).toMatch(/VACUUM \d+ms/);
    });
  });

  test("an interrupted sweep is retried: a disk left at 3 is vacuumed on the next boot", () => {
    withPath("half-migrated", (path) => {
      writeDiskAtVersion2(path);

      // Exactly what a crash between the two halves leaves behind: the columns
      // dropped and stamped, the file not yet swept. Version 3 exists so this
      // state is recoverable rather than permanent and silent.
      const halfway = new Database(path);
      halfway.exec("PRAGMA journal_mode = WAL");
      halfway.transaction(() => {
        halfway.exec('ALTER TABLE audit_log DROP COLUMN "before"');
        halfway.exec('ALTER TABLE audit_log DROP COLUMN "after"');
        halfway.exec("PRAGMA user_version = 3");
      })();
      halfway.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      halfway.close();

      // The premise again: the drop alone left the account numbers legible.
      expect(occurrencesInFile(path, ACCOUNT)).toBeGreaterThan(0);

      let report: MigrationReport | null = null;
      const db = openGovernance(path, OPTIONS, (r) => {
        report = r;
      });
      try {
        expect((report as MigrationReport | null)?.from).toBe(3);
        expect((report as MigrationReport | null)?.vacuumMs).toBeGreaterThan(0);
        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }

      expect(occurrencesInFile(path, ACCOUNT)).toBe(0);
    });
  });
});

/**
 * The migration is not just logged: `/health` carries it over HTTP for the
 * life of the process. A boot line scrolls out of a Render deploy log; the
 * question "did this disk get migrated, and how big was it" outlives it.
 */
describe("GET /health after a migration (#103)", () => {
  const config: HooksConfig = {
    port: 0,
    dbPath: ":memory:",
    signingSecret: "test-secret",
    approvalsStoreToken: "test-store-token",
    // Unset, so `POST /admin/reset` is not mounted (#106): this file is about
    // the schema upgrade, not the reset.
    resetToken: "",
    loanToolkit: "Loan",
    approvalsToolkit: "Approvals",
    personaEmails: {},
    deadlineMs: 2500,
    policyPollMs: 250,
    grantTtlSeconds: 900,
    injectionDetection: "armed",
  };

  test("reports the migration on the boot that ran it, and null on the next", async () => {
    const path = tempPath("health-migration");
    try {
      writeDiskAtVersion2(path, 12);

      for (const boot of ["migrating", "already-current"] as const) {
        let report: MigrationReport | null = null;
        const db = openGovernance(path, config, (r) => {
          report = r;
        });
        const cache = createPolicyCache(db, { log: () => {}, pollMs: 10_000 });
        cache.start();
        const server = createServer({ config, db, cache, log: () => {}, migration: report });
        try {
          const body = (await (await fetch(`http://localhost:${server.port}/health`)).json()) as {
            migration: MigrationReport | null;
            audit_rows: number;
          };
          if (boot === "migrating") {
            expect(body.migration).not.toBeNull();
            expect(body.migration?.from).toBe(2);
            expect(body.migration?.to).toBe(SCHEMA_VERSION);
            // 12 payload rows plus the one the old disk already carried.
            expect(body.migration?.auditRows).toBe(13);
            expect(body.migration?.ddlMs).toBeGreaterThan(0);
            expect(body.migration?.vacuumMs).toBeGreaterThan(0);
          } else {
            expect(body.migration).toBeNull();
          }
          // Either way the rows are still there and still counted.
          expect(body.audit_rows).toBe(13);
        } finally {
          cache.stop();
          server.stop(true);
          db.close();
        }
      }
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

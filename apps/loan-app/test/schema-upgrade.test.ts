/**
 * A `loans.db` from before a column or a table existed must still open, keep
 * its rows, and work — the disk persists across deploys (#29), so every schema
 * change after the first meets a database that predates it.
 *
 * #60: probing for one table as a stand-in for a schema version handles the
 * added-column case and silently drops the added-table one. The version now
 * lives in `PRAGMA user_version`.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SCHEMA_VERSION,
  countLoans,
  getLoan,
  openLoanBook,
  readSchemaVersion,
  recordDecision,
  searchLoans,
  seed,
} from "../src/db.ts";

/** The schema exactly as #30 shipped it: no `decided_by`. */
const SCHEMA_AT_30 = `
  CREATE TABLE loans (
    loan_id TEXT PRIMARY KEY, borrower_name TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    purpose TEXT NOT NULL, submitted_at TEXT NOT NULL, credit_score INTEGER NOT NULL,
    annual_revenue INTEGER NOT NULL, years_in_business INTEGER NOT NULL,
    bank_account_number TEXT NOT NULL, tax_id TEXT NOT NULL, underwriter_notes TEXT NOT NULL
  );
  CREATE TABLE loan_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(loan_id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
    amount INTEGER, reason TEXT, decided_at TEXT NOT NULL
  );
  INSERT INTO loans VALUES ('LN-0030', 'Old Schema Co', 12000, 'approved', 'Legacy',
    '2026-01-01', 700, 100000, 3, '0000000000000000', '00-0000000', 'Predates decided_by.');
  INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_at)
    VALUES ('LN-0030', 'approved', 12000, NULL, '2026-01-02T00:00:00.000Z');
`;

describe("opening a loans.db written by an earlier schema", () => {
  test("keeps every row, adds the missing column, and writes work", () => {
    const path = join(tmpdir(), `cg-loans-old-${crypto.randomUUID()}`, "loans.db");
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path, { create: true });
    legacy.exec(SCHEMA_AT_30);
    legacy.close();

    const db = openLoanBook(path);
    try {
      const before = getLoan(db, "LN-0030");
      expect(before?.decisions).toEqual([
        {
          decision: "approved",
          amount: 12000,
          reason: null,
          decided_by: null,
          decided_at: "2026-01-02T00:00:00.000Z",
        },
      ]);

      const after = recordDecision(db, {
        loan_id: "LN-0030",
        decision: "approved",
        amount: 9000,
        reason: null,
        decided_by: "alice@example.test",
      });
      expect(after?.decisions).toHaveLength(2);
      expect(after?.decisions.at(-1)?.decided_by).toBe("alice@example.test");

      // Not reseeded: the fixture's loans are absent, the legacy row is the only one.
      expect(getLoan(db, "LN-2291")).toBeNull();
    } finally {
      db.close();
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  test("is idempotent — a current database opens unchanged", () => {
    const path = join(tmpdir(), `cg-loans-cur-${crypto.randomUUID()}`, "loans.db");
    openLoanBook(path).close();
    const db = openLoanBook(path);
    try {
      expect(getLoan(db, "LN-2291")).not.toBeNull();
      expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

/** A fresh directory per test; the caller removes it. */
function tempPath(tag: string): string {
  const path = join(tmpdir(), `cg-loans-${tag}-${crypto.randomUUID()}`, "loans.db");
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
 * The added-table case, which is the one that was unhandled. A disk with
 * `loans` and no `loan_decisions` at all: the probe says "seeded", so before
 * #60 the table never appeared and the first read of a loan answered
 * `no such table: loan_decisions`.
 */
const SCHEMA_MISSING_A_TABLE = `
  CREATE TABLE loans (
    loan_id TEXT PRIMARY KEY, borrower_name TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    purpose TEXT NOT NULL, submitted_at TEXT NOT NULL, credit_score INTEGER NOT NULL,
    annual_revenue INTEGER NOT NULL, years_in_business INTEGER NOT NULL,
    bank_account_number TEXT NOT NULL, tax_id TEXT NOT NULL, underwriter_notes TEXT NOT NULL
  );
  INSERT INTO loans VALUES ('LN-0060', 'No Decisions Table Co', 4200, 'pending', 'Legacy',
    '2026-01-01', 700, 100000, 3, '0000000000000000', '00-0000000', 'Predates loan_decisions.');
`;

describe("opening a loans.db written before a table existed", () => {
  test("gains the table, with no rows inserted into it", () => {
    withPath("missing-table", (path) => {
      const legacy = new Database(path, { create: true });
      legacy.exec(SCHEMA_MISSING_A_TABLE);
      expect(
        legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(0);
      legacy.close();

      const db = openLoanBook(path);
      try {
        // The table exists now...
        expect(
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loan_decisions'",
            )
            .get(),
        ).not.toBeNull();

        // ...and is empty. The upgrade adds schema, never rows.
        expect(
          db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM loan_decisions").get()?.n,
        ).toBe(0);

        // Not reseeded: the legacy row is still the only loan.
        expect(countLoans(db)).toBe(1);
        expect(getLoan(db, "LN-0060")?.decisions).toEqual([]);
        expect(getLoan(db, "LN-2291")).toBeNull();

        // And the missing index came with it, so the app works end to end.
        expect(searchLoans(db, {})).toHaveLength(1);
        expect(
          recordDecision(db, {
            loan_id: "LN-0060",
            decision: "approved",
            amount: 4200,
            reason: null,
            decided_by: "alice@example.test",
          })?.decisions,
        ).toHaveLength(1);

        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    });
  });
});

describe("a fresh loans.db", () => {
  test("still seeds the whole fixture, and records the version", () => {
    withPath("fresh", (path) => {
      const db = openLoanBook(path);
      try {
        expect(countLoans(db)).toBeGreaterThan(0);
        expect(getLoan(db, "LN-2291")).not.toBeNull();
        expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    });
  });
});

describe("a seed that fails", () => {
  test("leaves no schema and no version, so the next boot retries", () => {
    const db = new Database(":memory:");
    try {
      const one = {
        loan_id: "LN-9001",
        borrower_name: "Duplicate Co",
        amount: 1000,
        status: "pending" as const,
        purpose: "Working capital",
        submitted_at: "2026-01-01",
        credit_score: 700,
        annual_revenue: 100_000,
        years_in_business: 3,
        bank_account_number: "0000000000000000",
        tax_id: "00-0000000",
        underwriter_notes: "",
        decisions: [],
      };

      expect(() => seed(db, [one, one])).toThrow(/UNIQUE/);
      expect(() => countLoans(db)).toThrow(/no such table/);
      // The version is stamped inside the same transaction. A rolled-back seed
      // that left version 1 behind would read as current forever after.
      expect(readSchemaVersion(db)).toBe(0);

      seed(db, [one]);
      expect(countLoans(db)).toBe(1);
      expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("a loans.db newer than this build", () => {
  test("fails at boot, naming the file and the reset", () => {
    withPath("newer", (path) => {
      openLoanBook(path).close();
      const future = new Database(path);
      future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      future.close();

      let thrown: unknown;
      try {
        openLoanBook(path).close();
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect((thrown as Error).name).toBe("SchemaTooNewError");
      expect(message).toContain(`user_version ${SCHEMA_VERSION + 1}`);
      expect(message).toContain(`understands ${SCHEMA_VERSION}`);
      expect(message).toContain(path);
      expect(message).toMatch(/delete/i);

      // And the disk was not quietly downgraded on the way past.
      const check = new Database(path);
      try {
        expect(
          check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
        ).toBe(SCHEMA_VERSION + 1);
      } finally {
        check.close();
      }
    });
  });
});

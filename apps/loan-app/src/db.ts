/**
 * `loans.db` — the loan book. Plain domain persistence: a `loans` table and an
 * append-only `loan_decisions` table.
 *
 * Nothing here inspects who is asking or what they are allowed to do. Every
 * read returns whatever the row holds and every write is applied as given.
 * That is deliberate: this is the system being governed, and the controls live
 * in `apps/hooks`, which this service cannot reach or influence.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import fixture from "./fixtures/loans.json" with { type: "json" };

export type LoanStatus = "pending" | "approved" | "denied";

/** One entry in a loan's decision history. Append-only — see `recordDecision`. */
export interface LoanDecision {
  decision: "approved" | "denied";
  /** Dollars, present on approvals only. */
  amount: number | null;
  reason: string | null;
  /**
   * Who recorded it — the email the API derived from the caller's token.
   * `null` only for decisions that came in with the seed, which predate the
   * system and have no actor to name.
   */
  decided_by: string | null;
  decided_at: string;
}

/** What `search_loans` returns per hit: the list-view columns. */
export interface LoanSummary {
  loan_id: string;
  borrower_name: string;
  amount: number;
  status: LoanStatus;
  purpose: string;
  submitted_at: string;
}

/**
 * What `get_loan` returns: the whole record.
 *
 * `bank_account_number`, `tax_id` and `underwriter_notes` are in here on
 * purpose. A loan origination system's detail view holds them, so ours does
 * too — a service that withheld them would be doing the control plane's job
 * and there would be nothing left to demonstrate.
 */
export interface LoanRecord extends LoanSummary {
  credit_score: number;
  annual_revenue: number;
  years_in_business: number;
  bank_account_number: string;
  tax_id: string;
  underwriter_notes: string;
  decisions: LoanDecision[];
}

const decisionFixtureSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  amount: z.number().nullable(),
  reason: z.string().nullable(),
  decided_by: z.string().nullable().default(null),
  decided_at: z.string(),
});

const loanFixtureSchema = z.object({
  loan_id: z.string(),
  borrower_name: z.string(),
  amount: z.number(),
  status: z.enum(["pending", "approved", "denied"]),
  purpose: z.string(),
  submitted_at: z.string(),
  credit_score: z.number(),
  annual_revenue: z.number(),
  years_in_business: z.number(),
  bank_account_number: z.string(),
  tax_id: z.string(),
  underwriter_notes: z.string(),
  decisions: z.array(decisionFixtureSchema),
});

// The fixture is hand-edited — by us now and by forkers later — so it is
// parsed rather than trusted. A typo should fail at boot with a field path,
// not surface as a loan that quietly has no borrower.
const fixtureSchema = z.object({ loans: z.array(loanFixtureSchema).min(1) });

/**
 * Every statement here is idempotent — `IF NOT EXISTS` throughout — so the
 * same string serves both bootstrap paths: inside `seed()`'s transaction on a
 * fresh database, and on its own against a database that predates a table
 * added since. See `SCHEMA_VERSION`.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS loans (
    loan_id             TEXT    PRIMARY KEY,
    borrower_name       TEXT    NOT NULL,
    amount              INTEGER NOT NULL,
    status              TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    purpose             TEXT    NOT NULL,
    submitted_at        TEXT    NOT NULL,
    credit_score        INTEGER NOT NULL,
    annual_revenue      INTEGER NOT NULL,
    years_in_business   INTEGER NOT NULL,
    bank_account_number TEXT    NOT NULL,
    tax_id              TEXT    NOT NULL,
    underwriter_notes   TEXT    NOT NULL
  );

  -- Append-only. An approval is an event, not a flag, so approving the same
  -- loan twice leaves two rows and shows up in the data instead of collapsing
  -- into an accidental no-op.
  CREATE TABLE IF NOT EXISTS loan_decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id    TEXT    NOT NULL REFERENCES loans(loan_id),
    decision   TEXT    NOT NULL CHECK (decision IN ('approved', 'denied')),
    amount     INTEGER,
    reason     TEXT,
    decided_by TEXT,
    decided_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_loan_decisions_loan_id ON loan_decisions(loan_id);
  CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
`;

/**
 * Opens the loan book, bootstrapping it from the fixture only when it has no
 * schema.
 *
 * Seed-if-empty rather than seed-on-boot: `loans.db` lives on a Render disk
 * (decided on #29), so approvals made on stage are still there after a
 * restart. Getting back to a clean state is an explicit script (#23), never a
 * side effect of deploying.
 */
export function openLoanBook(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    if (hasSchema(db)) upgradeSchema(db, path);
    else seed(db, fixtureLoans());
  } catch (cause) {
    // Leave no half-open handle behind: the caller is about to exit, and a
    // lingering WAL lock is one more thing between a crash-looping service
    // and somebody deleting the file.
    db.close();
    throw cause;
  }

  return db;
}

/**
 * The schema revision this build writes, recorded in `PRAGMA user_version`.
 * Bump it in the same commit as any change to `SCHEMA` or to `upgradeSchema`.
 *
 * Version 1 is the schema at #60. Databases written before this existed read
 * back 0 — the SQLite default — which is exactly the "needs the upgrade path"
 * answer, so no disk has to be touched by hand to adopt this.
 */
export const SCHEMA_VERSION = 1;

/** The schema revision recorded on disk. 0 on anything written before #60. */
export function readSchemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/**
 * Thrown at boot, before the port opens, when the database on disk is not one
 * this build can bring forward. Names the file and the way out, because the
 * alternative is a `SQLiteError: no such table` from the first request that
 * needs the missing piece, a crash loop, and a Render Shell that will not
 * attach to a service that keeps exiting (#60).
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `loans.db at ${path} was written by a newer build (PRAGMA user_version ${found}; ` +
        `this build understands ${SCHEMA_VERSION}) and cannot be migrated backwards. ` +
        `Reset it: stop the service, delete ${path} (and its -wal and -shm siblings), ` +
        `and restart — the fixture reseeds on an empty disk. POST /admin/reset cannot help ` +
        `here: it is served by this process, and this process is about to exit.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Brings a database created by an earlier schema up to the current one,
 * keeping every row. `hasSchema` only asks whether the `loans` table exists,
 * which is the right question for "is this seeded?" and the wrong one for "is
 * this current?": a `loans.db` on a persistent disk predates everything added
 * after it, and without this it would open green and fail on the first query
 * that named the new part. What is "current" is `PRAGMA user_version`, not
 * the presence of one table (#60).
 *
 * Two kinds of step, both additive and idempotent, and nothing else:
 *
 *   - replaying `SCHEMA`, which is `CREATE ... IF NOT EXISTS` throughout, so
 *     a table or index added after this disk existed simply appears;
 *   - an `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check.
 *
 * A change that cannot be expressed that way — a widened `CHECK`, a dropped
 * column, a rewritten primary key — is a reset, and resets are explicit (#23),
 * never a side effect of booting. `CREATE TABLE IF NOT EXISTS` in particular
 * does not reshape a table that already exists; it only creates a missing one.
 *
 * No inserts. The rows on this disk are the state the demo is in.
 */
function upgradeSchema(db: Database, path: string): void {
  const found = readSchemaVersion(db);
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(path, found);
  if (found === SCHEMA_VERSION) return;

  // One transaction, so a half-applied upgrade rolls back to a database that
  // still reads its old version and tries again on the next boot.
  db.transaction(() => {
    db.exec(SCHEMA);

    // Added on #34: who recorded the decision, read off the caller's token.
    if (!hasColumn(db, "loan_decisions", "decided_by")) {
      db.exec("ALTER TABLE loan_decisions ADD COLUMN decided_by TEXT");
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loans'",
    )
    .get();

  return row !== null;
}

/**
 * `bun:sqlite` matches named parameters on the `$name` form, so a plain
 * `{ loan_id }` binds nothing and every column arrives NULL — which surfaces
 * as a constraint violation on a different column than the one you forgot.
 */
type NamedBindings = Record<string, string | number | boolean | null>;

function bind(row: NamedBindings): NamedBindings {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value]));
}

/** One loan as it appears in the fixture. */
export type LoanSeed = z.infer<typeof loanFixtureSchema>;

/**
 * The seed rows, parsed off the fixture compiled into this build.
 *
 * Read on a fresh database and again by `reset.ts`, so the rows a reset writes
 * are the rows this image ships rather than whatever an older file on the disk
 * happened to hold. Parsed on every call: it is a handful of rows, and a
 * cached copy would be one more thing that can be stale.
 */
export function fixtureLoans(): LoanSeed[] {
  return fixtureSchema.parse(fixture).loans;
}

/**
 * Creates the schema and inserts the seed rows in **one** transaction.
 *
 * The schema has to be inside the transaction, not just the inserts. SQLite
 * DDL is transactional, so a seed that throws halfway leaves no tables at all
 * and the next boot tries again with a clear error. Creating the tables first
 * and wrapping only the inserts produces the one failure that cannot recover
 * on its own: a database holding a schema and no rows, which `hasSchema`
 * reads as already seeded. The service then comes up green and empty — and on
 * a disk that persists, it stays that way. A forker who duplicates a loan_id
 * in the fixture is one boot away from that.
 *
 * Exported for the test that holds this line.
 */
export function seed(db: Database, loans: LoanSeed[]): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    // Inside the same transaction as the DDL and the rows, so the version is
    // recorded if and only if both landed.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    // Prepared after the DDL, because the tables have to exist to compile
    // against, and finalized before the transaction commits so a rollback is
    // not fighting open statements over tables it is about to drop.
    const insertLoan = db.prepare<unknown, NamedBindings>(`
      INSERT INTO loans (
        loan_id, borrower_name, amount, status, purpose, submitted_at,
        credit_score, annual_revenue, years_in_business,
        bank_account_number, tax_id, underwriter_notes
      ) VALUES (
        $loan_id, $borrower_name, $amount, $status, $purpose, $submitted_at,
        $credit_score, $annual_revenue, $years_in_business,
        $bank_account_number, $tax_id, $underwriter_notes
      )
    `);

    const insertDecision = db.prepare<unknown, NamedBindings>(`
      INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_by, decided_at)
      VALUES ($loan_id, $decision, $amount, $reason, $decided_by, $decided_at)
    `);

    try {
      for (const loan of loans) {
        const { decisions, ...columns } = loan;
        insertLoan.run(bind(columns));

        for (const decision of decisions) {
          insertDecision.run(bind({ loan_id: loan.loan_id, ...decision }));
        }
      }
    } finally {
      insertLoan.finalize();
      insertDecision.finalize();
    }
  })();
}

export function searchLoans(
  db: Database,
  filters: { status?: LoanStatus; min_amount?: number; max_amount?: number },
): LoanSummary[] {
  // Every filter is optional, so each clause is skipped with `IS NULL` on its
  // own parameter rather than by concatenating SQL.
  return db
    .query<LoanSummary, { $status: string | null; $min: number | null; $max: number | null }>(
      `SELECT loan_id, borrower_name, amount, status, purpose, submitted_at
         FROM loans
        WHERE ($status IS NULL OR status = $status)
          AND ($min    IS NULL OR amount >= $min)
          AND ($max    IS NULL OR amount <= $max)
        ORDER BY submitted_at DESC, loan_id DESC`,
    )
    .all({
      $status: filters.status ?? null,
      $min: filters.min_amount ?? null,
      $max: filters.max_amount ?? null,
    });
}

export function getLoan(db: Database, loanId: string): LoanRecord | null {
  const loan = db
    .query<Omit<LoanRecord, "decisions">, { $loan_id: string }>(
      "SELECT * FROM loans WHERE loan_id = $loan_id",
    )
    .get({ $loan_id: loanId });

  if (loan === null) return null;

  const decisions = db
    .query<LoanDecision, { $loan_id: string }>(
      `SELECT decision, amount, reason, decided_by, decided_at
         FROM loan_decisions
        WHERE loan_id = $loan_id
        ORDER BY id ASC`,
    )
    .all({ $loan_id: loanId });

  return { ...loan, decisions };
}

/**
 * Appends a decision and moves the loan's status to match.
 *
 * Returns the updated record, or `null` if no such loan exists. Applies the
 * decision exactly as asked: any question of whether the caller should have
 * been able to make it was settled — or not — before the call reached here.
 *
 * `decided_by` is who made it, as the API read it off the caller's token. It
 * is recorded, never consulted.
 */
export function recordDecision(
  db: Database,
  input: {
    loan_id: string;
    decision: "approved" | "denied";
    amount: number | null;
    reason: string | null;
    decided_by?: string | null;
  },
): LoanRecord | null {
  const decided_at = new Date().toISOString();
  const decided_by = input.decided_by ?? null;

  const applied = db.transaction(() => {
    const exists = db
      .query<{ loan_id: string }, { $loan_id: string }>(
        "SELECT loan_id FROM loans WHERE loan_id = $loan_id",
      )
      .get({ $loan_id: input.loan_id });

    if (exists === null) return false;

    db.query<unknown, NamedBindings>(
      `INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_by, decided_at)
       VALUES ($loan_id, $decision, $amount, $reason, $decided_by, $decided_at)`,
    ).run(
      bind({
        loan_id: input.loan_id,
        decision: input.decision,
        amount: input.amount,
        reason: input.reason,
        decided_by,
        decided_at,
      }),
    );

    db.query("UPDATE loans SET status = $status WHERE loan_id = $loan_id").run({
      $status: input.decision,
      $loan_id: input.loan_id,
    });

    return true;
  })();

  return applied ? getLoan(db, input.loan_id) : null;
}

export function countLoans(db: Database): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM loans").get();
  return row?.n ?? 0;
}

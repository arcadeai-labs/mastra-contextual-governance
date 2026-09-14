/**
 * `governance.db` — who may do what, and what happened.
 *
 * Six tables a presenter can read at a glance, because one of them gets
 * edited live on stage:
 *
 *   subjects        the cast: user_id (email), display_name, role, clearance
 *   catalogue       every governed tool and the arguments a call must supply
 *   policy_rules    /access and /pre rules — one row each, JSON only where the
 *                   schema is genuinely nested (subjects, conditions)
 *   output_rules    /post redaction rules; stored now, evaluated from #16
 *   grants          narrow permissions produced by approvals; written at /pre (#19)
 *   approval_requests  escalations the approvals toolkit writes and the
 *                   approval page reads; empty on seed (#19)
 *   audit_log       append-only, one row per decision — see `audit-log.ts`
 *
 * Plus `policy_revision`, a single integer that triggers bump on every write to
 * `subjects`, `catalogue` or `policy_rules`. That number is how the in-memory
 * policy cache (`policy-cache.ts`) notices an edit from *any* connection —
 * this process, a `sqlite3` shell on the Render disk, the rule editor — without
 * re-reading the tables on every hook call.
 *
 * Seed-if-empty, not seed-on-boot (decided on #29): the database sits on a
 * Render disk, so a clearance raised on stage in act 1 is still raised in act 3
 * and after a restart. Bootstrapping happens only when there is no schema, and
 * resetting is an explicit script (#23), never a side effect of deploying.
 *
 * Every row that leaves this module is `parse()`d through `@cg/policy-schema`
 * on the way out. Those schemas are `.strict()`, so a hand-edited row with a
 * misspelled field fails loudly here rather than evaluating as a rule narrower
 * or wider than the one someone thought they wrote.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { ToolCatalogue } from "@cg/governance-core";
import {
  OutputRule,
  PolicyRule,
  Subject,
  type OutputRuleInput,
  type PolicyRuleInput,
  type SubjectInput,
} from "@cg/policy-schema";

import fixture from "./fixtures/governance.json" with { type: "json" };

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** Placeholders the fixture uses for the two configured toolkit names. */
const TOOLKIT_PLACEHOLDERS = { $LOAN: "loanToolkit", $APPROVALS: "approvalsToolkit" } as const;

export interface SeedOptions {
  loanToolkit: string;
  approvalsToolkit: string;
  /** Persona key → email, from `PERSONA_<KEY>_EMAIL`. Missing keys keep the fixture's address. */
  personaEmails: Record<string, string>;
}

const seedSubjectSchema = z
  .object({
    persona: z.string().min(1),
    user_id: z.string().email(),
    display_name: z.string().min(1),
    role: z.string().min(1),
    clearance: z.number().nonnegative(),
  })
  .strict();

// Hand-edited, so parsed rather than trusted: a typo fails at first boot with
// a field path instead of surfacing as a persona with no authority. The rules
// themselves are parsed through the strict domain schemas below, after the
// toolkit placeholders are filled in.
const fixtureSchema = z
  .object({
    "//": z.array(z.string()).optional(),
    catalogue: z.record(z.record(z.array(z.string()))),
    subjects: z.array(seedSubjectSchema).min(1),
    policy_rules: z.array(z.unknown()),
    output_rules: z.array(z.unknown()),
  })
  .strict();

export interface Seed {
  catalogue: ToolCatalogue;
  subjects: Subject[];
  policy_rules: PolicyRule[];
  output_rules: OutputRule[];
}

/**
 * The fixture with the configured toolkit names and persona emails substituted
 * in, parsed through the strict schemas. Pure; exported so a test can check the
 * seed compiles before anything touches a database.
 */
export function loadSeed(options: SeedOptions, raw: unknown = fixture): Seed {
  const parsed = fixtureSchema.parse(raw);

  const substitute = (text: string): string =>
    Object.entries(TOOLKIT_PLACEHOLDERS).reduce(
      (acc, [placeholder, key]) => acc.split(placeholder).join(options[key]),
      text,
    );
  const substituteDeep = (value: unknown): unknown => {
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(substituteDeep);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [substitute(k), substituteDeep(v)]),
      );
    }
    return value;
  };

  const subjects = parsed.subjects.map(({ persona, ...subject }) => {
    const override = options.personaEmails[persona.toLowerCase()];
    // Lowercased on the way in (#58), by the same rule `subjectKey` applies on
    // the way out: `PERSONA_<KEY>_EMAIL` carries whatever capitalisation the
    // Arcade account was invited under, and a roster keyed on `Dana.Okafor@…`
    // is a roster the lookup can never hit.
    const user_id = (override ?? subject.user_id).trim().toLowerCase();
    const input: SubjectInput = { ...subject, user_id };
    return Subject.parse(input);
  });

  return {
    catalogue: substituteDeep(parsed.catalogue) as ToolCatalogue,
    subjects,
    policy_rules: parsed.policy_rules.map((rule) => PolicyRule.parse(substituteDeep(rule))),
    output_rules: parsed.output_rules.map((rule) => OutputRule.parse(substituteDeep(rule))),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Every statement here is idempotent — `IF NOT EXISTS` throughout, plus
 * `INSERT OR IGNORE` for the single `policy_revision` row. That is what lets
 * the same string serve both bootstrap paths: inside `seed()`'s transaction on
 * a fresh database, and on its own against a database that predates a table
 * added since. See `SCHEMA_VERSION` for what that second path does and does
 * not cover.
 */
const SCHEMA = `
  -- The cast. clearance is the unit-free ceiling exceeds_clearance compares
  -- against; here it counts US dollars. Raise Dana's on stage and rerun.
  CREATE TABLE IF NOT EXISTS subjects (
    user_id      TEXT    PRIMARY KEY,
    display_name TEXT    NOT NULL,
    role         TEXT    NOT NULL,
    clearance    REAL    NOT NULL CHECK (clearance >= 0),
    attributes   TEXT    NOT NULL DEFAULT '{}'
  );

  -- Every governed tool. arguments is a JSON array of names; a trailing '?'
  -- marks one optional. A tool not listed here is denied at every hook.
  CREATE TABLE IF NOT EXISTS catalogue (
    toolkit   TEXT NOT NULL,
    tool      TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (toolkit, tool)
  );

  -- /access and /pre rules. Lower priority evaluates first; first match wins.
  -- Set enabled = 0 to switch a rule off without losing it.
  CREATE TABLE IF NOT EXISTS policy_rules (
    id          TEXT    PRIMARY KEY,
    description TEXT    NOT NULL DEFAULT '',
    hook        TEXT    NOT NULL CHECK (hook IN ('access', 'pre')),
    toolkit     TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    subjects    TEXT,
    conditions  TEXT    NOT NULL DEFAULT '[]',
    effect      TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
    reason      TEXT    NOT NULL,
    priority    INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );

  -- /post rules. Held here from the start so the whole policy is in one place;
  -- the RedactionEngine reads them from #16.
  CREATE TABLE IF NOT EXISTS output_rules (
    id          TEXT    PRIMARY KEY,
    description TEXT    NOT NULL DEFAULT '',
    toolkit     TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    subjects    TEXT,
    fields      TEXT    NOT NULL DEFAULT '[]',
    patterns    TEXT    NOT NULL DEFAULT '[]',
    reason      TEXT    NOT NULL,
    priority    INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );

  -- Grants: one row per approval outcome, in the shape @cg/policy-schema's
  -- Grant describes, plus the three lifecycle columns below. Written by the
  -- approval flow (#10, #19); read at /pre.
  --
  -- The lifecycle exists because issuing a grant and recording the decision
  -- that justifies it are two writes, and two writes race. A grant is minted
  -- 'pending' by /pre and becomes usable only inside the same transaction that
  -- records the winning decision as 'approved'; a decision that records
  -- 'denied' voids it in that same transaction. So an approval that loses the
  -- race leaves a row that never becomes authority, rather than one that is
  -- authority until somebody notices.
  --
  --   pending  minted by /pre, not usable, waiting for a recorded decision
  --   active   the recorded decision was 'approved'. The only usable state.
  --   void     the recorded decision was 'denied', or the request settled
  --            without this grant winning. revoked_at is set too, so
  --            GrantChecker refuses it even if the status is ignored.
  CREATE TABLE IF NOT EXISTS grants (
    id             TEXT PRIMARY KEY,
    subject_id     TEXT NOT NULL,
    granted_by     TEXT NOT NULL,
    request_id     TEXT NOT NULL,
    toolkit        TEXT NOT NULL,
    tool           TEXT NOT NULL,
    resource_id    TEXT,
    pinned_inputs  TEXT NOT NULL DEFAULT '{}',
    ceiling        TEXT,
    issued_at      TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    uses_remaining INTEGER,
    revoked_at     TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'void')),
    -- The decision this grant was minted for. Activation matches on it, so a
    -- grant can only ever be turned on by the outcome it was issued against.
    authorizes     TEXT NOT NULL DEFAULT 'approved'
                        CHECK (authorizes IN ('approved', 'denied')),
    activated_at   TEXT,
    voided_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_grants_subject_tool ON grants(subject_id, toolkit, tool, status);
  -- One approval, one grant, enforced by the database. The /pre handler that
  -- issues a grant and the store call that flips the request to 'approved'
  -- are two writes, and only the second one closes the "still pending" rule.
  -- Without this, a Decide replayed inside that window would issue a second
  -- grant for the same approval — single use per grant, but two grants.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_request ON grants(request_id);

  -- Approval requests: the escalations the approvals toolkit writes and the
  -- approval page reads. Empty on seed; every row arrives over
  -- POST /approvals. The columns up to 'note' are the wire record written out
  -- in tools/approvals/README.md, one column each so a presenter can read the
  -- table; the four after it are the control plane's own resolution of the
  -- bare action name, recorded at creation.
  --
  -- Resolving once and storing it is what makes a grant issued minutes later
  -- match the call that was actually refused: a catalogue edited in between
  -- cannot silently retarget the approval at a different tool or a different
  -- argument.
  CREATE TABLE IF NOT EXISTS approval_requests (
    id                     TEXT PRIMARY KEY,
    requester_id           TEXT NOT NULL,
    requester_display_name TEXT NOT NULL,
    approver_id            TEXT NOT NULL,
    approver_display_name  TEXT NOT NULL,
    candidate_approver_ids TEXT NOT NULL DEFAULT '[]',
    action                 TEXT NOT NULL,
    resource_id            TEXT NOT NULL,
    amount                 REAL NOT NULL,
    required_clearance     REAL NOT NULL,
    rule_id                TEXT,
    rule_description       TEXT,
    justification          TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','denied','expired')),
    created_at             TEXT NOT NULL,
    decided_at             TEXT,
    decided_by             TEXT,
    note                   TEXT,
    -- The control plane's resolution of the action name, pinned at creation time.
    match_toolkit          TEXT NOT NULL,
    match_tool             TEXT NOT NULL,
    -- Which argument of that tool names the resource, and which one carries
    -- the amount the approver cleared. A grant pins the first and bounds the
    -- second; amount_input is NULL only for an action with no numeric
    -- dimension at all.
    resource_input         TEXT NOT NULL,
    amount_input           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approval_requests_requester ON approval_requests(requester_id, status);

  -- One row per decision the control plane made, in GovernanceEvent's shape.
  --
  -- NOT a complete record of every refusal a persona met. Arcade evaluates a
  -- tool's auth requirements before /pre fires: a persona without a token for
  -- the tool is refused upstream of every hook, and that refusal writes no row
  -- here (measured, spike #2; DESIGN.md open risk 2). What this table holds is
  -- every decision *this service* made, including its own failures.
  CREATE TABLE IF NOT EXISTS audit_log (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE,
    ts           TEXT    NOT NULL,
    execution_id TEXT    NOT NULL DEFAULT '',
    hook         TEXT    NOT NULL CHECK (hook IN ('access', 'pre', 'post')),
    user_id      TEXT    NOT NULL,
    tool         TEXT    NOT NULL,
    decision     TEXT    NOT NULL CHECK (decision IN ('allow', 'deny', 'modify')),
    reason       TEXT    NOT NULL,
    rule_id      TEXT,
    -- Retired on #101 and never written again: GovernanceEvent has no payload
    -- fields, because this table is durable and GET /events is unauthenticated.
    -- Kept as columns so a database with rows from before the change opens
    -- without a migration; src/audit-log.ts neither writes nor reads them.
    before       TEXT,
    after        TEXT,
    -- What a /post modify removed: a JSON array of RedactionRecord — path,
    -- rule_id, pattern_id, kind — and never a removed value. NULL on every
    -- other row. Added at schema version 2 (#16); see MIGRATIONS.
    redactions   TEXT
  );
  -- seq already orders rows by time, so no index on ts: a whole-project
  -- /access appends ~10k rows in one transaction, and every index is paid
  -- for on each of them.
  CREATE INDEX IF NOT EXISTS idx_audit_log_execution ON audit_log(execution_id);

  -- Append-only, enforced by the database rather than by convention. A
  -- compliance reviewer reading this table should not have to trust that
  -- nobody ran an UPDATE.
  CREATE TRIGGER IF NOT EXISTS audit_log_is_append_only_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_log_is_append_only_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  -- Bumped on every write to the tables the in-memory policy cache is built
  -- from, so an edit from any connection is noticed on the next hook call.
  CREATE TABLE IF NOT EXISTS policy_revision (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO policy_revision (id, revision) VALUES (1, 1);
`;

/**
 * Triggers bumping `policy_revision` for every write to the cached tables.
 *
 * `output_rules` joined the list on #16, when `/post` started evaluating them:
 * before that they were stored and never read, so an edit had nothing to
 * invalidate. A redaction rule edited on stage is live within one poll, exactly
 * as an `/access` or `/pre` rule is.
 */
const REVISION_TRIGGERS = ["subjects", "catalogue", "policy_rules", "output_rules"]
  .flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (op) =>
        `CREATE TRIGGER IF NOT EXISTS bump_revision_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
         BEGIN UPDATE policy_revision SET revision = revision + 1 WHERE id = 1; END;`,
    ),
  )
  .join("\n");

// ---------------------------------------------------------------------------
// Opening and seeding
// ---------------------------------------------------------------------------

/**
 * The schema revision this build writes, recorded in `PRAGMA user_version`.
 * Bump it in the same commit as any change to `SCHEMA`.
 *
 * Replaying the idempotent `SCHEMA` buys new tables, indexes and triggers, and
 * nothing else. Anything not expressible as `CREATE ... IF NOT EXISTS` — an
 * added column, a widened `CHECK`, a renamed index — needs a statement of its
 * own in {@link MIGRATIONS}, because shipping one without it leaves a disk that
 * opens green and fails on the first query naming the change. `governance.db`
 * sits on a Render disk (decided on #29), so every schema change after the
 * first meets a database that predates it.
 *
 * Version 1 is the schema at #60. Databases written before this existed read
 * back 0 — the SQLite default — which is exactly the "needs the upgrade path"
 * answer, so no disk has to be touched by hand to adopt this.
 *
 * Version 2 is #16: `audit_log.redactions`, the first added *column* this
 * schema has had, which is what {@link MIGRATIONS} exists for.
 */
export const SCHEMA_VERSION = 2;

/**
 * What each version needs beyond a replay of `SCHEMA`, keyed by the version it
 * brings the database *to*. Applied in ascending order, inside the same
 * transaction as the version bump, and only for versions above the one on disk.
 *
 * Each statement is written to be safe against a database that already has the
 * change — `columnExists` guards the `ALTER`s — so a disk at version 0, which
 * predates the recorded version and may be anywhere, is brought forward rather
 * than crashed on.
 */
const MIGRATIONS: ReadonlyArray<{ to: number; apply: (db: Database) => void }> = [
  {
    to: 2,
    apply: (db) => {
      // #16: /post now records what it removed. Path and rule id, never the
      // value — see GovernanceEvent's docstring for why the payload itself is
      // not persisted.
      if (!columnExists(db, "audit_log", "redactions")) {
        db.exec("ALTER TABLE audit_log ADD COLUMN redactions TEXT");
      }
    },
  },
];

function columnExists(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

/**
 * Opens `governance.db`: seeds it from the fixture when it has no schema, and
 * otherwise brings its schema up to `SCHEMA_VERSION` without touching a row.
 *
 * The two paths are deliberately separate. On a fresh database the DDL and the
 * seed rows go in as *one* transaction — see `seed()` for why that line matters
 * and what breaks if it is crossed. On an existing database only the DDL runs,
 * because its rows are the live state of the demo and reseeding them would make
 * a restart a reset (#29).
 */
export function openGovernance(path: string, seedOptions: SeedOptions): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Another connection (the reset script, a sqlite3 shell) may hold a write
  // lock for a moment; wait rather than fail a hook call over it.
  db.exec("PRAGMA busy_timeout = 1000");

  try {
    if (hasSchema(db)) upgradeSchema(db, path);
    else seed(db, loadSeed(seedOptions));
  } catch (cause) {
    // Leave no half-open handle behind: the caller is about to exit, and on
    // Render a lingering WAL lock is one more thing between a crash-looping
    // service and somebody deleting the file.
    db.close();
    throw cause;
  }

  return db;
}

/**
 * Whether this database has been bootstrapped at all.
 *
 * Only ever asked about bootstrapping. "Is this schema current?" is a
 * different question with a different answer — `readSchemaVersion` — and
 * conflating the two is the bug this module had: probing for one table said
 * "already seeded", seeding was skipped, and a table added later could never
 * appear on a disk that persists (#60).
 */
export function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_rules'",
    )
    .get();
  return row !== null;
}

/** The schema revision recorded on disk. 0 on anything written before #60. */
export function readSchemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/**
 * Thrown at boot, before the port opens, when the database on disk is not one
 * this build can bring forward. Names the reset, because the alternative —
 * what #60 actually saw in production — is a `SQLiteError: no such table` from
 * a health-count helper, a crash loop, and a Render Shell that will not attach
 * to a service that keeps exiting.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `governance.db at ${path} was written by a newer build (PRAGMA user_version ${found}; ` +
        `this build understands ${SCHEMA_VERSION}) and cannot be migrated backwards. ` +
        `Reset it: stop the service, delete ${path} (and its -wal and -shm siblings), ` +
        `and restart — the fixture reseeds on an empty disk. A one-command reset lands with #23.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Adds whatever `SCHEMA` gained since this database was written, and records
 * the new version. No inserts: the rows already here are the demo's live
 * state.
 *
 * DDL and the version bump share one transaction, so a half-applied upgrade
 * rolls back to a database that still reads its old version and will simply
 * try again on the next boot.
 */
function upgradeSchema(db: Database, path: string): void {
  const found = readSchemaVersion(db);
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(path, found);
  if (found === SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(SCHEMA);
    db.exec(REVISION_TRIGGERS);
    for (const migration of MIGRATIONS) {
      if (migration.to > found) migration.apply(db);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

/**
 * `bun:sqlite` binds named parameters on the `$name` form; a plain `{ id }`
 * binds nothing and every column arrives NULL.
 */
type NamedBindings = Record<string, string | number | null>;

function bind(row: Record<string, unknown>): NamedBindings {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      `$${key}`,
      value === null || value === undefined
        ? null
        : typeof value === "string" || typeof value === "number"
          ? value
          : typeof value === "boolean"
            ? Number(value)
            : JSON.stringify(value),
    ]),
  );
}

/**
 * Creates the schema and inserts the seed rows in **one** transaction.
 *
 * The DDL has to be inside the transaction, not just the inserts. A seed that
 * throws halfway then leaves no tables at all and the next boot retries with a
 * clear error. Creating the tables first and wrapping only the inserts produces
 * the one failure that cannot recover on its own: a schema with no rows, which
 * `hasSchema` reads as already seeded, so every later boot comes up green with
 * nobody in the cast and no rules — permanently, on a disk that persists. Found
 * the hard way in `apps/loan-app`, and copied from there.
 *
 * `PRAGMA user_version` is stamped inside the same transaction, so it is set
 * if and only if the tables and the rows both landed.
 *
 * Exported for the test that holds this line.
 */
export function seed(db: Database, data: Seed): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    db.exec(REVISION_TRIGGERS);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    insertPolicy(db, data);
  })();
}

/**
 * The four policy tables, replaced from `data`, in one transaction.
 *
 * The reset (#106). Everything the demo *did* is untouched: `grants`,
 * `approval_requests` and `audit_log` are not named here, and the audit log
 * could not be deleted from anyway — its append-only triggers refuse.
 *
 * One transaction matters more here than at bootstrap. This runs against a
 * live control plane serving hooks from another connection, and the policy
 * cache reloads on the revision bump these writes cause. A half-applied
 * replacement would be a policy with, say, the new rules and the old
 * catalogue: rules that name tools that are no longer catalogued, which
 * `compilePolicy` refuses — so the service would fail closed, which is safe,
 * and would stay that way, which is the outage. Inside a transaction the cache
 * sees either the old policy or the new one and never the seam.
 *
 * `DELETE` and not `DROP`: the schema, its indexes and the revision triggers
 * are the database's, not the fixture's, and a reset is about rows.
 */
export function replacePolicy(db: Database, data: Seed): void {
  db.transaction(() => {
    for (const table of ["subjects", "catalogue", "policy_rules", "output_rules"]) {
      db.exec(`DELETE FROM ${table}`);
    }
    insertPolicy(db, data);
  })();
}

/**
 * The inserts alone, with no transaction of its own — both callers above have
 * one, and both need the DDL or the DELETEs inside it.
 */
function insertPolicy(db: Database, data: Seed): void {
  const insertSubject = db.prepare<unknown, NamedBindings>(
    `INSERT INTO subjects (user_id, display_name, role, clearance, attributes)
     VALUES ($user_id, $display_name, $role, $clearance, $attributes)`,
  );
  const insertCatalogue = db.prepare<unknown, NamedBindings>(
    `INSERT INTO catalogue (toolkit, tool, arguments) VALUES ($toolkit, $tool, $arguments)`,
  );
  const insertRule = db.prepare<unknown, NamedBindings>(
    `INSERT INTO policy_rules
       (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority, enabled)
     VALUES
       ($id, $description, $hook, $toolkit, $tool, $subjects, $conditions, $effect, $reason, $priority, $enabled)`,
  );
  const insertOutputRule = db.prepare<unknown, NamedBindings>(
    `INSERT INTO output_rules
       (id, description, toolkit, tool, subjects, fields, patterns, reason, priority, enabled)
     VALUES
       ($id, $description, $toolkit, $tool, $subjects, $fields, $patterns, $reason, $priority, $enabled)`,
  );

  try {
    for (const subject of data.subjects) insertSubject.run(bind(subject));
    for (const [toolkit, tools] of Object.entries(data.catalogue)) {
      for (const [tool, args] of Object.entries(tools)) {
        insertCatalogue.run(bind({ toolkit, tool, arguments: args }));
      }
    }
    for (const { match, ...rule } of data.policy_rules) {
      insertRule.run(bind({ ...rule, toolkit: match.toolkit, tool: match.tool }));
    }
    for (const { match, ...rule } of data.output_rules) {
      insertOutputRule.run(bind({ ...rule, toolkit: match.toolkit, tool: match.tool }));
    }
  } finally {
    insertSubject.finalize();
    insertCatalogue.finalize();
    insertRule.finalize();
    insertOutputRule.finalize();
  }
}

// ---------------------------------------------------------------------------
// Reading policy
// ---------------------------------------------------------------------------

/** Everything the policy cache is built from, read in one consistent snapshot. */
export interface PolicySnapshot {
  revision: number;
  catalogue: ToolCatalogue;
  subjects: Subject[];
  rules: PolicyRule[];
  /** The `/post` rules, read in the same transaction as everything else (#16). */
  output_rules: OutputRule[];
}

/** The one integer the cache polls. Microseconds; one indexed row. */
export function readRevision(db: Database): number {
  const row = db
    .query<{ revision: number }, []>("SELECT revision FROM policy_revision WHERE id = 1")
    .get();
  if (row === null) throw new Error("governance.db has no policy_revision row");
  return row.revision;
}

interface SubjectRow {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
  attributes: string;
}

interface CatalogueRow {
  toolkit: string;
  tool: string;
  arguments: string;
}

interface RuleRow {
  id: string;
  description: string;
  hook: string;
  toolkit: string;
  tool: string;
  subjects: string | null;
  conditions: string;
  effect: string;
  reason: string;
  priority: number;
  enabled: number;
}

/**
 * Reads subjects, catalogue and rules inside one read transaction, so the
 * revision reported is the one the rows belong to. Every row is parsed through
 * the strict schema on the way out — a hand-edited row that no longer conforms
 * throws here, and the cache treats that as fail-closed rather than serving the
 * rule someone thought they wrote.
 */
export function readPolicy(db: Database): PolicySnapshot {
  return db.transaction(() => {
    const revision = readRevision(db);

    const subjects = db
      .query<SubjectRow, []>("SELECT * FROM subjects ORDER BY user_id")
      .all()
      .map((row) => Subject.parse({ ...row, attributes: JSON.parse(row.attributes) }));

    const catalogue: Record<string, Record<string, string[]>> = {};
    for (const row of db
      .query<CatalogueRow, []>("SELECT * FROM catalogue ORDER BY toolkit, tool")
      .all()) {
      (catalogue[row.toolkit] ??= {})[row.tool] = z.array(z.string()).parse(JSON.parse(row.arguments));
    }

    const rules = db
      .query<RuleRow, []>("SELECT * FROM policy_rules ORDER BY priority, id")
      .all()
      .map(({ toolkit, tool, subjects: subjectsJson, conditions, enabled, ...rest }) => {
        const input: PolicyRuleInput = {
          ...rest,
          hook: rest.hook as PolicyRuleInput["hook"],
          effect: rest.effect as PolicyRuleInput["effect"],
          match: { toolkit, tool },
          subjects: subjectsJson === null ? null : JSON.parse(subjectsJson),
          conditions: JSON.parse(conditions),
          enabled: enabled === 1,
        };
        return PolicyRule.parse(input);
      });

    return { revision, catalogue, subjects, rules, output_rules: readOutputRules(db) };
  })();
}

/**
 * Every `/post` rule, parsed. Read by `readPolicy` into the same snapshot the
 * cache compiles, so a redaction rule is as live as an `/access` one.
 */
export function readOutputRules(db: Database): OutputRule[] {
  interface Row extends Omit<RuleRow, "hook" | "effect" | "conditions"> {
    fields: string;
    patterns: string;
  }
  return db
    .query<Row, []>("SELECT * FROM output_rules ORDER BY priority, id")
    .all()
    .map(({ toolkit, tool, subjects: subjectsJson, fields, patterns, enabled, ...rest }) => {
      const input: OutputRuleInput = {
        ...rest,
        match: { toolkit, tool },
        subjects: subjectsJson === null ? null : JSON.parse(subjectsJson),
        fields: JSON.parse(fields),
        patterns: JSON.parse(patterns),
        enabled: enabled === 1,
      };
      return OutputRule.parse(input);
    });
}

/** How many rows each table holds — for `/health` and the boot log line. */
export function counts(db: Database): Record<string, number> {
  const count = (table: string): number =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  return {
    subjects: count("subjects"),
    catalogue: count("catalogue"),
    policy_rules: count("policy_rules"),
    output_rules: count("output_rules"),
    grants: count("grants"),
    approval_requests: count("approval_requests"),
    audit_log: count("audit_log"),
  };
}

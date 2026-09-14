/**
 * Whether the policy on disk is still the policy this image ships.
 *
 * `governance.db` seeds from `fixtures/governance.json` only when it has no
 * schema (decided on #29: policy is durable, a reset is something you run).
 * That decision is right and it has a cost, measured on #106: between #16 and
 * 2026-09-14 the live service ran the pre-#16 policy — one output rule instead
 * of two, one injection pattern instead of six — while `/health` cheerfully
 * reported `armed`. Nothing on any surface said the fixture had moved on. That
 * is this project's own named failure, a control that looks live and matches
 * nothing, shipped by us.
 *
 * So the fixture is compared against the disk, by row, on every policy load.
 * Not to overwrite it — a clearance raised on stage must survive a deploy —
 * but so that the difference has a name, `fixture_drift`, and a place to be
 * read.
 *
 * ## Comparing by seeding
 *
 * The fixture's rows are obtained by seeding a throwaway in-memory database
 * from it and reading the rows back. It is a handful of inserts, and it is the
 * only way to be sure both sides are normalised identically: the fixture's
 * on-disk form is *defined* by `seed()`, so anything else here would be a
 * second, drifting implementation of it — a row reported as differing because
 * `subjects` was serialised `[]` on one side and `null` on the other would
 * make the warning noise, and a warning that is noise is one nobody reads.
 *
 * The digest is over the raw columns rather than over parsed domain objects,
 * for the case that matters most: a stale row that no longer *parses* is
 * exactly the one #112's outage was about, and `readPolicy` throws on it. The
 * comparison has to work when the policy does not.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { seed, loadSeed, type Seed, type SeedOptions } from "./policy-store.ts";

/**
 * The four tables the in-memory policy is built from — the same list the
 * `policy_revision` triggers are on, and the same list a reset replaces.
 * `grants`, `approval_requests` and `audit_log` are deliberately absent: they
 * are what the demo *did*, not what it was configured with, and a fixture has
 * nothing to say about them.
 */
export const POLICY_TABLES = ["subjects", "catalogue", "policy_rules", "output_rules"] as const;

export type PolicyTable = (typeof POLICY_TABLES)[number];

/** Row identity per table, matching each table's primary key. */
const ROW_KEY: Record<PolicyTable, (row: Record<string, unknown>) => string> = {
  subjects: (row) => String(row.user_id),
  catalogue: (row) => `${String(row.toolkit)}.${String(row.tool)}`,
  policy_rules: (row) => String(row.id),
  output_rules: (row) => String(row.id),
};

/** Row key → content hash, per table. */
export type PolicyDigest = Record<PolicyTable, Map<string, string>>;

/**
 * A row's content, as twelve hex characters.
 *
 * Columns are sorted by name first, so the digest does not depend on the order
 * `SELECT *` happens to return — a column added by a later migration would
 * otherwise make every row on an upgraded disk look changed.
 */
function hashRow(row: Record<string, unknown>): string {
  const canonical = Object.keys(row)
    .sort()
    .map((key) => [key, row[key] ?? null] as const);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

/** The four tables of an open database, hashed row by row. */
export function digestPolicy(db: Database): PolicyDigest {
  const digest = {} as PolicyDigest;
  for (const table of POLICY_TABLES) {
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all();
    digest[table] = new Map(rows.map((row) => [ROW_KEY[table](row), hashRow(row)] as const));
  }
  return digest;
}

/**
 * The shipped fixture's rows, in the form `seed()` writes them.
 *
 * Computed once at boot and held: it cannot change while the process runs,
 * because it is compiled into the image. That is the property #112 turned on —
 * a reseed driven from the *booting image's* fixture is safe in a way a shell
 * command run against whatever image happens to be live is not, and it is why
 * two of that day's three manual resets seeded the wrong text.
 */
export function fixtureDigest(options: SeedOptions, data: Seed = loadSeed(options)): PolicyDigest {
  const db = new Database(":memory:", { create: true });
  try {
    seed(db, data);
    return digestPolicy(db);
  } finally {
    db.close();
  }
}

/**
 * What differs, named so a reader can go and look.
 *
 * Ids are qualified with their table — `policy_rules:pre.approve-within-clearance`
 * — because two tables can carry the same id and because the qualified form is
 * the one somebody can paste into a `SELECT`.
 */
export interface FixtureDrift {
  /** Every differing row, qualified and sorted. The field `/health` lists. */
  readonly ids: string[];
  /** In the fixture, absent from the disk. */
  readonly missing: string[];
  /** In both, with different content. */
  readonly changed: string[];
  /** On the disk, absent from the fixture. */
  readonly unexpected: string[];
}

/**
 * Compares a disk digest against the fixture's. `null` means they are the same
 * policy, row for row, which is the state a fresh deployment is in and the
 * state a reset returns to.
 */
export function compareToFixture(disk: PolicyDigest, fixture: PolicyDigest): FixtureDrift | null {
  const missing: string[] = [];
  const changed: string[] = [];
  const unexpected: string[] = [];

  for (const table of POLICY_TABLES) {
    const onDisk = disk[table];
    const shipped = fixture[table];
    for (const [key, hash] of shipped) {
      const found = onDisk.get(key);
      if (found === undefined) missing.push(`${table}:${key}`);
      else if (found !== hash) changed.push(`${table}:${key}`);
    }
    for (const key of onDisk.keys()) {
      if (!shipped.has(key)) unexpected.push(`${table}:${key}`);
    }
  }

  const ids = [...missing, ...changed, ...unexpected].sort();
  if (ids.length === 0) return null;
  return { ids, missing: missing.sort(), changed: changed.sort(), unexpected: unexpected.sort() };
}

/**
 * The sentence `/health`, the boot log and the panel all say. One string, so
 * the three surfaces cannot describe the same drift differently.
 *
 * It says what to do, because "differs" on its own is a fact nobody can act
 * on: the answer is either a deliberate stage edit, in which case the warning
 * is expected, or a fixture change that never reached this disk, in which case
 * it is the whole of #106.
 */
export function driftWarning(drift: FixtureDrift): string {
  const part = (label: string, ids: readonly string[]) =>
    ids.length === 0 ? [] : [`${label} ${ids.join(", ")}`];
  return (
    `the policy on disk differs from the fixture shipped in this image: ` +
    [
      ...part("changed", drift.changed),
      ...part("missing", drift.missing),
      ...part("not in the fixture", drift.unexpected),
    ].join("; ") +
    `. A live edit made on stage looks exactly like this and is meant to survive a deploy; ` +
    `a fixture change that never reached this disk also looks exactly like this, and that is ` +
    `the failure where every surface reads healthy and the rule matches nothing. ` +
    `POST /admin/reset {"mode":"policy"} replaces the four policy tables from the fixture.`
  );
}

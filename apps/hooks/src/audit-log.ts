/**
 * The audit log: one row per decision, appended and never touched again.
 *
 * Rows are `GovernanceEvent`s — the same shape the control-plane panel renders
 * (#21), so the panel shows the audit log rather than a prettier parallel
 * story. Every write is parsed through the strict schema first; a row that
 * would not read back is not written.
 *
 * `record` is synchronous and inside the hook's request path on purpose. A
 * decision that was made but not recorded is the one thing a compliance
 * reviewer cannot recover from later, so the write happens before the response
 * leaves — and if it fails, the caller fails closed (see `index.ts`).
 *
 * The table cannot claim completeness, and this module does not either: a
 * persona refused upstream by Arcade's own auth requirements never reaches a
 * hook and leaves no row here. See the `audit_log` DDL in `policy-store.ts`.
 *
 * **This is also the fan-out seam for the live stream (#20).** `record` takes
 * an optional `publish` and calls it *after* the transaction commits, with the
 * rows' `seq` values attached. That ordering is the whole contract: the stream
 * can lag the log, and a client recovers from that by resuming, but the stream
 * must never carry an event the log does not have — a panel showing a decision
 * that no audit row records would be worse than a panel showing nothing.
 * Publishing from inside `record` rather than from the caller is what makes it
 * structural: there is no way to append a row and forget to announce it.
 */
import type { Database } from "bun:sqlite";

import type { PublishedEvent } from "@cg/governance-core";
import { GovernanceEvent } from "@cg/policy-schema";

/** The columns as they come back from SQLite. */
interface AuditRow {
  id: string;
  ts: string;
  execution_id: string;
  hook: string;
  user_id: string;
  tool: string;
  decision: string;
  reason: string;
  rule_id: string | null;
  /** JSON array of `RedactionRecord`, or NULL. Never a removed value (#16). */
  redactions: string | null;
}

/**
 * `audit_log` still has `before` and `after` columns and they are deliberately
 * absent above.
 *
 * `GovernanceEvent` dropped the fields on #101, finishing what #16 decided: the
 * event carries `redactions[]` — where and why — and never a payload. Nothing
 * writes those columns any more, and {@link fromRow} does not read them, so a
 * database carrying rows from before the change stops serving their payloads on
 * an unauthenticated `GET /events` rather than failing to parse them. The
 * columns themselves stay until a schema version has another reason to move;
 * dropping one is a migration this slice has no cause to make anybody run.
 */

/**
 * Event ids double as the correlation token embedded in a denial's
 * `error_message` (#6), so they are short enough to sit in text a model reads
 * and random enough that two denials in the same second do not collide:
 * `evt_` and 10 base32 characters, ~50 bits.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, no i/l/o/u

export function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "evt_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

/**
 * Appends `events` in one transaction. Either all of them land or none do,
 * which is what lets a single `/access` call — which decides for many tools
 * at once — be reconstructed as a unit.
 *
 * `publish`, when given, is called once with the committed rows and their
 * `seq` values, after the commit and outside the transaction. A throw from it
 * is not caught here — the bus in `@cg/governance-core` already isolates its
 * subscribers, and swallowing a throw from the bus *itself* would hide a bug
 * in the fan-out rather than a bug in a stream.
 *
 * If the transaction fails, nothing is published: a rolled-back decision was
 * never made.
 */
export function record(
  db: Database,
  events: readonly GovernanceEvent[],
  publish?: (batch: readonly PublishedEvent[]) => void,
): void {
  if (events.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO audit_log
       (id, ts, execution_id, hook, user_id, tool, decision, reason, rule_id, redactions)
     VALUES
       ($id, $ts, $execution_id, $hook, $user_id, $tool, $decision, $reason, $rule_id, $redactions)`,
  );

  // Collected inside the transaction, published only if it commits.
  const committed: PublishedEvent[] = [];

  try {
    db.transaction(() => {
      committed.length = 0;
      for (const raw of events) {
        const event = GovernanceEvent.parse(raw);
        const { lastInsertRowid } = insert.run({
          $id: event.id,
          $ts: event.ts,
          $execution_id: event.execution_id,
          $hook: event.hook,
          $user_id: event.user_id,
          $tool: event.tool,
          $decision: event.decision,
          $reason: event.reason,
          $rule_id: event.rule_id,
          $redactions: event.redactions === undefined ? null : JSON.stringify(event.redactions),
        });
        committed.push({ seq: Number(lastInsertRowid), event });
      }
    })();
  } finally {
    insert.finalize();
  }

  publish?.(committed);
}

/** Most recent first. For `/health`, tests and the reset script's sanity check. */
export function recent(db: Database, limit = 50): GovernanceEvent[] {
  return db
    .query<AuditRow, { $limit: number }>(
      "SELECT * FROM audit_log ORDER BY seq DESC LIMIT $limit",
    )
    .all({ $limit: limit })
    .map(fromRow);
}

/** Every row for one Arcade execution, oldest first — `/pre` then `/post`. */
export function byExecution(db: Database, executionId: string): GovernanceEvent[] {
  return db
    .query<AuditRow, { $execution_id: string }>(
      "SELECT * FROM audit_log WHERE execution_id = $execution_id ORDER BY seq ASC",
    )
    .all({ $execution_id: executionId })
    .map(fromRow);
}

// ---------------------------------------------------------------------------
// Reading the log as a resumable sequence (#20)
// ---------------------------------------------------------------------------

/**
 * The `seq` of the row with this `id`, or `null` if the log does not have it.
 *
 * A `Last-Event-ID` the log cannot place is not an error: a panel left open
 * across a `scripts/reset` will send one, and so will a stale browser tab. The
 * caller resumes live rather than replaying from the beginning, and says so.
 */
export function seqOf(db: Database, id: string): number | null {
  return (
    db.query<{ seq: number }, { $id: string }>("SELECT seq FROM audit_log WHERE id = $id").get({
      $id: id,
    })?.seq ?? null
  );
}

/** The highest `seq` in the log, or 0 when it is empty. */
export function maxSeq(db: Database): number {
  return (
    db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM audit_log").get()?.seq ?? 0
  );
}

/**
 * One page of the log, oldest first: rows with `after < seq <= upTo`.
 *
 * Keyset pagination rather than a held-open cursor. A replay is drained across
 * however many reads the client's backpressure allows, and between two of them
 * the hook path is still committing rows — an open read transaction spanning
 * those awaits would be a governance service made slower by somebody watching
 * it. `upTo` is what keeps the pages from chasing that tail forever.
 */
export function pageAfter(
  db: Database,
  after: number,
  upTo: number,
  limit: number,
): PublishedEvent[] {
  return db
    .query<AuditRow & { seq: number }, { $after: number; $upTo: number; $limit: number }>(
      `SELECT * FROM audit_log
        WHERE seq > $after AND seq <= $upTo
        ORDER BY seq ASC
        LIMIT $limit`,
    )
    .all({ $after: after, $upTo: upTo, $limit: limit })
    .map((row) => ({ seq: row.seq, event: fromRow(row) }));
}

/**
 * The anchor a capped replay should start from, or `null` when the whole gap
 * fits under `limit`.
 *
 * Returns the `seq` with *exactly* `limit` rows after it up to `upTo`, so a
 * replay from there is capped, contiguous, and joins the live stream with no
 * hole between the two. The hole it does leave is the oldest part of the gap,
 * which is the right end to drop: the recent story stays intact, and the caller
 * announces the truncation rather than letting the missing rows pass for rows
 * that were never decided.
 */
export function cappedAnchor(
  db: Database,
  after: number,
  upTo: number,
  limit: number,
): number | null {
  return (
    db
      .query<{ seq: number }, { $after: number; $upTo: number; $limit: number }>(
        `SELECT seq FROM audit_log
          WHERE seq > $after AND seq <= $upTo
          ORDER BY seq DESC
          LIMIT 1 OFFSET $limit`,
      )
      .get({ $after: after, $upTo: upTo, $limit: limit })?.seq ?? null
  );
}

export function count(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n ?? 0;
}

function fromRow(row: AuditRow): GovernanceEvent {
  return GovernanceEvent.parse({
    id: row.id,
    ts: row.ts,
    execution_id: row.execution_id,
    hook: row.hook,
    user_id: row.user_id,
    tool: row.tool,
    decision: row.decision,
    reason: row.reason,
    rule_id: row.rule_id,
    // `before`/`after` are not read even when an old row has them: see the note
    // on `AuditRow`.
    ...(row.redactions !== null && { redactions: JSON.parse(row.redactions) }),
  });
}

// ---------------------------------------------------------------------------
// Reading the log as a filtered page (#62)
// ---------------------------------------------------------------------------

/**
 * A `GET /audit` filter. Every field is optional except the bound.
 *
 * The fields are ANDed. `user_id` is matched case-insensitively — the join key
 * is one lowercase string across the three databases (#58), but nothing
 * normalises what Arcade puts on a hook payload, so a filter that differed only
 * in case would return nothing and read as "no such decisions".
 */
export interface AuditFilter {
  /** Case-insensitive exact match on the acting persona. */
  readonly user_id?: string;
  /** Exact match on the stored `Toolkit.Tool`, e.g. `Loan.GetLoan`. */
  readonly tool?: string;
  readonly hook?: string;
  readonly decision?: string;
  /** ISO 8601 instant; rows at or after it. */
  readonly since?: string;
  readonly limit: number;
}

export interface AuditPage {
  /** Newest first, at most `filter.limit` of them. */
  readonly rows: GovernanceEvent[];
  /** How many rows match the filter in total, before `limit` is applied. */
  readonly total: number;
}

/**
 * One filtered page of the log, newest first.
 *
 * `total` is counted with the same predicate and *without* the limit, because
 * the question this endpoint exists to answer is "was that burst 8,278 denials
 * or a runaway loop" (#62) — and a page that stops at the bound with no count
 * beside it cannot tell the two apart. 8,278 is the measured size of one live
 * `tools/list`'s `/access` frames, across the four calls Arcade makes for it
 * (`docs/spikes/05-custom-verifier.md` §11.3); #107 is what stopped one
 * listing being that many rows.
 */
export function search(db: Database, filter: AuditFilter): AuditPage {
  const where: string[] = [];
  const params: Record<string, string> = {};

  if (filter.user_id !== undefined) {
    where.push("lower(user_id) = lower($user_id)");
    params.$user_id = filter.user_id;
  }
  if (filter.tool !== undefined) {
    where.push("tool = $tool");
    params.$tool = filter.tool;
  }
  if (filter.hook !== undefined) {
    where.push("hook = $hook");
    params.$hook = filter.hook;
  }
  if (filter.decision !== undefined) {
    where.push("decision = $decision");
    params.$decision = filter.decision;
  }
  if (filter.since !== undefined) {
    where.push("ts >= $since");
    params.$since = filter.since;
  }

  const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;

  const total =
    db
      .query<{ n: number }, Record<string, string>>(`SELECT COUNT(*) AS n FROM audit_log${clause}`)
      .get(params)?.n ?? 0;

  const rows = db
    .query<AuditRow, Record<string, string | number>>(
      `SELECT * FROM audit_log${clause} ORDER BY seq DESC LIMIT $limit`,
    )
    .all({ ...params, $limit: filter.limit })
    .map(fromRow);

  return { rows, total };
}

// ---------------------------------------------------------------------------
// Retention (#62)
// ---------------------------------------------------------------------------

/**
 * The stated bound on `audit_log`, in rows.
 *
 * The table is append-only and nothing prunes it — the triggers in
 * `policy-store.ts` refuse a DELETE, and a compliance log that can be quietly
 * shortened is not one. So the bound is the disk, expressed in rows: measured
 * at **238 bytes a row** on disk (`bun run --cwd apps/hooks bench`, the
 * "audit_log on disk" section, priced on a representative mix of 50,000 real
 * rows), the 1 GB Render volume holds ~4.5 M.
 *
 * **Two million is now conservative, and deliberately left alone.** It was set
 * on #62 against 487 bytes a row, which was the average when `/access` wrote
 * one row per catalogue entry and most of the table was the 276-character
 * "toolkit … is not governed by this control plane" reason, written once per
 * entry. #107 stopped writing those, and the average halved. The bound is
 * therefore ~455 MB rather than ~930 MB, and the warning fires at ~364 MB.
 *
 * The rate matters more than the bound and moved much further: one live
 * `tools/list` wrote **8,278** rows and now writes about ten, so the table
 * grows some three orders of magnitude more slowly for the same use. Raising
 * the bound would buy headroom nothing is asking for; a demo that reaches two
 * million audit rows has a story worth hearing either way.
 *
 * See "What the log costs, and the bound on it" in README.md.
 */
export const AUDIT_RETENTION_ROWS = 2_000_000;

/**
 * A warning for the boot log once the table is within reach of the bound, or
 * `null` while it is not.
 *
 * Said at boot rather than enforced at write time on purpose: truncating the
 * log to keep serving is the one repair nobody would see. A demo that is
 * approaching the disk should be reset (`scripts/reset`, #23), and the run
 * before that is the moment to say so.
 */
export function retentionWarning(rows: number, bound = AUDIT_RETENTION_ROWS): string | null {
  if (rows < bound * 0.8) return null;
  return (
    `audit_log holds ${rows.toLocaleString("en-US")} rows, ` +
    `${Math.round((rows / bound) * 100)}% of the ${bound.toLocaleString("en-US")}-row bound ` +
    `this disk is sized for. Nothing prunes it: run scripts/reset before it fills.`
  );
}

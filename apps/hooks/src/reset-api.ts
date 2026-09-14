/**
 * `POST /admin/reset` — getting back to the seeded state without a deploy and
 * without a shell.
 *
 * #29 made the databases durable and named "resetting is a script you run"
 * (#23) as the other half of that bargain. Until this endpoint, the script did
 * not exist, so the only way back was a `sqlite3` session in a Render shell.
 * #106 records what that cost on one day: three manual resets and a 502 outage
 * to get two fixture changes onto the live service, twice seeding the wrong
 * text because the shell was attached to a rolled-back image while the fixture
 * a reseed should use is the one compiled into the image that is *running*.
 * This endpoint always uses that one. It is the whole reason it is an endpoint
 * rather than a command.
 *
 * ## Two modes, and what each does not touch
 *
 *   policy   subjects, catalogue, policy_rules, output_rules — the four tables
 *            the in-memory cache is built from, replaced from the fixture. What
 *            the demo *did* survives: grants, approval requests, audit rows.
 *            This is the drift fix: after a fixture change, run it and the live
 *            policy is the shipped policy.
 *   demo     the above, plus grants, approval_requests and audit_log emptied.
 *            The rehearsal reset — the state a fresh disk comes up in, so the
 *            next take starts from nothing.
 *
 * Neither mode touches **`idp.db`**. The OAuth client credentials registered in
 * the Arcade dashboard live there (DESIGN.md), and regenerating them turns a
 * demo reset into a re-registration nobody asked for. This service does not
 * hold a handle to that database and this endpoint does not open one.
 *
 * Neither mode touches **`loans.db`** either, and that is a boundary rather
 * than an omission: it belongs to `apps/loan-app`, which knows nothing about
 * governance and must keep not knowing. Reaching across two services into
 * another one's SQLite file would make this service a client of the business
 * system's storage, which is the exact coupling the split in DESIGN.md exists
 * to prevent. Approved loans are reset by that service's own endpoint (#23).
 * The response says so, so a presenter reading it is not left believing the
 * loan book moved.
 *
 * ## Authorization
 *
 * Its own bearer, `RESET_TOKEN` — a third secret, alongside Arcade's signing
 * secret and the approvals store token. Not shared with either: the point of
 * separate secrets here is that a leak of one cannot do the other's job, and
 * this one can empty the audit log.
 *
 * **Unset means the endpoint does not exist.** Not "open", and not "500 on
 * use": `server.ts` never routes to this module without a token, so an
 * unconfigured deployment answers 404 exactly as it would for any other path,
 * and `/health` reports `reset: "disabled"` so that the 404 has an
 * explanation somebody can find. A reset endpoint that an unauthenticated
 * caller can reach on a public URL is a denial-of-demo button, and one that
 * fails open on a missing variable is the same button with a longer fuse.
 */
import type { Database } from "bun:sqlite";

import type { PolicyCache } from "./policy-cache.ts";
import { counts, readRevision, replacePolicy, type Seed } from "./policy-store.ts";

export const RESET_PATH = "/admin/reset";

export const RESET_MODES = ["policy", "demo"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** Tables `demo` empties beyond the four `policy` replaces. */
const DEMO_TABLES = ["grants", "approval_requests", "audit_log"] as const;

export interface ResetDeps {
  db: Database;
  cache: PolicyCache;
  /** The fixture compiled into *this* image. Never re-read from disk. */
  seed: Seed;
  log: (line: string) => void;
}

export interface ResetResult {
  mode: ResetMode;
  revision: number;
  counts: { before: Record<string, number>; after: Record<string, number> };
}

/**
 * Both modes, in one transaction, followed by an immediate cache reload.
 *
 * The reload is not decoration. The background poll would pick the new
 * revision up within `POLICY_POLL_MS` anyway, but the caller is a presenter
 * about to start an act: reloading here means the revision in the response is
 * the revision being served, rather than one that will be served shortly.
 */
export function runReset(mode: ResetMode, deps: ResetDeps): ResetResult {
  const { db, cache, seed, log } = deps;
  const before = counts(db);

  db.transaction(() => {
    replacePolicy(db, seed);
    if (mode === "demo") clearDemoState(db);
  })();

  const state = cache.reload();
  const revision = readRevision(db);
  const after = counts(db);
  log(
    `RESET (${mode}): policy replaced from the fixture at revision ${revision} — ` +
      Object.entries(after)
        .map(([table, n]) => `${table} ${before[table] ?? 0}→${n}`)
        .join(", ") +
      `; cache ${state.status}`,
  );
  return { mode, revision, counts: { before, after } };
}

/**
 * Empties what the demo accumulated.
 *
 * `audit_log` carries triggers that refuse `UPDATE` and `DELETE` — append-only
 * enforced by the database rather than by convention, so that a compliance
 * reviewer does not have to trust that nobody ran an `UPDATE`. Emptying it
 * therefore has to drop the delete trigger and put it back, inside the same
 * transaction, and that awkwardness is the design working: the one code path
 * allowed to shorten this table has to say so in a way a reader cannot skim
 * past, and it is authorized by a secret of its own.
 *
 * `sqlite_sequence` is deliberately left alone, so `seq` keeps climbing across
 * a reset. A panel reconnects with `last-event-id`, and rewinding the counter
 * would make a live subscriber's anchor point into a future that now belongs
 * to different rows. An empty table whose next row is numbered 5001 reads
 * exactly as empty on every surface.
 */
function clearDemoState(db: Database): void {
  db.exec("DROP TRIGGER IF EXISTS audit_log_is_append_only_delete");
  try {
    for (const table of DEMO_TABLES) db.exec(`DELETE FROM ${table}`);
  } finally {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS audit_log_is_append_only_delete BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`,
    );
  }
}

/** `mode` from the request body or the query string. Default is the narrow one. */
export function parseMode(raw: unknown): ResetMode | null {
  if (raw === undefined || raw === null || raw === "") return "policy";
  return RESET_MODES.includes(raw as ResetMode) ? (raw as ResetMode) : null;
}

/**
 * The HTTP shape. `server.ts` has already checked the bearer and that a token
 * is configured at all; this is parse, run, report.
 */
export async function handleReset(
  request: Request,
  url: URL,
  deps: ResetDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let raw: unknown = url.searchParams.get("mode") ?? undefined;
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (body !== null && typeof body === "object" && "mode" in body) raw = body.mode;
    } catch (cause) {
      return Response.json({ error: `body is not JSON: ${String(cause)}` }, { status: 400 });
    }
  }

  const mode = parseMode(raw);
  if (mode === null) {
    return Response.json(
      { error: `mode must be one of ${RESET_MODES.join(", ")}`, got: raw },
      { status: 400 },
    );
  }

  const result = runReset(mode, deps);
  return Response.json({
    ...result,
    // Named on every response, in both modes, because the alternative is a
    // presenter who ran "demo" and believes the loan book is back to seed.
    not_reset: {
      "loans.db": "owned by apps/loan-app; reset with that service's own endpoint",
      "idp.db": "never reset from here — it holds the OAuth client Arcade is registered against",
    },
  });
}

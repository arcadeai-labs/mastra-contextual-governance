/**
 * `POST /admin/reset` — the loan book back to the rows this build ships,
 * without a deploy and without a shell.
 *
 * `loans.db` sits on a Render disk and seeds only when it has no schema (#29),
 * so a loan approved on stage is still approved after a restart. That is the
 * right behaviour and it left one gap: between two takes of the demo there was
 * no way back. Deleting the file needs a shell, and the shell attaches to
 * whichever instance Render feels like — the same trap `apps/hooks` documents
 * at length in its own `reset-api.ts`, where two of three manual reseeds wrote
 * the wrong rows because they ran against a rolled-back image. So this is an
 * endpoint, served by the process that is running, seeding from the fixture
 * compiled into *it*.
 *
 * ## What it does
 *
 * Empties `loan_decisions` and `loans` and inserts the fixture again, in one
 * transaction. Afterwards the book is exactly what a fresh disk comes up with:
 * `LN-2291` pending, `LN-2299` pending, every decision recorded since gone.
 *
 * `sqlite_sequence` is deliberately left alone, so `loan_decisions.id` keeps
 * climbing across a reset rather than handing a second take the same row ids
 * as the first. An empty table whose next row is numbered 40 reads exactly as
 * empty.
 *
 * Nothing else in this service changes shape for it. There is no flag on a
 * loan saying it was seeded, no bypass on the decision path, and no caller
 * identity involved: the reset is a maintenance door on the storage, not a new
 * thing the domain knows about.
 *
 * ## Authorization
 *
 * Its own bearer, `RESET_TOKEN`, and **unset means the route does not exist**.
 * Not "open", not "500 on use": `index.ts` answers 404 exactly as it would for
 * any other unknown path, and `/health` reports `reset: "disabled"` so the 404
 * has an explanation somebody can find. An endpoint that empties the bank's
 * system of record and is reachable unauthenticated on a public URL is a
 * denial-of-demo button; one that fails open on a missing variable is the same
 * button with a longer fuse.
 *
 * The same variable name and the same rules as `apps/hooks` and `apps/idp`, so
 * one value configures the three and `bun run reset` at the repo root presents
 * one bearer to all of them (#23).
 */
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";

import { countLoans, fixtureLoans, seed } from "./db.ts";

export const RESET_PATH = "/admin/reset";

export interface ResetCounts {
  loans: number;
  decisions: number;
}

export interface ResetResult {
  before: ResetCounts;
  after: ResetCounts;
}

function countDecisions(db: Database): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM loan_decisions").get();
  return row?.n ?? 0;
}

function counts(db: Database): ResetCounts {
  return { loans: countLoans(db), decisions: countDecisions(db) };
}

/**
 * Delete, then re-insert, in one transaction.
 *
 * `loan_decisions` goes first: it references `loans(loan_id)` and the service
 * opens the database with `PRAGMA foreign_keys = ON`, so the other order is a
 * constraint failure rather than a subtle bug.
 *
 * `seed` opens a transaction of its own. `bun:sqlite` nests that as a
 * SAVEPOINT, so the delete and the insert commit together or not at all —
 * which is what keeps a failed reset from leaving an empty book behind. A
 * half-applied reset is the one outcome worth ruling out here: an empty
 * `loans` table still has a schema, so the next boot would read it as seeded
 * and come up green with no loans in it.
 */
export function resetLoanBook(db: Database): ResetResult {
  const before = counts(db);

  db.transaction(() => {
    db.exec("DELETE FROM loan_decisions");
    db.exec("DELETE FROM loans");
    seed(db, fixtureLoans());
  })();

  return { before, after: counts(db) };
}

/**
 * Constant-time bearer check. Both sides are hashed first so the comparison
 * gets two equal-length buffers whatever was presented.
 */
export function bearerIs(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return token.length > 0 && timingSafeEqual(digest(token), digest(expected));
}

/**
 * The HTTP shape. `index.ts` has already checked that a token is configured at
 * all and that the caller presented it.
 *
 * The response names what did **not** move as well as what did, for the same
 * reason `apps/hooks`' does: a presenter who resets one service and assumes
 * the other two followed is about to go on stage with half a demo.
 */
export function handleReset(request: Request, db: Database): Response {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { before, after } = resetLoanBook(db);

  return Response.json({
    service: "loan-app",
    reset: "loans.db",
    counts: { before, after },
    not_reset: {
      "governance.db": "owned by apps/hooks; reset with that service's own endpoint",
      "idp.db": "owned by apps/idp; its reset never touches the OAuth client Arcade holds",
    },
  });
}

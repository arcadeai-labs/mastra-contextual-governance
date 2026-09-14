/**
 * The bank's system of record. Owns `loans.db` and serves the loan book over
 * plain HTTP:
 *
 *     GET  /loans?status=&min_amount=&max_amount=
 *     GET  /loans/:loan_id
 *     POST /loans/:loan_id/approve   { amount }
 *     POST /loans/:loan_id/deny      { reason }
 *     GET  /health
 *     POST /admin/reset              the seeded book back (bearer RESET_TOKEN)
 *
 * It looks like a bank's internal loan origination API and knows nothing
 * about governance: it does not check authority, withhold fields, or consult
 * anything before applying a write. That is the whole point — the controls
 * live outside it, in a control plane it cannot influence, and the tools that
 * call it (`tools/loan`) are stateless clients that hold no state of their
 * own. Anything that would check a caller belongs in `apps/hooks`.
 *
 * Every route under `/loans` requires a bearer token, and the actor recorded
 * on a decision is read off that token — never off the request body. See
 * `actor.ts`.
 *
 * This service depends on nothing under `packages/` on purpose: it is the part
 * a forker throws away and replaces with their own domain.
 */
import { z } from "zod";

import { ActorError, actorFromRequest } from "./actor.ts";
import { countLoans, getLoan, openLoanBook, recordDecision, searchLoans } from "./db.ts";
import { orExitConfig, publicHost } from "./public-host.ts";
import { bearerIs, handleReset, RESET_PATH } from "./reset.ts";

const SERVICE = "loan-app";

const port = Number(process.env.PORT ?? 8082);
const dbPath = process.env.LOANS_DB_PATH ?? "./loans.db";
// Blank is a state, not a default: with no value the reset route does not
// exist at all and /health says so. There is no development fallback, because
// a published one would be the same as no bearer. See `reset.ts`.
const resetToken = process.env.RESET_TOKEN?.trim() ?? "";
// Before the database is opened and before the port is bound: an address this
// service cannot possibly reach is a startup failure, not a 503 on the first
// call. See `public-host.ts` for what Render's `fromService` actually emitted.
const idpHost = orExitConfig(SERVICE, () =>
  publicHost("IDP_PUBLIC_HOST", process.env.IDP_PUBLIC_HOST, "localhost:8083"),
);

const db = openLoanBook(dbPath);

const searchQuery = z.object({
  status: z.enum(["pending", "approved", "denied"]).optional(),
  min_amount: z.coerce.number().nonnegative().optional(),
  max_amount: z.coerce.number().nonnegative().optional(),
});

// `.strict()` on both: an unknown field is a 400, not something quietly
// ignored. In particular a body that tries to name its own actor is refused.
const approveBody = z.object({ amount: z.number().positive() }).strict();
const denyBody = z.object({ reason: z.string().min(1) }).strict();

const LOAN_PATH = /^\/loans\/([^/]+)(?:\/(approve|deny))?$/;

function error(status: number, message: string, issues?: unknown): Response {
  return Response.json(issues === undefined ? { error: message } : { error: message, issues }, {
    status,
  });
}

function noSuchLoan(loanId: string): Response {
  return error(404, `No loan application found with ID ${loanId}.`);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function handleLoans(request: Request, url: URL): Promise<Response> {
  // Resolve the route and check the method before asking who is calling, so
  // that a wrong verb is a 405 whether or not a token came with it.
  const match = url.pathname === "/loans" ? null : LOAN_PATH.exec(url.pathname);
  if (url.pathname !== "/loans" && match === null) return error(404, "Not found");

  const action = match?.[2];
  const expected = action === undefined ? "GET" : "POST";
  if (request.method !== expected) return error(405, "Method not allowed");

  const actor = await actorFromRequest(request, idpHost);

  if (match === null) {
    const query = searchQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return error(400, "Invalid query", query.error.issues);

    const { status, min_amount, max_amount } = query.data;
    const results = searchLoans(db, {
      ...(status !== undefined && { status }),
      ...(min_amount !== undefined && { min_amount }),
      ...(max_amount !== undefined && { max_amount }),
    });
    return Response.json({ count: results.length, loans: results });
  }

  const loanId = decodeURIComponent(match[1]!);

  if (action === undefined) {
    const loan = getLoan(db, loanId);
    return loan === null ? noSuchLoan(loanId) : Response.json(loan);
  }

  const raw = await readJson(request);
  if (action === "approve") {
    const body = approveBody.safeParse(raw);
    if (!body.success) return error(400, "Invalid body", body.error.issues);

    const loan = recordDecision(db, {
      loan_id: loanId,
      decision: "approved",
      amount: body.data.amount,
      reason: null,
      decided_by: actor,
    });
    return loan === null ? noSuchLoan(loanId) : Response.json(loan);
  }

  const body = denyBody.safeParse(raw);
  if (!body.success) return error(400, "Invalid body", body.error.issues);

  const loan = recordDecision(db, {
    loan_id: loanId,
    decision: "denied",
    amount: null,
    reason: body.data.reason,
    decided_by: actor,
  });
  return loan === null ? noSuchLoan(loanId) : Response.json(loan);
}

const server = Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: SERVICE,
        loans: countLoans(db),
        // Named even when it is off, so a 404 from POST /admin/reset has
        // somewhere to be explained rather than looking like a typo.
        reset: resetToken.length > 0 ? "enabled" : "disabled",
      });
    }

    if (url.pathname === RESET_PATH) {
      // A 404 and not a 403 when unset, so a deployment that never configured
      // this is indistinguishable from one that never had the route.
      if (resetToken.length === 0) return error(404, "Not found");
      if (!bearerIs(request, resetToken)) return error(401, "Unauthorized");
      return handleReset(request, db);
    }

    if (url.pathname === "/loans" || url.pathname.startsWith("/loans/")) {
      try {
        return await handleLoans(request, url);
      } catch (cause) {
        if (cause instanceof ActorError) return error(cause.status, cause.message);
        throw cause;
      }
    }

    return error(404, "Not found");
  },
});

console.log(
  `[${SERVICE}] listening on :${server.port} — ${countLoans(db)} loans in ${dbPath}, ` +
    `tokens validated against ${idpHost}`,
);
console.log(
  resetToken.length > 0
    ? `[${SERVICE}] POST ${RESET_PATH} is enabled (bearer RESET_TOKEN)`
    : `[${SERVICE}] POST ${RESET_PATH} is disabled: RESET_TOKEN is unset, so the route answers 404`,
);

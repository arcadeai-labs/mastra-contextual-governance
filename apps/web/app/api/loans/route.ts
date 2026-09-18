/**
 * `GET /api/loans` — the loan book, for the bank's own screens.
 *
 * Cookie-bound and server-side, which is the whole of its security story: the
 * IdP bearer lives in a sealed, HTTP-only cookie this process can open and the
 * browser cannot, so the browser asks this route and this route asks
 * `apps/loan-app` as whoever is signed in. There is no parameter on this route
 * — no persona, no id, no filter — because every one of them would be a way for
 * the caller to name somebody else's loan book.
 *
 * Both surfaces poll it (`lib/loan-context/loans.ts` → `LOAN_POLL_INTERVAL_MS`):
 * the `/` cards beside the chat, and the `/loans` board on the presenter's
 * second screen. One route, one interval, so a decision made in the chat shows
 * up on both within the same tick.
 *
 * **Nothing on this path is governed and the body never says it is.** No hook
 * runs, no audit row is written, and the four states the body can carry are
 * loaded, signed-out, expired and unavailable — see `LoanBookState`. A screen
 * that said "denied" here would be asserting a control-plane action that never
 * happened, which is the mislabelling this project is organised against.
 */
import { readSession, writeSession, type Session } from "../../../lib/identity/session.ts";
import { readIdentitySurface } from "../../../lib/config.ts";
import { readLoanBook } from "../../../lib/loan-context/read.ts";

/** Reads a cookie and a live loan book. Never prerendered, never cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = readIdentitySurface();
  const session = await readSession(request, config);
  const headers = new Headers({ "cache-control": "no-store" });

  // A route handler is the one place that *can* store a renewed bearer, which
  // is why the renewal lives here and not in the server component that paints
  // first. Only reachable on a deployment whose `IDP_SCOPES` asks for
  // `offline_access`; the default never issues a refresh token (measured
  // 2026-09-18, `lib/identity/session.ts`).
  const renewed: Session[] = [];
  const state = await readLoanBook(session, {
    idp: {
      issuer: config.identity.idpIssuer,
      clientId: config.identity.idpClientId,
      clientSecret: config.identity.idpClientSecret,
    },
    onRenewed: (next) => {
      renewed.push(next);
    },
  });
  const stored = renewed[0];
  if (stored !== undefined) await writeSession(headers, request, stored, config);

  return Response.json(state, { status: STATUS[state.status], headers });
}

/**
 * The status line, matched to what the body already says.
 *
 * A body a browser has to read either way, and a code a proxy, a log and a
 * `curl` can read without parsing JSON. `401` for both ways of having nobody to
 * read as, `503` for a loan book that did not answer — and never `403`, which
 * would be this route claiming something was refused.
 */
const STATUS = {
  loaded: 200,
  "signed-out": 401,
  expired: 401,
  unavailable: 503,
} as const;

/**
 * `/loans` — the loan board, full-screen and on its own.
 *
 * `DESIGN.md` → Design: the bank app is full-screen at `/`, the control plane
 * at `/panel`, and the loan board here, and the presenter switches between them
 * deliberately. The board is the business outcome with nothing about governance
 * anywhere on it — deliberately quiet, so pointing at it is pointing at the
 * loan book and not at the demo.
 *
 * A **server** component, for the same reason `/` is one: the IdP bearer in the
 * sealed cookie never reaches the browser. It reads the loan book once here, so
 * the first paint is already correct, and hands it down as `initial`; the board
 * polls `GET /api/loans` from then on.
 *
 * It does not renew an aging bearer, because a server component cannot store
 * the result — `app/api/loans/route.ts` can, and the first poll is two seconds
 * away.
 */
import { cookies } from "next/headers";

import { readIdentitySurface } from "../../lib/config.ts";
import { readSessionFromCookies } from "../../lib/identity/session.ts";
import { readLoanBook } from "../../lib/loan-context/read.ts";
import { LoanBoard } from "../../components/bank/LoanBoard.tsx";

/** Reads a session cookie and a live loan book. A prerender of either is fiction. */
export const dynamic = "force-dynamic";

export default async function Loans() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  const loans = await readLoanBook(session);

  return <LoanBoard initial={loans} signedInAs={session?.email ?? null} />;
}

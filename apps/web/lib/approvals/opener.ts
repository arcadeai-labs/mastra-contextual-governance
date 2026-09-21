/**
 * Who opened `/approvals/{id}`.
 *
 * This module is #180 in one function. Until it existed the page took its
 * identity from `cg_persona` and, **with no cookie set at all, defaulted to the
 * routed approver** — so Alice, opening her own escalation's link in her own
 * browser, was acting as Charlie. `pre.decide-not-by-the-requester` was never
 * broken; it was never asked about her. Every downstream control then behaved
 * correctly on a subject that did not correspond to anybody, and the audit row
 * named a person who was not present.
 *
 * The identity is the **sealed IdP session** and nothing else — the same one
 * `/` has read since #176, unsealed server-side, never reconstructed from
 * anything the browser can write. There is deliberately no fallback: an opener
 * with no session is *signed out*, not "probably the approver". A default that
 * guesses an identity is the defect, not a convenience, and it is the reason a
 * browser-chosen persona is gone from the one page where identity is
 * load-bearing.
 *
 * ## Signed out is a sign-in, not an error
 *
 * A Slack link is routinely opened in a browser with no session, so that is an
 * ordinary case and reads as one: the opener is offered a sign-in that returns
 * them to this exact link. `SIGNIN_PATH` and `safeNext` already do the round
 * trip — `safeNext` accepts a same-origin path and `signinCallback` redirects
 * to it — so there is no second mechanism here, only the `next` that flow
 * already takes.
 *
 * What a signed-out opener is *shown* is settled in `view.tsx`: the same
 * request details a signed-in one sees, with a different control. Reading is
 * not deciding, and whether the link should disclose the request at all is a
 * separate question that is not this slice's.
 */
import type { IdentitySurface } from "../config.ts";
import { readIdentitySurface } from "../config.ts";
import { SIGNIN_PATH } from "../identity/handlers.ts";
import { readSessionFromCookies } from "../identity/session.ts";

/**
 * Who the page is acting as.
 *
 * Two states and no third. "Signed in as somebody the control plane has never
 * heard of" is not one of them: an unknown subject is carried through and
 * fails closed at `/pre`, which is the control answering rather than this
 * module pre-empting it. A page that filtered the roster here would be
 * deciding authorization in the one place `approvals-store.ts` says it must
 * never be decided.
 */
export type Opener =
  /** `email` is the join key: Arcade `user_id`, OAuth subject, loan-book actor. */
  | { state: "signed-in"; email: string }
  /** Where to send them, so they come back to the link they were sent. */
  | { state: "signed-out"; signInUrl: string };

/** The page a request id resolves to. One spelling, used by the link and the return trip. */
export function approvalPath(requestId: string): string {
  return `/approvals/${encodeURIComponent(requestId)}`;
}

/**
 * Sign in, and come back *here*.
 *
 * Same-origin and path-only, which is what `safeNext` will accept; anything
 * else it drops on the floor and the opener lands somewhere they did not ask
 * for.
 */
export function signInToDecideUrl(requestId: string): string {
  return `${SIGNIN_PATH}?next=${encodeURIComponent(approvalPath(requestId))}`;
}

/** The shape `next/headers`' `cookies()` answers with, as much as this reads of it. */
export interface CookieJar {
  getAll(): Array<{ name: string; value: string }>;
}

/**
 * Unseal this browser's session and say who is deciding.
 *
 * Every failure — no cookie, a missing chunk, a value sealed under a different
 * `SESSION_SECRET`, a tampered byte — comes back as *signed out*, because
 * that is what all of them mean and it is the only state that is always safe.
 */
export async function readOpener(
  jar: CookieJar,
  requestId: string,
  config: IdentitySurface = readIdentitySurface(),
): Promise<Opener> {
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  return session === null
    ? { state: "signed-out", signInUrl: signInToDecideUrl(requestId) }
    : { state: "signed-in", email: session.email };
}

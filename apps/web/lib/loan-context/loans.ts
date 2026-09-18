/**
 * The loan book as the bank's own screens show it: the `/` cards and the
 * `/loans` board.
 *
 * ## Why this is a direct read
 *
 * Until 2026-09-18 these screens read the loan book through the Arcade gateway,
 * and the argument for it stood here: a second, ungoverned path into the same
 * data, beside a control plane claiming there is only one. #157 retires that
 * argument, and `DESIGN.md` → Business system records the reversal. The
 * governed read cost two `Loan_GetLoan` calls on every page load, so the panel
 * showed tool calls before the presenter had said anything and the audience
 * could not tell the agent's work from the page's chrome; and because a page
 * load was the only read, an approval the agent had just made never appeared on
 * the card beside the chat. The answer is scope, not volume: the thesis is
 * about the **agent's** path, the bank's own screen for an authenticated human
 * is not that path, and after this change every MCP call in the demo starts in
 * the chat. Act 3 is not undercut either — no field this module carries is one
 * `/post` redacts, by construction rather than by habit (see
 * {@link LoanCard}).
 *
 * One rule survives the reversal intact: **the read is attributable to a person
 * or it does not happen.** `read.ts` calls `apps/loan-app` with the IdP bearer
 * from this browser's own sign-in and there is no service credential anywhere
 * on the path.
 *
 * This module is imported by client components, so it holds types and constants
 * and nothing that could reach a network or a file.
 */

/**
 * The two applications the `/` cards show. `DESIGN.md` → Cast, and #91 for the
 * control.
 *
 * - `LN-2291`, Northwind Bakery LLC, $95,000 — acts 2, 3 and 4.
 * - `LN-2299`, Meridian Physical Therapy, $88,000 — the control, without the
 *   injected note, which is what lets a failed run be read as "the injection
 *   interfered" rather than "the agent broke".
 *
 * The `/loans` board shows the whole book instead; these two are what sits
 * beside the chat.
 */
export const DEMO_LOAN_IDS = ["LN-2291", "LN-2299"] as const;

/**
 * How often the cards and the board ask again.
 *
 * Two seconds, which is the number the issue starts from and the one a
 * rehearsal can feel: an approval made in the chat, or by Charlie on the
 * approval page, is on every open screen before the presenter has finished the
 * sentence. Named rather than typed at three call sites, because the browser
 * test measures against this constant and a poll nobody can point at is a poll
 * somebody will quietly double.
 */
export const LOAN_POLL_INTERVAL_MS = 2_000;

/** The route both surfaces poll. Same address, same interval, one implementation. */
export const LOANS_ROUTE = "/api/loans";

/**
 * One application, as the bank's own screens are allowed to see it.
 *
 * An **allow-list**, not a filter. `apps/loan-app` returns
 * `bank_account_number`, `tax_id` and `underwriter_notes` on its detail route —
 * a loan origination system holds them and ours does too — and the projection
 * in `read.ts` builds this object field by field rather than deleting three
 * from a record. A field added to the loan book therefore does not appear here
 * by default, which is the direction this screen wants to fail in: act 3's
 * subject may never reach a projector because somebody widened a type.
 */
export interface LoanCard {
  loan_id: string;
  borrower_name: string;
  /** Dollars. */
  amount: number;
  /** `pending` | `approved` | `denied`, as the loan book spells it. */
  status: string;
  purpose: string;
  submitted_at: string;
  credit_score: number;
  annual_revenue: number;
  years_in_business: number;
  /**
   * Who recorded the most recent decision, as `apps/loan-app` derived it from
   * that caller's own token. `null` when nothing has been decided, and also on
   * the seeded decisions that predate the system and name nobody.
   */
  decided_by: string | null;
  /**
   * The same person as a name a room can read — `Charlie` — when this
   * deployment's `PERSONA_*_EMAIL` variables name somebody at that address.
   *
   * `null` otherwise, and the card falls back to the address. A label that can
   * be wrong is worse than a label that is missing (`lib/identity/roster.ts`),
   * and the address is the join key in any case.
   */
  decided_by_name: string | null;
  /** ISO 8601, as the loan book recorded it. `null` when nothing was decided. */
  decided_at: string | null;
}

/**
 * What one read of the loan book produced — the body of `GET /api/loans`, and
 * the prop the server component hands the first paint.
 *
 * Four states, kept apart for the reason this repo keeps everything apart: they
 * are four different claims about the world and only one of them is the reader's
 * to act on. In particular **none of them is a governance decision.** No hook
 * runs on this path, so a screen here may never say denied, refused, or
 * blocked: an expired sign-in is a sign-in to do again, and an unreachable loan
 * book is plumbing.
 */
export type LoanBookState =
  | { status: "loaded"; actor: string; loans: LoanCard[] }
  /** Nobody is signed in on this browser. */
  | { status: "signed-out"; message: string }
  /** Somebody is, but the IdP bearer is gone, expired, or refused. Sign in again. */
  | { status: "expired"; message: string }
  /** The loan book did not answer. Nothing decided anything. */
  | { status: "unavailable"; message: string };

/** Every `LoanBookState` tag, so a reader can tell a body apart from a stray 404 page. */
const STATES = ["loaded", "signed-out", "expired", "unavailable"] as const;

/**
 * A `LoanBookState` out of whatever the route answered with, or `null`.
 *
 * The browser parses this, so it is written as a check rather than a cast: a
 * proxy's error page, a Next error boundary or a rolled-back deployment all
 * answer JSON that is not this, and rendering `undefined` loans as an empty
 * board would be the screen claiming the bank has no applications.
 */
export function asLoanBookState(value: unknown): LoanBookState | null {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "string" || !STATES.includes(status as (typeof STATES)[number])) return null;
  if (status === "loaded") {
    const { actor, loans } = value as { actor?: unknown; loans?: unknown };
    if (typeof actor !== "string" || !Array.isArray(loans)) return null;
    return { status: "loaded", actor, loans: loans as LoanCard[] };
  }
  const message = (value as { message?: unknown }).message;
  return {
    status: status as "signed-out" | "expired" | "unavailable",
    message: typeof message === "string" ? message : "",
  };
}

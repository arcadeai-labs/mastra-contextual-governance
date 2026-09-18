/**
 * The loan book, read from `apps/loan-app` over HTTP **as the person holding
 * this browser**.
 *
 * ## Why this is not a governed read any more
 *
 * It was one until 2026-09-18, and the argument for it lived in this file: a
 * screen that reached past the hooks would be a second, ungoverned path into
 * the same data beside a panel asserting there is only one. #157 retires that
 * argument and `DESIGN.md` → Business system records the reversal.
 * `lib/loan-context/loans.ts` states the new reasoning in full; the short form
 * is that the thesis is about the agent's path, the bank's own screen for an
 * authenticated human is not that path, and routing it through the gateway cost
 * two `Loan_GetLoan` calls on every page load — tool calls on the panel before
 * the presenter had spoken, and cards that never moved when the agent approved
 * something.
 *
 * ## Who the read is made as
 *
 * The IdP access token from this browser's own sign-in, and nothing else. There
 * is no service credential here and there must never be one: `apps/loan-app`
 * derives the actor from the bearer at `/oauth2/userinfo` (`apps/loan-app/src/
 * actor.ts`, `DESIGN.md` rule 1), so a read made with a shared secret would be
 * a read nobody can be named for. No branch in this file takes an identity from
 * a query string, a body or a header — the same rule the chat route and the
 * verifier hold to. The session is unsealed by the route that owns the cookie
 * and passed in.
 *
 * ## What it costs
 *
 * One `GET /loans` for the book, then one `GET /loans/:id` per application,
 * because `decided_by` and `decided_at` live on the detail route and
 * `apps/loan-app` is out of this slice's scope. Nine requests to a local SQLite
 * service per poll, against a fixture of eight loans. Stated rather than hidden:
 * if the book ever grows, this is the line that has to change.
 */
import { personaFor } from "../identity/roster.ts";
import { refreshIdpToken, tokenExpiry } from "../identity/oidc.ts";
import { withIdpToken, type IdpToken, type Session } from "../identity/session.ts";
import { publicHost } from "../public-host.ts";
import type { LoanBookState, LoanCard } from "./loans.ts";

/**
 * Renew this many milliseconds before the recorded expiry rather than after it.
 *
 * `expires_at` is this service's note to itself; the only clock that decides is
 * the IdP's. A margin means an ordinary poll does not spend its round trip
 * discovering that a token died half a second ago.
 */
const RENEW_BEFORE_MS = 30_000;

/** Hosts are HOST-form; the consumer adds the scheme, the same way `apps/loan-app` does. */
export function loanAppBaseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}

/**
 * `LOAN_APP_PUBLIC_HOST`, refused if it is not an address anything can reach.
 *
 * Read through `publicHost` like every other cross-service address in this
 * repo: Render's `fromService` emits a bare service name, a human typing one by
 * hand produces the same thing, and the failure is a DNS error that reads as
 * "the loan book is down" (#59).
 */
export function loanAppHost(env: Record<string, string | undefined> = process.env): string {
  return publicHost("LOAN_APP_PUBLIC_HOST", env.LOAN_APP_PUBLIC_HOST, "localhost:8082");
}

export interface ReadLoanBookOptions {
  /** HOST-form. Defaults to `LOAN_APP_PUBLIC_HOST`. */
  host?: string;
  /** Where the personas live, for renewing a bearer. Defaults to the environment. */
  idp?: { issuer: string; clientId: string; clientSecret: string };
  /**
   * Called when the bearer was renewed, so the caller can reseal the cookie.
   *
   * Only a route handler can. A server component that renews and cannot store
   * the result would spend a refresh token per page load, so the first paint
   * passes nothing here and lets the first poll do it.
   */
  onRenewed?: (session: Session) => void;
  /** Only for tests, which need to see what was actually asked for. */
  onRequest?: (request: { path: string; authorization: string | null }) => void;
}

/** What `apps/loan-app` answers `GET /loans` with, as far as this reads it. */
interface LoanSummary {
  loan_id?: unknown;
}

/** The detail route's record, as far as this reads it. Everything else is ignored. */
interface LoanDetail {
  loan_id?: unknown;
  borrower_name?: unknown;
  amount?: unknown;
  status?: unknown;
  purpose?: unknown;
  submitted_at?: unknown;
  credit_score?: unknown;
  annual_revenue?: unknown;
  years_in_business?: unknown;
  decisions?: unknown;
}

/**
 * The whole book, projected.
 *
 * Total: nothing here throws. The caller is a route handler answering a poll
 * every two seconds and a server component rendering a page with a chat and a
 * panel on it; a loan book that cannot be reached costs the cards, not the
 * screen.
 */
export async function readLoanBook(
  session: Session | null,
  options: ReadLoanBookOptions = {},
): Promise<LoanBookState> {
  if (session === null) {
    return {
      status: "signed-out",
      message: "Nobody is signed in on this browser, so there is no one to read the loan book as.",
    };
  }

  const held = await usableToken(session, options);
  if (held === null) {
    return {
      status: "expired",
      message:
        `This browser's sign-in as ${session.email} no longer carries a token the loan system ` +
        `accepts. Nothing was refused by policy — sign in again to read the loan book.`,
    };
  }

  let base: string;
  try {
    base = loanAppBaseUrl(options.host ?? loanAppHost());
  } catch (cause) {
    return { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
  }

  const list = await ask(base, "/loans", held, options);
  if (list.outcome === "unauthorized") return expiredFor(session.email);
  if (list.outcome === "failed") return { status: "unavailable", message: list.message };

  const ids = idsOf(list.body);
  if (ids === null) {
    return {
      status: "unavailable",
      message: "The loan book answered with something this screen could not read as a list of applications.",
    };
  }

  const details = await Promise.all(
    ids.map((id) => ask(base, `/loans/${encodeURIComponent(id)}`, held, options)),
  );

  const loans: LoanCard[] = [];
  for (const detail of details) {
    if (detail.outcome === "unauthorized") return expiredFor(session.email);
    // A single missing application is not an outage: the book may have been
    // reset between the list and the read. A transport failure is, and it is
    // the caller's whole answer rather than a card that silently vanishes.
    if (detail.outcome === "failed") {
      if (detail.status === 404) continue;
      return { status: "unavailable", message: detail.message };
    }
    const card = projectLoan(detail.body);
    if (card !== null) loans.push(card);
  }

  return { status: "loaded", actor: session.email, loans };
}

function expiredFor(email: string): LoanBookState {
  return {
    status: "expired",
    message:
      `The loan system did not accept this browser's sign-in as ${email}. Nothing was refused by ` +
      `policy — sign in again to read the loan book.`,
  };
}

/**
 * One request to the loan book, with the person's bearer on it.
 *
 * `unauthorized` is kept apart from every other failure because it is the only
 * one the reader can do something about, and because calling it an outage would
 * put "the loan book is down" on screen while the loan book was up and saying
 * no.
 */
type Asked =
  | { outcome: "ok"; body: unknown }
  | { outcome: "unauthorized" }
  | { outcome: "failed"; status: number; message: string };

async function ask(
  base: string,
  path: string,
  token: IdpToken,
  options: ReadLoanBookOptions,
): Promise<Asked> {
  const authorization = `Bearer ${token.access_token}`;
  options.onRequest?.({ path, authorization });
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: { authorization, accept: "application/json" },
      cache: "no-store",
    });
  } catch (cause) {
    return {
      outcome: "failed",
      status: 0,
      message:
        `The loan book at ${base} could not be reached: ` +
        `${cause instanceof Error ? cause.message : String(cause)}.`,
    };
  }

  if (response.status === 401) return { outcome: "unauthorized" };
  if (!response.ok) {
    return {
      outcome: "failed",
      status: response.status,
      message: `The loan book answered ${response.status} to ${path}.`,
    };
  }

  try {
    return { outcome: "ok", body: await response.json() };
  } catch {
    return { outcome: "failed", status: response.status, message: `The loan book's answer to ${path} was not JSON.` };
  }
}

/**
 * A bearer this read can use, renewing it first when the session holds the
 * means to.
 *
 * `null` means the reader has to sign in again, which is the only remedy on a
 * default deployment: measured 2026-09-18, `apps/idp` issues no refresh token
 * for `openid email`, so `IDP_SCOPES` has to name `offline_access` for the
 * renewal branch below to exist at all.
 */
async function usableToken(session: Session, options: ReadLoanBookOptions): Promise<IdpToken | null> {
  const held = session.idp;
  if (held === undefined || held.access_token.trim() === "") return null;
  if (held.expires_at > Date.now() + RENEW_BEFORE_MS) return held;
  if (held.refresh_token === undefined) return null;

  const idp = options.idp ?? {
    issuer: (process.env.IDP_ISSUER ?? "").trim().replace(/\/+$/, ""),
    clientId: (process.env.IDP_CLIENT_ID ?? "").trim(),
    clientSecret: (process.env.IDP_CLIENT_SECRET ?? "").trim(),
  };
  if (!idp.issuer || !idp.clientId) return null;

  const renewed = await refreshIdpToken({
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    refreshToken: held.refresh_token,
  });
  if (!renewed.ok) return null;

  const token: IdpToken = {
    access_token: renewed.token.access_token,
    ...(renewed.token.refresh_token ? { refresh_token: renewed.token.refresh_token } : {}),
    expires_at: tokenExpiry(renewed.token),
  };
  options.onRenewed?.(withIdpToken(session, token));
  return token;
}

/** The ids in `{ count, loans: [...] }`, in the order the book returned them. */
function idsOf(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const loans = (body as { loans?: unknown }).loans;
  if (!Array.isArray(loans)) return null;
  const ids: string[] = [];
  for (const entry of loans as LoanSummary[]) {
    if (typeof entry?.loan_id === "string" && entry.loan_id.trim() !== "") ids.push(entry.loan_id);
  }
  return ids;
}

/**
 * One detail record, field by field.
 *
 * Built rather than filtered, so `bank_account_number`, `tax_id` and
 * `underwriter_notes` are absent because nothing here names them — and a field
 * the loan book grows tomorrow is absent for the same reason. See
 * {@link LoanCard}.
 */
export function projectLoan(body: unknown): LoanCard | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as LoanDetail;
  if (typeof record.loan_id !== "string" || record.loan_id.trim() === "") return null;

  const latest = latestDecision(record.decisions);
  const decidedBy = latest?.decided_by ?? null;

  return {
    loan_id: record.loan_id,
    borrower_name: string(record.borrower_name),
    amount: number(record.amount),
    status: string(record.status),
    purpose: string(record.purpose),
    submitted_at: string(record.submitted_at),
    credit_score: number(record.credit_score),
    annual_revenue: number(record.annual_revenue),
    years_in_business: number(record.years_in_business),
    decided_by: decidedBy,
    decided_by_name: personaFor(decidedBy)?.name ?? null,
    decided_at: latest?.decided_at ?? null,
  };
}

/**
 * The last decision in the append-only history, which is the one the loan's
 * current status came from.
 *
 * `loan_decisions` is append-only by design (`apps/loan-app/src/db.ts`), so
 * approving twice leaves two rows; the card names the decision that stands.
 */
function latestDecision(value: unknown): { decided_by: string | null; decided_at: string | null } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const last = value[value.length - 1] as { decided_by?: unknown; decided_at?: unknown };
  return {
    decided_by: typeof last?.decided_by === "string" && last.decided_by.trim() !== "" ? last.decided_by : null,
    decided_at: typeof last?.decided_at === "string" && last.decided_at.trim() !== "" ? last.decided_at : null,
  };
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

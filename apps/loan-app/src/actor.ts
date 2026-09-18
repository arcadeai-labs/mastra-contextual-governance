/**
 * Who is calling. Derived from the bearer token and from nothing else.
 *
 * The API never takes an actor as a parameter: a request body that named its
 * own author would be one the caller could write anything into. Instead the
 * token is presented to the identity provider that issued it, and the email
 * the provider hands back is the actor. That is the same endpoint Arcade
 * itself identifies the user from, so the `user_id` the control plane governs
 * and the actor this service records are the same string by construction.
 *
 * Addresses are case-insensitive, so the one the provider returns is folded to
 * lower case before it is recorded (#58). Two systems that spell the same
 * person `Alice@…` and `alice@…` join on neither, and the
 * decision history would then describe two people where there is one.
 *
 * This is validation, not decision-making: a token either names someone or it
 * does not. What that someone may do is not asked here.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const userinfoSchema = z.object({ email: z.string().email() }).passthrough();

/**
 * A request that could not be attributed to anyone. 401 when the token is the
 * problem; 503 when the identity provider is, so that an outage upstream
 * reads as an outage and not as every caller's credentials failing at once.
 */
export class ActorError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 503 = 401,
  ) {
    super(message);
  }
}

/** Hosts are HOST-form (see `.env.example`); the consumer adds the scheme. */
function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}

// ---------------------------------------------------------------------------
// Remembering a resolution
// ---------------------------------------------------------------------------

/**
 * How long one token→email answer is reused, in milliseconds.
 *
 * The arithmetic, measured on the live deployment (#166). The bank's own
 * screens poll this API every 2 seconds and there are two of them — `/` and
 * the `/loans` board on a presenter's second display — so a single signed-in
 * person costs 2 × 30 = 60 introspections a minute, and each one is a request
 * the identity provider counts. Reusing an answer for T milliseconds turns
 * that into one call per T per person: at T = 60_000 it is 60/min → 1/min,
 * 59 of every 60 calls gone.
 *
 * **What the provider actually enforces**, measured 2026-09-18 against
 * `apps/idp` booted the way its Dockerfile boots it. Not Better Auth's own
 * default — `@better-auth/oauth-provider@1.7.2` declares a rule for this path
 * that overrides it:
 *
 *     pathMatcher: (path) => path === "/oauth2/userinfo",
 *     window: opts.rateLimit?.userinfo?.window ?? 60,
 *     max:    opts.rateLimit?.userinfo?.max    ?? 60
 *
 * **60 requests per 60-second window**, and the counter resets only after a
 * full window with *no allowed request* on that path — every allowed request
 * slides the window forward. A 2-second poll therefore never lets it reset: it
 * ratchets to the ceiling within a minute or two, depending on how many screens
 * are open, and then refuses everything for a minute. That is what stopped
 * sign-in — `apps/web` reads the same endpoint from the same bucket.
 *
 * **T therefore equals the window; it does not clear it.** There is no margin
 * here, and the thing that looks like margin is Better Auth's own default
 * (`window: 10`, `max: 100`, in `context/create-context.mjs`), which this path
 * never uses. What T = 60s actually buys is this:
 *
 *  - **One signed-in person is safe.** Their single cached answer expires, and
 *    the next 2-second poll re-resolves it, so calls land 60–62 seconds apart
 *    — just over the window, so the counter resets every time and never passes
 *    1. Measured at a 61-second interval: five calls, none refused.
 *  - **Four personas are not.** Four calls a minute spaced ~15 seconds apart
 *    never leave the window quiet, so the count still ratchets — to 60 in
 *    about fifteen minutes rather than about fifteen seconds, ending in a
 *    one-minute refusal window and roughly 6% of calls refused against ~80%
 *    before this existed.
 *
 * **A longer T does not close that.** Silence for a whole window means one
 * call per minute *in total*, so N signed-in people would need T ≥ N × 60s:
 * the requirement grows with the audience, which makes it a race rather than a
 * fix, and every second of it is staleness below. T = 60s is the smallest
 * value that keeps a lone person at one call per window, and the largest whose
 * staleness is still the one minute this file promises. Closing the residual
 * needs the thing this service cannot do from here: an explicit `rateLimit`
 * block at the provider (the rule above reads `?? 60`, so it is overridable
 * without touching token format or registration), or registering an
 * `oauthResource` so tokens are JWTs verified offline against `/jwks` and this
 * endpoint is not called at all. Both are #166, and both are the human's.
 *
 * **Staleness bound.** An answer may be up to {@link RESOLUTION_TTL_MS}
 * milliseconds — 60 seconds — older than the moment it is used. A token
 * revoked or expired at the provider therefore keeps naming its owner here for
 * at most one minute. Two things keep that bound from mattering:
 *
 *  1. Only reads are answered from memory. Anything that writes to the loan
 *     book asks the provider afresh, so no state changes on the strength of a
 *     remembered token — see {@link actorFromRequest}.
 *  2. A fresh answer replaces the remembered one, and a refusal erases it, so
 *     the first write after a revocation both fails and clears the reads.
 *
 * This is memoisation, not a session: nothing here decides anything, and the
 * worst it can do is attribute a read of the loan book to the person who was
 * holding that exact token up to a minute ago.
 */
export const RESOLUTION_TTL_MS = 60_000;

/**
 * How many resolutions are held at once. Four personas and a handful of
 * reissued tokens is the real working set; this is three orders of magnitude
 * above it, and exists so that a long-running process with a churn of tokens
 * cannot grow without bound. Oldest insertion goes first.
 */
const MAX_REMEMBERED = 512;

/**
 * Per-process, so a digest taken from this map means nothing anywhere else and
 * nothing survives a restart. Salting costs one `randomBytes` at boot.
 */
const digestSalt = randomBytes(32);

/**
 * What a remembered answer is filed under.
 *
 * Never the bearer itself. A map of live access tokens in process memory is a
 * credential store nobody designed and nobody is guarding: anything that can
 * read a heap dump, a debugger, or a careless log of this map would walk away
 * with working credentials. A salted SHA-256 digest is enough to recognise the
 * same token again and is worth nothing to whoever reads it.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(digestSalt).update(token).digest("hex");
}

interface Remembered {
  email: string;
  expiresAt: number;
}

const remembered = new Map<string, Remembered>();

/**
 * The keys currently held, so that "never the raw token" is something a test
 * measures rather than something this comment claims.
 */
export function rememberedKeys(): string[] {
  return [...remembered.keys()];
}

/** Drop everything. Used by tests to start from a known state. */
export function forgetRememberedActors(): void {
  remembered.clear();
}

function recall(key: string, now: number): string | undefined {
  const hit = remembered.get(key);
  if (hit === undefined) return undefined;
  if (now >= hit.expiresAt) {
    remembered.delete(key);
    return undefined;
  }
  return hit.email;
}

function remember(key: string, email: string, now: number): void {
  // Re-inserting moves the key to the end, which is what makes the eviction
  // below "oldest first" rather than "whatever Map happened to hold".
  remembered.delete(key);
  remembered.set(key, { email, expiresAt: now + RESOLUTION_TTL_MS });
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next();
    if (oldest.done === true) break;
    remembered.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------

/**
 * The email this request's bearer names.
 *
 * A read may be answered from the last minute's resolution; anything else asks
 * the identity provider. Nothing but a successful resolution is ever kept — a
 * 401, a 429 or an unreachable provider is passed straight to the caller and
 * erases whatever was held for that token, because remembering a refusal would
 * turn a provider having a bad minute into an outage that outlives it.
 *
 * `now` is a parameter so that the expiry is testable without waiting a minute
 * of wall clock; nothing in the service passes it.
 */
export async function actorFromRequest(
  request: Request,
  idpHost: string,
  now: number = Date.now(),
): Promise<string> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (match === null) throw new ActorError("A bearer token is required.");

  const key = tokenFingerprint(match[1]!);
  // A request that changes the loan book is resolved against the provider
  // every time. Reads are what the bank's screens poll, so they are where all
  // the traffic is, and a read is also the only thing a minute-old answer can
  // get wrong cheaply.
  const mayReuse = request.method === "GET" || request.method === "HEAD";
  if (mayReuse) {
    const known = recall(key, now);
    if (known !== undefined) return known;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl(idpHost)}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${match[1]}` },
    });
  } catch {
    remembered.delete(key);
    throw new ActorError("The identity provider could not be reached.", 503);
  }

  if (!response.ok) {
    remembered.delete(key);
    throw new ActorError("The identity provider rejected the token.");
  }

  const parsed = userinfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    remembered.delete(key);
    throw new ActorError("The token does not identify an email address.");
  }

  const email = parsed.data.email.trim().toLowerCase();
  remember(key, email, now);
  return email;
}

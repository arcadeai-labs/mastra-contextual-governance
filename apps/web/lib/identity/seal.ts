/**
 * The seal on every cookie this service writes, and the chunking that gets a
 * sealed value past the 4KB a browser will hold in one.
 *
 * `DESIGN.md` → **Gateway token storage**: the persona email and the gateway
 * access + refresh tokens live in a sealed, HTTP-only, per-browser cookie under
 * `SESSION_SECRET`. No fourth database. That decision puts two bearer tokens in
 * something the browser carries, so what "sealed" means has to be exact:
 *
 * - **AES-256-GCM**, so the cookie is unreadable *and* unforgeable without the
 *   key. A signed-but-readable cookie would put Alice's gateway token in her own
 *   DevTools, and a demo whose thesis is that controls live outside the model
 *   should not hand the browser a credential to read.
 * - **The key comes from the environment and nowhere else.** There is no
 *   development fallback. A default key in this file would be a key everyone
 *   has, and the failure it prevents — an unset variable — is one that should
 *   stop the service rather than quietly weaken it.
 * - **And the environment has to supply a real one.** `SESSION_SECRET=x` was
 *   accepted until round 1 of #84's review: `/health` said `configured`, the
 *   built service reached `Ready`, and every sign-in worked — under a key
 *   anybody could guess, protecting two bearer tokens. A refusal that only
 *   fires on an *absent* value is a refusal that misses the case a human
 *   actually produces. See `sessionSecretProblem`.
 * - **Version-tagged.** `v1.` prefixes every value, so a format change is a
 *   session that fails to open rather than a payload parsed under the wrong
 *   rules.
 *
 * A value that does not open is never a partial read: `openSealed` answers
 * `null` for the wrong key, a truncated chunk set, a tampered byte and an
 * unknown version alike. Every caller treats that as "no session", which is the
 * same state as a fresh browser and is always safe.
 */

/** The one format this file writes. Bump it and old cookies stop opening, deliberately. */
const VERSION = "v1";

/** AES-GCM's nonce, 96 bits — the size the spec is fastest and safest at. */
const IV_BYTES = 12;

/**
 * How much sealed text goes in one cookie.
 *
 * Browsers cap a cookie at 4096 **bytes including its name and attributes**
 * (RFC 6265 §6.1 sets 4096 as the floor a UA must support, and Chrome and
 * Firefox both enforce it on the whole `name=value; attrs` string). Our
 * attributes — `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…` — run about
 * 70 bytes and the chunk names about 16, so 3500 leaves room for both plus the
 * base64url expansion already counted in the sealed text.
 *
 * The number matters because the failure it prevents is silent: a browser that
 * is handed an oversized `Set-Cookie` drops it without an error, the next
 * request arrives with no session, and the app sends the persona back to sign
 * in — forever, because the same thing happens next time. Two JWTs and an email
 * exceed 4KB comfortably, so this is the normal case and not an edge.
 */
export const CHUNK_LIMIT = 3500;

/**
 * The floor on `SESSION_SECRET`, in characters.
 *
 * 32, because the key derived below is 256 bits and a secret shorter than the
 * key it stretches into is the part an attacker actually has to guess — SHA-256
 * does not add entropy, it only fixes the length. `openssl rand -hex 32` gives
 * 64 characters and `openssl rand -base64 32` gives 44; both clear this
 * comfortably, and both are what the documentation tells a human to run.
 *
 * Counted in characters rather than bytes deliberately. The value is typed into
 * a dashboard field by a person, so characters are the unit they can see, and a
 * 32-character value can only ever be *fewer* than 32 bytes of entropy — never
 * more. Erring that way is the safe direction.
 */
export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * And a floor on how many distinct characters those are.
 *
 * Length alone is satisfiable by padding: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` is
 * thirty-two characters and about one bit. Eight distinct characters is a floor
 * no random value trips over — hex draws from sixteen symbols and base64 from
 * sixty-four, and over 44+ characters both produce far more than eight — while
 * catching the one thing a human under time pressure actually types.
 *
 * It is not an entropy estimate and does not pretend to be. It is the cheapest
 * check that separates "a random value" from "a value padded to a length".
 */
export const SESSION_SECRET_MIN_DISTINCT = 8;

/**
 * What is wrong with a `SESSION_SECRET`, in a sentence, or `null` if nothing is.
 *
 * One function so the refusal a route renders, the field `/health` reports and
 * the error `seal()` throws cannot disagree about what a usable secret is. The
 * message always names the minimum and the command that produces one, because
 * whoever reads it is about to go and set the value.
 *
 * **The secret itself is never in the message.** Its length is — that is a
 * property, not the value, and without it "too short" is a refusal nobody can
 * act on.
 */
export function sessionSecretProblem(secret: string | undefined): string | null {
  const value = secret?.trim() ?? "";
  const remedy =
    `it must be at least ${SESSION_SECRET_MIN_LENGTH} characters of random material — ` +
    "`openssl rand -hex 32` produces one";

  if (!value) return `SESSION_SECRET is not set: ${remedy}`;
  if (value.length < SESSION_SECRET_MIN_LENGTH) {
    return `SESSION_SECRET is ${value.length} character${value.length === 1 ? "" : "s"}: ${remedy}`;
  }
  if (new Set(value).size < SESSION_SECRET_MIN_DISTINCT) {
    return (
      `SESSION_SECRET is long enough but uses only ${new Set(value).size} distinct ` +
      `characters, which is a value padded to a length rather than a random one: ${remedy}`
    );
  }
  return null;
}

/**
 * The AES key for a secret.
 *
 * SHA-256 over a domain-separated copy of the secret, so `SESSION_SECRET` can
 * be any alphabet — a human types this into Render — while the key is always
 * exactly 256 bits. The prefix means a secret reused elsewhere never yields the
 * same key here.
 *
 * The guard is here as well as at the edge of every route, and that duplication
 * is the point: this is the only function in the service that can turn a string
 * into a key, so a caller that forgot to check still cannot seal a cookie under
 * a guessable one.
 */
async function keyFor(secret: string): Promise<CryptoKey> {
  const problem = sessionSecretProblem(secret);
  if (problem) throw new Error(problem);
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`cg-web-session-${VERSION}:${secret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** `v1.<iv>.<ciphertext+tag>`, base64url throughout so it is cookie-safe unencoded. */
export async function seal(value: unknown, secret: string): Promise<string> {
  const key = await keyFor(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/**
 * The payload, or `null`.
 *
 * Every way this can fail collapses to `null` on purpose. A caller that could
 * tell "wrong key" from "tampered" from "truncated" would have three branches
 * where one is correct, and the correct one — treat it as no session — is the
 * same in all three. The cipher is authenticated, so "tampered" is a decrypt
 * failure rather than a plausible-looking payload.
 */
export async function openSealed<T>(sealed: string | undefined, secret: string): Promise<T | null> {
  if (!sealed || !secret) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const key = await keyFor(secret);
    const iv = Buffer.from(parts[1]!, "base64url");
    const body = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== IV_BYTES) return null;
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * The cookie name for chunk `index` of `name`.
 *
 * Always suffixed, even for a value that fits in one — a scheme where the first
 * chunk is the bare name and the rest are suffixed has two shapes to read and
 * one more way to half-read a value. `cg_session.0` on its own is a complete
 * session; `cg_session` alone is nothing this file ever writes.
 */
export function chunkName(name: string, index: number): string {
  return `${name}.${index}`;
}

/** Split sealed text into cookie-sized pieces. Always at least one, even for "". */
export function chunk(sealed: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < sealed.length; at += CHUNK_LIMIT) {
    pieces.push(sealed.slice(at, at + CHUNK_LIMIT));
  }
  return pieces.length > 0 ? pieces : [""];
}

/**
 * Reassemble `name` from a cookie jar.
 *
 * Reads `name.0`, `name.1`, … and stops at the first gap. A gap is what a
 * browser that dropped one oversized cookie leaves behind, and joining across
 * it would produce ciphertext that fails to open — which is the right outcome
 * but reached by luck. Stopping at the gap makes it the outcome by design:
 * whatever comes back is a prefix, the seal rejects it, and the persona signs
 * in again.
 */
export function joinChunks(name: string, cookies: ReadonlyMap<string, string>): string | undefined {
  const pieces: string[] = [];
  for (let index = 0; ; index += 1) {
    const piece = cookies.get(chunkName(name, index));
    if (piece === undefined) break;
    pieces.push(piece);
  }
  return pieces.length > 0 ? pieces.join("") : undefined;
}

/**
 * How many chunks of `name` a request is carrying.
 *
 * Used to clear the ones a shorter value leaves behind: a session that shrinks
 * from three chunks to two and does not delete the third leaves `name.2`
 * holding a fragment of the *previous* session, and the next read joins two new
 * chunks to one stale one. That opens as nothing, so it fails closed — but it
 * fails closed on every subsequent request, which reads as "signing in does not
 * work" rather than as a bug with a cause.
 *
 * Counts by scanning forward from 0, so a jar holding `name.0` and `name.5`
 * reports 1 and the orphan is cleared by the sweep in `clearedChunks`.
 */
export function chunkCount(name: string, cookies: ReadonlyMap<string, string>): number {
  let count = 0;
  while (cookies.has(chunkName(name, count))) count += 1;
  return count;
}

/**
 * Every chunk name of `name` the request carries that `written` does not
 * replace — the set to expire.
 *
 * Scans the jar rather than counting forward, so an orphan left at a
 * discontinuous index is swept too.
 */
export function clearedChunks(
  name: string,
  cookies: ReadonlyMap<string, string>,
  written: number,
): string[] {
  const prefix = `${name}.`;
  return [...cookies.keys()].filter((candidate) => {
    if (!candidate.startsWith(prefix)) return false;
    const index = Number(candidate.slice(prefix.length));
    return Number.isInteger(index) && index >= written;
  });
}

/**
 * Better Auth, configured as an OAuth 2.1 authorization server.
 *
 * `@better-auth/oauth-provider` is the current plugin. It supersedes the
 * older `oidc-provider` plugin, which still shows up in the docs tree and in
 * search results — do not switch to it.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { jwt } from "better-auth/plugins/jwt";

/** Where the login and consent pages live. `index.ts` serves them; the plugin redirects to them. */
export const LOGIN_PAGE = "/login";
export const CONSENT_PAGE = "/consent";

/**
 * Every Better Auth route hangs off the site root — `/oauth2/authorize`,
 * `/oauth2/token`, `/oauth2/userinfo`, `/.well-known/openid-configuration`.
 * These are the URLs a human types into the Arcade dashboard, and a `/api/auth`
 * prefix on an identity provider's public endpoints would be one more thing to
 * get wrong.
 */
export const BASE_PATH = "/";

export const SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * The signing algorithm for ID tokens, and therefore the one key type in the
 * published JWKS.
 *
 * Better Auth's JWT plugin defaults to **EdDSA** (Ed25519). This is pinned to
 * **RS256** instead, deliberately: Arcade validates our ID token against the
 * key set it fetches from `jwks_uri` (#65), Ed25519 JWS support is uneven
 * across verifiers, and RS256 is the algorithm every OIDC relying party
 * implements. An IdP whose only key an Arcade User Source cannot verify
 * publishes a JWKS that satisfies the discovery check and fails at the token
 * — the same shape of silent nothing this project keeps out of its controls.
 */
export const ID_TOKEN_ALG = "RS256" as const;

/** RSA key size. 2048 is the OIDC floor and what every relying party accepts. */
export const ID_TOKEN_MODULUS_LENGTH = 2048;

/**
 * Where the key set is served, relative to the issuer. The JWT plugin's
 * default, restated here because `jwks_uri` in the discovery document and
 * `/health` both have to name the same path.
 */
export const JWKS_PATH = "/jwks";

export interface AuthConfig {
  db: Database;
  /** Public origin, e.g. `https://cg-idp.onrender.com`. Also the OAuth issuer. */
  baseURL: string;
  /** Signs sessions, signs the OAuth query, and encrypts the stored JWKS private key. */
  secret: string;
}

/**
 * Hashes a client secret for storage: SHA-256, base64url, unpadded.
 *
 * Byte-for-byte what `@better-auth/oauth-provider`'s own `defaultHasher` does,
 * but ours rather than the library's, and passed in as `storeClientSecret`.
 * The migration in `client.ts` has to write a hash the plugin will later
 * accept, so exactly one function in this service may decide what a stored
 * secret looks like. Reaching into the library's internal for it would let the
 * two drift on an upgrade, and the failure mode is a client that cannot
 * authenticate at the token endpoint — a step that fires no hook.
 */
export async function hashClientSecret(clientSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientSecret));
  return Buffer.from(digest).toString("base64url");
}

/**
 * The client secret is stored **hashed**, so it can be read exactly once: at
 * creation, by whoever created it. `scripts/oauth-client.ts` prints it then
 * and says plainly on every later run that it cannot be shown again;
 * `--rotate` mints a new one under the same client id.
 *
 * Before #70 it was stored encrypted so the script could re-print it on any
 * later day. That is only permitted with `disableJwtPlugin: true`, which is
 * what left this IdP with HS256 ID tokens and no `jwks_uri` — and an IdP with
 * no published keys cannot back an Arcade User Source (#65, measured). The
 * plugin refuses the combination outright: `encryption method not recommended`
 * with the JWT plugin on, `unable to store hashed secrets` with it off. So the
 * print-once secret is the price of the key set, not a preference.
 */
export function clientSecretStorage() {
  return { hash: hashClientSecret };
}

/**
 * Reads a client secret written by the **pre-#70** build, which stored it
 * encrypted under `BETTER_AUTH_SECRET`.
 *
 * Used once, at boot, to carry the live `cg-idp` client across the change
 * without rotating it — see `migrateStoredClientSecret`. Throws on anything
 * that is not ciphertext this key opens; the cipher is authenticated, so that
 * is a real check and not a guess at the format.
 */
export function decryptLegacyClientSecret(secret: string, stored: string): Promise<string> {
  return symmetricDecrypt({ key: secret, data: stored });
}

/**
 * Puts the person's email into the ID token.
 *
 * Better Auth blanks every standard profile claim in the ID token on purpose
 * (`ID_TOKEN_SCOPE_CLAIM_GUARDS`) and points relying parties at
 * `/oauth2/userinfo` instead, so out of the box the only identity an ID token
 * carries is `sub` — an opaque uuid. Arcade's User Source identifies the
 * person from a configured subject claim **on the ID token** (#65), and
 * DESIGN.md's third identity rule is that the Arcade `user_id`, the OAuth
 * subject and the loan book's actor column are the same string, joined on
 * email. A User Source keyed on `sub` would make the Arcade user a uuid while
 * `governance.db` and `loans.db` hold addresses — open risk 4, which is the
 * one that leaves every test passing while the audit trail describes two
 * different people.
 *
 * Lowercased here as well as at the seed (#58), because this is the value
 * Arcade ends up holding and it must be byte-equal to what `/oauth2/userinfo`
 * returns and to what the loan book records.
 *
 * Only when the `email` scope was actually granted: a claim that appears
 * regardless of scope is a claim the consent screen did not describe.
 */
function idTokenIdentityClaims({
  user,
  scopes,
}: {
  user: { email: string; emailVerified: boolean } & Record<string, unknown>;
  scopes: readonly string[];
}): Record<string, unknown> {
  if (!scopes.includes("email")) return {};
  return { email: user.email.toLowerCase(), email_verified: user.emailVerified };
}

/**
 * The path the login form posts to. Named because the ceiling below is keyed
 * on it: a rule keyed on a path this service never serves is a rule that
 * matches nothing, which reads exactly like a rule that permits.
 */
export const SIGN_IN_PATH = "/sign-in/email";

/**
 * What this provider refuses, and the arithmetic behind every number.
 *
 * Until #166 this service configured no `rateLimit` at all, so every ceiling
 * was inherited — and not from where the issue assumed. `@better-auth/oauth-provider`
 * declares its own per-path rules, applied *after* Better Auth's defaults
 * (`better-auth/dist/api/rate-limiter/index.mjs`, the plugin loop after the
 * special-rule block), so the numbers that actually applied were the plugin's.
 * Measured over the wire on 2026-09-18 against this service booted the way its
 * Dockerfile boots it — `bun scripts/rate-limit-drill.ts ceilings`:
 *
 *     /oauth2/userinfo   60 per 60s      /oauth2/authorize  30 per 60s
 *     /oauth2/token      20 per 60s      /sign-in/email      3 per 10s
 *
 * That 60 is what took the live demo down: every persona's sign-in died at the
 * userinfo step, in the bucket the bank's polling had already emptied (#166).
 *
 * **Three properties of the limiter that decide every number here.**
 *
 *  1. **It is not a fixed window.** The counter resets only after a full
 *     `window` with *no allowed request*; every allowed request slides it
 *     forward and a refusal does not (`decideConsume`: reset needs
 *     `now - lastRequest >= window`, and the memory entry's expiry is set only
 *     on an allowed request). So a caller that keeps trying can never wait a
 *     window out, and traffic that never leaves a `window`-long gap makes
 *     `max` a **countdown rather than a rate**: it fills after `max / calls
 *     per minute` minutes whatever `max` is. Measured then: after the ceiling
 *     was reached, polling every 2s, the first non-429 came 60081 ms after the
 *     last *allowed* request.
 *  2. **The bucket is `<ip>|<path>`, and everything here shares one.** `getIP`
 *     returns null unless a forwarded-for header resolves to exactly one
 *     address, and then the key is the literal `no-trusted-ip`; the drill logs
 *     Better Auth saying so. On stage the personas are Chrome profiles on one
 *     machine behind one address, and `apps/web` and `apps/loan-app` call from
 *     their own hosts. Every number below therefore assumes **one bucket for
 *     the whole demo** — the worst case, and the one that actually happened.
 *     Splitting the buckets by trusting `x-forwarded-for` is rejected, not
 *     forgotten: the leftmost value is attacker-supplied, so trusting it would
 *     let a stranger mint an unlimited number of buckets, which is worse than
 *     one bucket sized correctly.
 *  3. **It is on only under `NODE_ENV=production`** (`enabled` defaults to
 *     `isProduction`, and that default is left alone here so `bun test` is not
 *     silently rate-limited). Every Dockerfile sets it and no test does, which
 *     is the whole reason this was invisible until a live rehearsal. The
 *     numbers below are therefore measured by booting the service with it set:
 *     `apps/idp/scripts/rate-limit-drill.ts`, and `test/rate-limit.test.ts`.
 *
 * **The audience these numbers are chosen to survive.** Four personas
 * (DESIGN.md names four), each signed in on their own Chrome profile, each
 * holding two live access tokens — the one `apps/web` got at sign-in, which the
 * bank's screens carry, and the one Arcade holds from hop 2 — with `/` and the
 * `/loans` board open on a second display, for a rehearsal longer than the
 * ~15 minutes #167 bought. Written out: **8 live tokens across 8 polling
 * surfaces, and a stage reset every few minutes that re-signs all four.**
 *
 * ---
 *
 * **`/oauth2/userinfo` — `window: 2, max: 120`, and the window is the fix.**
 *
 * This is the only path with *sustained* traffic. Since #167 `apps/loan-app`
 * reuses one token→email answer for 60 seconds (`RESOLUTION_TTL_MS`), so the
 * 2-second poll no longer sets the rate: the number of **distinct live tokens**
 * does. Eight tokens is 8 calls/min, spaced ~7.5s apart.
 *
 * Against the inherited rule that is a countdown, not a limit: 60 ÷ 8 = 7.5
 * minutes to the first refusal, then ~6% of calls refused forever after. Ten
 * times the ceiling only buys ten times the countdown — 600 ÷ 8 = 75 minutes —
 * and a number picked because it looks generous is the thing this repo calls
 * cargo cult. **The ceiling was never the binding constraint; the silence-reset
 * is.** So the window is what moves.
 *
 * `window: 2` is chosen against the quiet gap our own traffic guarantees. With
 * N tokens each re-resolved once per 60-second cache period, the N gaps in a
 * cycle sum to 60s, so the largest is **at least 60/N seconds** — a pigeonhole,
 * true for any arrangement of phases, worst when they are spread evenly. A gap
 * of at least `window` resets the counter, so the counter provably resets at
 * least once a minute for every N up to **60/2 = 30 distinct tokens**. The
 * demo's 8 has 3.75× that margin; the count never climbs past one minute's
 * traffic, so there is no countdown to run out.
 *
 * `max: 120` is what has to fit inside any 2-second chain. The largest burst
 * this system can produce is a stage reset landing on cold caches: per persona
 * the two open surfaces miss on the same browser token at once
 * (`actorFromRequest` does not coalesce concurrent misses — one fetch per miss)
 * and the Arcade token misses once, so 3 × 4 personas = 12, plus 4 sign-in
 * callbacks in `apps/web` and 4 Arcade reads of the email claim = **20**. 120
 * is 6× that, and it still bounds an unauthenticated flood at 60
 * requests/second per bucket — the guard worth keeping on a public endpoint.
 *
 * The pair is **strictly more permissive than what it replaces**, which is why
 * nothing that worked can start failing: every chain of requests under a 2s
 * window is a sub-sequence of the chain under a 60s one, and it is counted
 * against 120 instead of 60. Anything the new rule refuses, the old one
 * refused too.
 *
 * ---
 *
 * **The burst paths — `window` stays at 60s, because they are already quiet.**
 *
 * A sign-in storm is not sustained traffic: it lands in about two seconds when
 * the presenter resets, and then nothing touches these paths for minutes. The
 * window is already far shorter than the quiet gap between resets, so the
 * counter does reset between them, and the only question is what one storm
 * costs. One persona re-authorizing costs, from the code paths in this repo:
 *
 *     /sign-in/email      1   the login form posts once  (`src/index.ts::handleLogin`)
 *     /oauth2/authorize   2   `apps/web`'s client C, then Arcade's hop-2 flow
 *     /oauth2/token       3   `apps/web` exchanges once (`lib/identity/oidc.ts`),
 *                             Arcade exchanges the same code twice (open risk 9)
 *
 * Four personas: **4 sign-ins, 8 authorizes, 12 token exchanges** per reset.
 *
 *  - `/sign-in/email` — `window: 10, max: 30`. The inherited 3-per-10s cannot
 *    survive its own demo: four personas signing in inside ten seconds means
 *    the fourth is refused, and `handleLogin` renders a 429 as a bare redirect,
 *    so it fails looking like a success. 30 is the 4 the reset needs plus two
 *    fumbled passwords each (12), with 2.5× on top. It is still 3 attempts a
 *    second against a login form, which is the bound worth keeping.
 *  - `/oauth2/authorize` — `window: 60, max: 60`. 8 per reset, so 60 is seven
 *    resets inside one minute — more than a presenter can drive by hand.
 *  - `/oauth2/token` — `window: 60, max: 60`. 12 per reset, so 60 is five
 *    resets inside one minute. Raised from 20, which is only 1.6 resets and
 *    the next thing that would have broken.
 *
 * ---
 *
 * **The rest, restated rather than inherited**, so that no ceiling in this
 * service is a number nobody in this repo chose:
 *
 *  - `/oauth2/introspect` — 100/60s. Nothing calls it: `apps/loan-app` reads
 *    `/oauth2/userinfo` instead, because access tokens here are opaque and no
 *    `oauthResource` is registered. Kept as the plugin had it; if #168 lands
 *    and tokens become JWTs, this path stays unused and `/oauth2/userinfo`
 *    goes quiet.
 *  - `/oauth2/revoke` — 30/60s. Not driven either: `scripts/reset.ts` clears
 *    tokens in the database, not over the wire.
 *  - `/oauth2/register` — 5/60s. Dynamic registration is off
 *    (`allowDynamicClientRegistration: false`), so this is a ceiling on an
 *    endpoint that refuses everyone anyway.
 *  - Everything else — 100 per 10s, the library's global default, restated.
 *    It covers `/consent`, `/jwks` and discovery, which one rehearsal touches
 *    a few dozen times.
 */
export const RATE_LIMIT = {
  userinfo: { window: 2, max: 120 },
  token: { window: 60, max: 60 },
  authorize: { window: 60, max: 60 },
  introspect: { window: 60, max: 100 },
  revoke: { window: 60, max: 30 },
  register: { window: 60, max: 5 },
  signIn: { window: 10, max: 30 },
  everythingElse: { window: 10, max: 100 },
} as const;

/**
 * The options, separately from the instance, because `scripts/generate-schema.ts`
 * derives `src/schema.sql` from exactly these — the table set depends on the
 * plugin list, and a schema generated from a different configuration is how
 * the seed and the library end up disagreeing about a column.
 */
export function authOptions({ db, baseURL, secret }: AuthConfig) {
  return {
    database: db,
    baseURL,
    basePath: BASE_PATH,
    secret,
    appName: "Enterprise Identity",
    emailAndPassword: { enabled: true },
    // No self-service signup: the people are seeded. A stranger who finds the
    // login page gets a login page, not an account.
    user: { changeEmail: { enabled: false } },
    // See {@link RATE_LIMIT}. `enabled` is deliberately absent: it defaults to
    // `NODE_ENV === "production"`, which is what keeps `bun test` from being
    // rate-limited, and `test/rate-limit.test.ts` sets that variable rather
    // than adding a switch that only tests use.
    rateLimit: {
      window: RATE_LIMIT.everythingElse.window,
      max: RATE_LIMIT.everythingElse.max,
      // Applied after the plugin's rules, so this is the only place
      // Better Auth's own 3-per-10s sign-in rule can be raised from.
      customRules: { [SIGN_IN_PATH]: { ...RATE_LIMIT.signIn } },
    },
    plugins: [
      // Signing keys, and `GET /jwks`. Adds one table, `jwks`, which is the
      // whole reason `openPeople` needed an upgrade path before this could
      // deploy onto the live disk (#69, #70).
      //
      // The private key is encrypted at rest under `BETTER_AUTH_SECRET`
      // (the plugin's default). Changing that secret does not rotate the key
      // pair, it makes the stored one unreadable — same blast radius the
      // secret already had for the OAuth client row.
      jwt({
        jwks: { keyPairConfig: { alg: ID_TOKEN_ALG, modulusLength: ID_TOKEN_MODULUS_LENGTH } },
      }),
      oauthProvider({
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        scopes: [...SCOPES],
        // Exactly one client, created by `ensureOAuthClient` at bootstrap.
        // Arcade is registered by hand, so nothing needs `/oauth2/register`.
        allowDynamicClientRegistration: false,
        // JWT plugin on (the default): ID tokens are signed with the RS256 key
        // above and `/.well-known/openid-configuration` carries a `jwks_uri`.
        // Access tokens stay opaque — they become JWTs only for a registered
        // `oauthResource`, and this service registers none — so
        // `apps/loan-app` keeps validating them at `/oauth2/userinfo`.
        storeClientSecret: clientSecretStorage(),
        customIdTokenClaims: idTokenIdentityClaims,
        // Every OAuth ceiling, restated here rather than inherited from the
        // plugin's `?? 60` defaults. The reasoning for each is {@link RATE_LIMIT}.
        rateLimit: {
          userinfo: { ...RATE_LIMIT.userinfo },
          token: { ...RATE_LIMIT.token },
          authorize: { ...RATE_LIMIT.authorize },
          introspect: { ...RATE_LIMIT.introspect },
          revoke: { ...RATE_LIMIT.revoke },
          register: { ...RATE_LIMIT.register },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}

export type Auth = ReturnType<typeof createAuth>;

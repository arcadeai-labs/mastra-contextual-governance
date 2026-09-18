/**
 * Sign-in against `apps/idp` as **client C**.
 *
 * `DESIGN.md` → **Identity**: every persona is a real person in `apps/idp` and
 * `apps/web` is a real sign-in against it, under its own OAuth client. Client C
 * is separate from the two registrations Arcade holds (the User Source's and
 * the `cg-idp` auth provider's) — spike #75 settled that one client per relying
 * party is the shape, after a shared one left hop 2 failing at the token
 * endpoint.
 *
 * Authorization code + PKCE, `openid email`. Sign-in itself wants one thing
 * from the access token — the **email**, read from `/oauth2/userinfo` — and
 * since #157 the token is kept afterwards rather than dropped, because the
 * bank's own screens read `apps/loan-app` with it as the signed-in person.
 * `lib/identity/session.ts` → `IdpToken` has the argument and the measurement;
 * this module's job is only to obtain and renew one.
 */

/** What `/oauth2/userinfo` answers with. `email` is the only field this service needs. */
export interface Userinfo {
  sub?: string;
  email?: string;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeRequest {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  /**
   * `prompt=login` — force a fresh authentication even when the browser already
   * holds an IdP session.
   *
   * This is what makes "Sign in as Bob" land on a login page rather than
   * silently continue as Alice. `@better-auth/oauth-provider` implements it
   * (`authorize`'s `promptSet?.has("login")` branch, which redirects to the
   * login page before it looks at the session) and `test/identity-flow.test.ts`
   * measures it against a real `apps/idp` rather than taking the source's word
   * for it — the issue asked for a measurement and the failure it guards
   * against is the whole demo quietly running as one persona.
   */
  prompt?: "login";
}

/** The URL the browser is sent to. Every parameter is one the IdP's plugin reads. */
export function authorizeUrl(request: AuthorizeRequest): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  });
  if (request.prompt) params.set("prompt", request.prompt);
  return `${request.issuer}/oauth2/authorize?${params}`;
}

/**
 * Which client authentication method the IdP has this client registered for.
 *
 * Read off `/health` rather than hardcoded, and the other method is tried once
 * if the first is refused for being the wrong one. This project has been bitten
 * in both directions inside one afternoon (#61, then spike #75's verifier), and
 * the failure mode is the expensive kind: a relying party that looks correctly
 * configured, fails at a step no hook observes, and gets blamed on the other
 * end. `apps/idp` publishes the method per client since #79, so the lookup is
 * by client id with the top-level field as the fallback.
 */
async function advertisedAuthMethod(issuer: string, clientId: string): Promise<string | undefined> {
  const health = (await fetch(`${issuer}/health`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)) as
    | {
        oauth?: {
          token_endpoint_auth_method?: string;
          clients?: Array<{ client_id?: string; token_endpoint_auth_method?: string }>;
        };
      }
    | null;
  const ours = health?.oauth?.clients?.find((each) => each.client_id === clientId);
  return ours?.token_endpoint_auth_method ?? health?.oauth?.token_endpoint_auth_method;
}

export interface TokenSet {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export type TokenResult =
  | { ok: true; token: TokenSet }
  | { ok: false; status: number; body: string };

/**
 * Trade the authorization code for a token. See {@link tokenRequest} for how
 * the client authenticates itself.
 */
export async function exchangeCode(
  options: {
    issuer: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  } & ClientCredentials,
): Promise<TokenResult> {
  return tokenRequest(options, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
}

/**
 * Renew the IdP bearer this browser holds, when the IdP issued a refresh token
 * to renew it with.
 *
 * Only reachable on a deployment whose `IDP_SCOPES` asks for `offline_access`:
 * measured 2026-09-18, `apps/idp` answers `openid email` with no refresh token
 * at all, so the default path never calls this and an expired bearer is a
 * re-sign-in. Kept here rather than inlined at the call site because the client
 * authentication negotiation below is the part that has bitten this repo twice
 * (#61, #75) and a second copy of it is a second thing to get wrong.
 */
export async function refreshIdpToken(
  options: { issuer: string; refreshToken: string } & ClientCredentials,
): Promise<TokenResult> {
  return tokenRequest(options, { grant_type: "refresh_token", refresh_token: options.refreshToken });
}

/**
 * One `POST /oauth2/token`, authenticated the way this IdP wants.
 *
 * `apps/idp` enforces **one** method per client and refuses the other outright
 * rather than accepting either, so the order comes from what it publishes. Only
 * an explicit method mismatch is retried: a wrong secret, a spent code or an
 * expired one must not be, because a second attempt doubles the noise in the
 * IdP's log and tells nobody anything.
 */
async function tokenRequest(
  options: { issuer: string } & ClientCredentials,
  grant: Record<string, string>,
): Promise<TokenResult> {
  const advertised = await advertisedAuthMethod(options.issuer, options.clientId);
  const order = advertised === "client_secret_post" ? (["post", "basic"] as const) : (["basic", "post"] as const);

  let last: { status: number; body: string } = { status: 0, body: "no token request was made" };
  for (const method of order) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const form: Record<string, string> = { ...grant, client_id: options.clientId };
    if (method === "basic") {
      headers.authorization = `Basic ${basic(options)}`;
    } else {
      form.client_secret = options.clientSecret;
    }

    const response = await fetch(`${options.issuer}/oauth2/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
    const body = await response.text();
    if (response.ok) return { ok: true, token: JSON.parse(body) as TokenSet };
    last = { status: response.status, body };
    if (!/cannot use client_secret_(post|basic)/.test(body)) break;
  }
  return { ok: false, ...last };
}

/**
 * `expires_in` seconds, as the absolute epoch-millisecond instant the session
 * records.
 *
 * An hour when the IdP says nothing, which is what `apps/idp` issues anyway
 * (measured 2026-09-18) — a token with no stated lifetime is still a token with
 * a lifetime, and treating it as immortal would put the re-sign-in prompt on
 * screen only once the loan book had already refused the read.
 */
export function tokenExpiry(token: TokenSet, now = Date.now()): number {
  const seconds = typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
    ? token.expires_in
    : 3600;
  return now + Math.max(0, seconds) * 1000;
}

/**
 * `Authorization: Basic`, built the way RFC 6749 §2.3.1 says to: each half
 * form-url-encoded before the base64.
 */
function basic({ clientId, clientSecret }: ClientCredentials): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return Buffer.from(`${half(clientId)}:${half(clientSecret)}`).toString("base64");
}

/** The signed-in person's email, lowercase, or `null` with the reason. */
export async function fetchUserinfo(
  issuer: string,
  accessToken: string,
): Promise<{ ok: true; email: string } | { ok: false; status: number; body: string }> {
  const response = await fetch(`${issuer}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, body };

  let userinfo: Userinfo;
  try {
    userinfo = JSON.parse(body) as Userinfo;
  } catch {
    return { ok: false, status: response.status, body };
  }
  if (!userinfo.email) {
    return { ok: false, status: response.status, body: "the IdP returned no email claim" };
  }
  // DESIGN.md rule 3: the Arcade user_id, the OAuth subject and the loan book's
  // actor column are one string. Lowercased here as well as at the IdP, because
  // this is the value that ends up on every hook payload.
  return { ok: true, email: userinfo.email.toLowerCase() };
}

/** PKCE S256. The verifier rides in a sealed cookie; only the challenge is ever in a URL. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** A CSRF nonce for one authorization leg. */
export function nonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

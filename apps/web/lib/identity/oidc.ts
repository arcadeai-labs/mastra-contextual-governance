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
 * Authorization code + PKCE, `openid email`. The access token is used once, to
 * read `/oauth2/userinfo`, and then dropped: this service wants the **email**
 * and nothing else. Holding an IdP token longer would be holding a credential
 * with no use, and the session cookie already carries the one credential this
 * slice cannot avoid (the gateway token).
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
 * Trade the authorization code for a token, authenticating the client the way
 * this IdP wants.
 *
 * `apps/idp` enforces **one** method per client and refuses the other outright
 * rather than accepting either, so the order comes from what it publishes. Only
 * an explicit method mismatch is retried: a wrong secret, a spent code or an
 * expired one must not be, because a second attempt doubles the noise in the
 * IdP's log and tells nobody anything.
 */
export async function exchangeCode(
  options: {
    issuer: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  } & ClientCredentials,
): Promise<TokenResult> {
  const advertised = await advertisedAuthMethod(options.issuer, options.clientId);
  const order = advertised === "client_secret_post" ? (["post", "basic"] as const) : (["basic", "post"] as const);

  let last: { status: number; body: string } = { status: 0, body: "no token request was made" };
  for (const method of order) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: options.codeVerifier,
    };
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

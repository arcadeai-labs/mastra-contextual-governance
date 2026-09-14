/**
 * The enterprise's identity provider — a demo fixture standing in for the real
 * one, the same category of thing as the persona switcher. A forker deletes
 * this service and points Arcade at their Okta.
 *
 * Better Auth serves the OAuth 2.1 endpoints; this file serves the two pages
 * the plugin redirects to (login and consent), turns their HTML form posts into
 * the JSON calls Better Auth expects, and answers `/health` and
 * `POST /admin/reset`. Nothing here knows what a loan is or who is allowed to
 * do what.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { authorizationCodeId, codeState, type CodeState } from "./authorization-code.ts";
import { createAuth, CONSENT_PAGE, ID_TOKEN_ALG, JWKS_PATH, LOGIN_PAGE } from "./auth.ts";
import { CLIENT_SECRET_STATE_MESSAGE, ensureOAuthClients, findClientName } from "./client.ts";
import { readConfig, resetEnabled, usingDevSecret } from "./config.ts";
import { countPeople, openPeople } from "./db.ts";
import { renderConsentPage, renderLoginPage, renderMessagePage } from "./pages.ts";
import { OAuthClientRotatedError, RESET_PATH, resetSummary, runIdpReset } from "./reset.ts";

const SERVICE = "idp";
const config = readConfig();

const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

// Create-if-absent, one per configured key. Credentials are deliberately not
// logged: read them with `bun run oauth-client`. Only the fact and the id,
// which is public anyway.
const clients = await ensureOAuthClients(auth, { clients: config.clients, secret: config.secret });

// The first one, which is the whole story for a deployment that never set
// `IDP_OAUTH_CLIENTS` — every field `/health` published before #79 is this one.
const client = clients[0]!;

/** Every client id this service will answer for, for the token-endpoint log. */
const registeredClientIds = clients.map((each) => each.clientId);

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Calls a Better Auth endpoint the way its own client would — JSON body,
 * the browser's cookies, and an `Origin` that passes the CSRF check — and
 * returns the raw response so `Set-Cookie` and redirects can be passed on.
 */
async function callAuth(
  path: string,
  body: Record<string, unknown>,
  incoming: Request,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: config.baseURL,
    // A page navigation, so the plugin answers the continued authorize flow
    // with a redirect rather than a JSON `{ redirect, url }` body.
    Accept: "text/html",
    "Sec-Fetch-Mode": "navigate",
  });
  for (const name of ["cookie", "user-agent", "x-forwarded-for"]) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }

  return auth.handler(
    new Request(`${config.baseURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/**
 * The plugin's continued-authorize step ends in a redirect. Depending on how
 * it classified the request that arrives as either a 3xx or a JSON body with
 * the URL in it; either way the browser gets a 303 carrying every cookie the
 * auth call set.
 */
async function redirectFrom(response: Response): Promise<Response | null> {
  let location = response.headers.get("location");

  if (!location && response.ok) {
    const body = (await response.clone().json().catch(() => null)) as
      | { url?: string; redirect_uri?: string; redirect?: boolean }
      | null;
    location = body?.url ?? body?.redirect_uri ?? null;
  }
  if (!location) return null;

  const headers = new Headers({ Location: location });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function loginPage(url: URL, extra: { error?: string; email?: string } = {}): Promise<Response> {
  const clientId = url.searchParams.get("client_id");
  return html(
    renderLoginPage({
      oauthQuery: url.search.slice(1),
      clientName: clientId ? await findClientName(auth, clientId) : null,
      error: extra.error,
      email: extra.email,
    }),
    extra.error ? 401 : 200,
  );
}

async function handleLogin(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const oauthQuery = String(form.get("oauth_query") ?? "");
  const pageUrl = new URL(`${LOGIN_PAGE}?${oauthQuery}`, config.baseURL);

  // `oauth_query` rides along in the sign-in body: the plugin verifies its
  // signature, and once the session cookie is set it resumes the authorize
  // flow itself — on to consent, or straight back to Arcade with a code.
  const body: Record<string, unknown> = { email, password };
  if (oauthQuery) body.oauth_query = oauthQuery;

  const response = await callAuth("/sign-in/email", body, request);

  if (response.status === 401 || response.status === 403 || response.status === 400) {
    // The plugin checks the signed query *before* the password, in a
    // before-hook, and a query that is tampered with or older than ten minutes
    // fails there as `invalid_signature`. Telling that persona their password
    // was wrong would send them retyping it forever — the stale query is in
    // the hidden field. Tell them the truth and where to restart.
    const failure = (await response.clone().json().catch(() => null)) as
      | { error?: string; code?: string }
      | null;
    const expired = failure?.error === "invalid_signature" || failure?.code === "INVALID_SIGNATURE";

    return loginPage(pageUrl, {
      error: expired
        ? "This sign-in request has expired. Go back to the application and start again."
        : "That email and password did not match.",
      email,
    });
  }
  if (!response.ok && response.status < 300) {
    return html(renderMessagePage("Sign-in failed", `The identity provider answered ${response.status}.`), 502);
  }

  const redirect = await redirectFrom(response);
  if (redirect) return redirect;

  // Signed in with no OAuth flow to continue: nothing to hand back to.
  const headers = new Headers({ Location: "/" });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function consentPage(request: Request, url: URL): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    // No session — the plugin would have sent them to login first, so this is
    // a stale tab or a hand-typed URL. Same query, login page.
    return Response.redirect(new URL(`${LOGIN_PAGE}${url.search}`, config.baseURL).toString(), 303);
  }

  const clientId = url.searchParams.get("client_id") ?? "";
  const clientName = (await findClientName(auth, clientId)) ?? "An application";
  const scopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);

  return html(
    renderConsentPage({
      oauthQuery: url.search.slice(1),
      clientName,
      scopes,
      user: { name: session.user.name, email: session.user.email },
    }),
  );
}

async function handleConsent(request: Request): Promise<Response> {
  const form = await request.formData();
  const accept = form.get("decision") === "allow";
  const oauthQuery = String(form.get("oauth_query") ?? "");

  const response = await callAuth("/oauth2/consent", { accept, oauth_query: oauthQuery }, request);
  const redirect = await redirectFrom(response);
  if (redirect) return redirect;

  if (response.status === 401) {
    return Response.redirect(new URL(`${LOGIN_PAGE}?${oauthQuery}`, config.baseURL).toString(), 303);
  }
  return html(
    renderMessagePage("Consent failed", `The identity provider answered ${response.status}.`),
    502,
  );
}

/**
 * The token endpoint, named once. Everything else Better Auth serves goes
 * through the catch-all below; this one path is wrapped so a rejection leaves
 * a line behind.
 */
const TOKEN_PATH = "/oauth2/token";

/** RFC 7235 scheme token, so a garbage `Authorization` header is reported as garbage. */
const AUTH_SCHEME = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32})(?=\s|$)/;

/** The `Basic` scheme, matched the way RFC 7235 §2.1 says to: case-insensitively. */
const BASIC_SCHEME = /^Basic +/i;

/** The `Authorization` header and the form body of one token request, read once. */
interface TokenRequest {
  authorization: string | null;
  form: URLSearchParams;
}

/**
 * What one token request did with the `Authorization` header and the body at
 * the same time.
 *
 * - `single` — at most one of them carries a credential. Nothing to do.
 * - `duplicated` — Basic **and** a body `client_id`/`client_secret` pair that is
 *   byte-for-byte the header's. This is Arcade's custom OAuth provider as the
 *   dashboard ships it, and it is the one case this service tolerates (#79).
 * - `mixed` — Basic and something else. Two different credentials, or a
 *   credential and an assertion, or a half pair. Refused.
 */
type DualCredentials = "single" | "duplicated" | "mixed";

/** Values Better Auth treats as present: a field set to the empty string is not a credential. */
function present(values: string[]): string[] {
  return values.filter((value) => value.length > 0);
}

/**
 * The client id and secret inside an `Authorization: Basic` header.
 *
 * Hand-decoded rather than imported from `@better-auth/core`, which is a
 * transitive dependency here, but decoded the *same* way
 * (`oauth2/basic-credentials.ts`): split on the first colon only, then
 * form-url-decode each half per RFC 6749 §2.3.1, where `+` is a space. Both
 * halves must be non-empty, which is also where that function throws.
 */
function basicCredentials(authorization: string): { clientId: string; clientSecret: string } | null {
  const encoded = BASIC_SCHEME.test(authorization) ? authorization.replace(BASIC_SCHEME, "") : null;
  if (encoded === null) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) return null;

  const half = (value: string) => new URLSearchParams(`v=${value}`).get("v");
  const clientId = half(decoded.slice(0, colon));
  const clientSecret = half(decoded.slice(colon + 1));
  if (!clientId || !clientSecret) return null;

  return { clientId, clientSecret };
}

/**
 * Classifies a token request against RFC 6749 §2.3's one-method rule — which
 * `@better-auth/oauth-provider` enforces in
 * `normalizeClientAuthenticationParameters` (`utils-C2yu_zRr.mjs:541`) by
 * throwing `invalid_request: "A request must use only one client
 * authentication method"` the moment an `Authorization` header arrives beside a
 * body `client_secret` or a client assertion.
 *
 * **Arcade's custom OAuth provider sends both.** Its token request carries
 * `auth_method: client_secret_basic` *and* the dashboard template's
 * `client_id={{client_id}}` / `client_secret={{client_secret}}` Request
 * Parameter rows, on Token Settings and Refresh Token Settings alike. Measured
 * on `cg-idp`, spike #75, 17:38Z:
 *
 * ```
 * [idp] POST /oauth2/token rejected: status=400 error=invalid_request
 *   error_description="A request must use only one client authentication method"
 *   client_auth="client_secret_basic" client_id=RskTFjl6…
 * ```
 *
 * Nothing on the Arcade side removes those rows, so this service accepts the
 * request as sent — and only that request. The tolerance is for **identical
 * credentials presented twice**, nothing else: the body pair must be complete
 * and must equal the header's, or the request is refused as `mixed`. That
 * keeps the §2.3 rule where it matters, which is a caller presenting two
 * *different* identities and letting the server pick.
 */
function classifyDualCredentials({ authorization, form }: TokenRequest): DualCredentials {
  if (!authorization || !BASIC_SCHEME.test(authorization)) return "single";

  const secrets = present(form.getAll("client_secret"));
  const assertions = present([
    ...form.getAll("client_assertion"),
    ...form.getAll("client_assertion_type"),
  ]);
  if (secrets.length === 0 && assertions.length === 0) return "single";

  // An assertion is a different method, not the same one twice.
  if (assertions.length > 0) return "mixed";

  // Repeated parameters are refused by Better Auth by name — `client_secret
  // must not be repeated` — before it reaches the one-method rule, and its
  // message is more precise than anything said here. Hand it over untouched.
  const ids = present(form.getAll("client_id"));
  if (ids.length > 1 || secrets.length > 1) return "single";

  const header = basicCredentials(authorization);
  // A malformed Basic header is `invalid_client` from the plugin, with a
  // `WWW-Authenticate` challenge. Better answer than ours.
  if (!header) return "single";

  return ids[0] === header.clientId && secrets[0] === header.clientSecret ? "duplicated" : "mixed";
}

/**
 * The request as Better Auth should see it: the body `client_secret` removed,
 * everything else byte-identical in meaning.
 *
 * **Only `client_secret` is dropped.** `client_id` beside a Basic header is not
 * a second authentication method — the plugin expects it there and cross-checks
 * it, `index.mjs:161`: `if (request.client_id && authenticated.clientId !==
 * request.client_id) invalid_client "Client ID mismatch"`. Leaving it keeps that
 * check alive on the passed-through request, which is one more thing standing
 * between a confused caller and a token.
 */
function withoutBodyClientSecret(form: URLSearchParams): URLSearchParams {
  const stripped = new URLSearchParams(form);
  stripped.delete("client_secret");
  return stripped;
}

/**
 * The incoming headers, with `content-length` corrected for a body that is now
 * shorter. Stale by exactly the length of the secret otherwise, and a header
 * that disagrees with the body it describes is the kind of thing that works
 * until the day something reads it.
 */
function forwardedHeaders(request: Request, byteLength: number): Headers {
  const headers = new Headers(request.headers);
  if (headers.has("content-length")) headers.set("content-length", String(byteLength));
  return headers;
}

/**
 * Which client authentication method the request actually used, classified the
 * same way `@better-auth/oauth-provider` classifies it
 * (`extractClientCredentials`): the `Authorization` header first, then
 * an assertion, then credentials in the form body, then a bare `client_id`.
 *
 * This is the field spike #75 went looking for and could not find. A client
 * registered for one method and sending the other is refused with
 * `invalid_client` **before the secret is checked**, so from the outside it is
 * indistinguishable from a wrong secret — and the caller is Arcade, server to
 * server, with nothing user-visible to report it.
 *
 * `mixed` is the #79 addition: a Basic header beside body credentials that are
 * not the same credentials. It is its own value because the refusal is this
 * service's, not the plugin's, and a reader of the log should not have to
 * guess which.
 */
function observedClientAuth(token: TokenRequest): string {
  const { authorization, form } = token;

  if (authorization) {
    const scheme = AUTH_SCHEME.exec(authorization)?.[1];
    if (!scheme) return "authorization header: malformed";
    if (!/^basic$/i.test(scheme)) return `authorization scheme: ${scheme}`;
    return classifyDualCredentials(token) === "mixed" ? "mixed" : "client_secret_basic";
  }
  if (form.get("client_assertion") || form.get("client_assertion_type")) return "private_key_jwt";
  if (form.get("client_id") && form.get("client_secret")) return "client_secret_post";
  if (form.get("client_id")) return "none";
  return "absent";
}

/**
 * The `client_id` the request claims, from wherever it put it. Used only to
 * compare against the registered ones — see `logTokenFailure` for why the value
 * itself never reaches the log.
 */
function requestClientId({ authorization, form }: TokenRequest): string | null {
  if (authorization && BASIC_SCHEME.test(authorization)) {
    return basicCredentials(authorization)?.clientId ?? null;
  }
  return form.get("client_id");
}

/**
 * The refusal this service writes itself: a Basic header and body credentials
 * that are not the same credentials.
 *
 * `invalid_request` and 400, the same as the rule it stands in for
 * (RFC 6749 §5.2, and `throwInvalidAuthenticationRequest` in the plugin). The
 * description differs because the cause does: the caller did not merely send
 * two methods, it sent two *different* identities, and a human reading the log
 * should not have to diff two base64 blobs to find that out. Neither value is
 * echoed — one of them is a secret.
 */
function mixedCredentialsRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: "invalid_request",
      error_description:
        "The Authorization header and the request body carry different client credentials",
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        // RFC 6749 §5.1, and what the plugin puts on its own token errors —
        // measured. A refusal this service writes itself should be
        // indistinguishable in form from one Better Auth wrote.
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

/**
 * One line per `/oauth2/token` rejection: the status, the OAuth error, its
 * description, and the client authentication method the caller used.
 *
 * That last field is the whole point. Before it, a refusal here was a two-way
 * question nobody could answer from outside — a wrong secret and a client
 * registered for the other auth method produce the same `invalid_client`, and
 * this service logged only its boot lines (#75).
 *
 * **No secret is ever on this line, structurally.** The client id is not echoed
 * from the request either: under Basic it lives in the same base64 blob as the
 * secret, and a caller that swapped the two fields would have us print one. So
 * the request's id is compared against the registered ones and the line says
 * which of them it was — enough to tell "Arcade is pointed at a different
 * client" from "Arcade has the wrong secret", which is the question anyone
 * reading this line is asking.
 */
async function logTokenFailure(
  token: TokenRequest,
  response: Response,
  registered: string[],
  code: CodeState | null = null,
) {
  const body = (await response.clone().json().catch(() => null)) as
    | { error?: string; error_description?: string }
    | null;
  const claimed = requestClientId(token);

  console.log(
    `[${SERVICE}] POST ${TOKEN_PATH} rejected: status=${response.status} ` +
      `error=${body?.error ?? "(none)"} ` +
      `error_description=${JSON.stringify(body?.error_description ?? "(none)")} ` +
      `client_auth=${JSON.stringify(observedClientAuth(token))} ` +
      `client_id=${claimed !== null && registered.includes(claimed) ? claimed : "(not the registered client)"}` +
      (code === null ? "" : ` code=${code}`),
  );

  // Its own line, because this one is not a refusal — it is damage. The replay
  // has already made the plugin revoke the tokens the first exchange minted, so
  // the relying party is now holding a grant that will fail at
  // `/oauth2/userinfo` with nothing else to say why (#100).
  //
  // `console.log`, not `console.warn`: this is the second half of the sentence
  // above it, and a two-line diagnosis split across stdout and stderr is two
  // lines a reader has to reassemble from interleaved streams.
  if (code === "already_consumed") {
    console.log(
      `[${SERVICE}] that code had already been exchanged — the tokens its first exchange ` +
        `minted have just been revoked (revokeTokensIssuedForAuthorizationCode). ` +
        `Something is fetching the authorization callback twice.`,
    );
  }
}

/**
 * Constant-time bearer check. Both sides are hashed first so the comparison
 * gets two equal-length buffers whatever was presented.
 */
function bearerIs(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return token.length > 0 && timingSafeEqual(digest(token), digest(expected));
}

/**
 * `POST /admin/reset` (#23) — the same work `scripts/reset.ts` does, for a
 * caller with no shell on this service.
 *
 * A rotated OAuth client is a **500**, not a 200 with a warning in the body.
 * The whole reason this endpoint asserts at all is that the failure it guards
 * against is silent everywhere else: Arcade would go on holding a dead client
 * id and the next authorize would fail before any hook ran. `bun run reset`
 * exits non-zero on a non-2xx, so the one thing a presenter must not miss is
 * the one thing that stops the command.
 *
 * The response names what was **not** reset for the same reason the other two
 * services do: a presenter who reset one and assumed the rest followed is
 * about to go on stage with half a demo.
 */
async function handleReset(): Promise<Response> {
  try {
    const result = await runIdpReset({
      db,
      auth,
      clients: config.clients,
      secret: config.secret,
    });
    console.log(`[${SERVICE}] ${resetSummary(config.dbPath, result)}`);
    return Response.json({
      service: SERVICE,
      reset: "idp.db",
      ...result,
      not_reset: {
        oauthClient:
          "untouched, and asserted unchanged on both sides of the reset — it is the client id and secret Arcade is registered against",
        jwks: "untouched — new signing keys would be rejected by anything holding the old key set",
        other_services:
          "nothing outside this database: every other service resets its own through its own endpoint, and `bun run reset` at the repo root calls all of them in order",
      },
    });
  } catch (cause) {
    if (!(cause instanceof OAuthClientRotatedError)) throw cause;
    console.error(`[${SERVICE}] ${cause.message}`);
    return Response.json(
      { service: SERVICE, error: cause.message, oauth_client_rotated: cause.rotations },
      { status: 500 },
    );
  }
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({
        status: "ok",
        service: SERVICE,
        issuer: config.baseURL,
        people: countPeople(db),
        oauth: {
          client_id: client.clientId,
          authorize: `${config.baseURL}/oauth2/authorize`,
          token: `${config.baseURL}/oauth2/token`,
          userinfo: `${config.baseURL}/oauth2/userinfo`,
          jwks: `${config.baseURL}${JWKS_PATH}`,
          id_token_signing_alg: ID_TOKEN_ALG,
          // What the client row registers for at the token endpoint, and
          // therefore the one value the Arcade dashboard's "client
          // authentication" field may hold. Reported because the reconcile in
          // `ensureOAuthClient` is otherwise invisible: a row still on
          // `client_secret_post` fails server-to-server, fires no hook, and
          // leaves the panel dark (#61).
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          // What happened to the stored client secret when this process
          // booted. `rotated` is the one that costs a human a re-registration
          // in the Arcade dashboard, and #70 exists because that is otherwise
          // indistinguishable from a service that came up fine (the failure
          // lands at the authorize step, where no hook fires).
          client_secret_state: client.secretState,
          client_secret_note: CLIENT_SECRET_STATE_MESSAGE[client.secretState],
          // Every configured client, first one first (#79). A deployment that
          // never set `IDP_OAUTH_CLIENTS` has exactly one entry here, and that
          // entry is the object above — which is how a human checks from
          // outside whether a second registration exists at all, rather than
          // inferring it from a dashboard they may not be looking at.
          clients: clients.map((each) => ({
            key: each.key,
            name: each.name,
            client_id: each.clientId,
            redirect_uris: each.redirectUris,
            token_endpoint_auth_method: each.tokenEndpointAuthMethod,
            client_secret_state: each.secretState,
          })),
          // What the token endpoint does with Arcade's duplicated credentials
          // (#79). Stated because it is a deviation from RFC 6749 §2.3 and a
          // reviewer should not have to read the source to find its bounds.
            duplicate_client_credentials:
            "accepted when the Authorization: Basic pair and the body client_id/client_secret pair are identical; refused invalid_request when they differ",
        },
        // Named even when it is off, so the 404 `bun run reset` gets has
        // somewhere to be explained (#23).
        reset: resetEnabled(config) ? "enabled" : "disabled",
      });
    }

    if (pathname === RESET_PATH) {
      // Unset token: the route does not exist. A 404 and not a 403, so an
      // unconfigured deployment is indistinguishable from one that never had
      // the endpoint; /health says `reset: "disabled"`, which is where the
      // explanation lives.
      if (!resetEnabled(config)) return Response.json({ error: "Not found" }, { status: 404 });
      if (!bearerIs(request, config.resetToken)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      return handleReset();
    }

    if (pathname === LOGIN_PAGE) {
      if (request.method === "GET") return loginPage(url);
      if (request.method === "POST") return handleLogin(request);
    }
    if (pathname === CONSENT_PAGE) {
      if (request.method === "GET") return consentPage(request, url);
      if (request.method === "POST") return handleConsent(request);
    }

    if (request.method === "GET" && pathname === "/") {
      return html(
        renderMessagePage(
          "Enterprise Identity",
          "This is the demo's identity provider. Sign-in happens when an application sends you here.",
        ),
      );
    }

    // The token endpoint, wrapped for two things: Arcade's duplicated
    // credentials (#79), and a line left behind when it says no (#61).
    // Whatever Better Auth answers is passed back byte for byte.
    if (request.method === "POST" && pathname === TOKEN_PATH) {
      // Read once and re-issued rather than cloned: a token request is one
      // small form post per authorization, and the handler needs an
      // undisturbed body whether or not anything ends up being logged.
      const body = await request.text();
      const authorization = request.headers.get("authorization");
      const sent: TokenRequest = { authorization, form: new URLSearchParams(body) };
      const dual = classifyDualCredentials(sent);

      // Two different identities in one request. The plugin would refuse this
      // too, one line later and for a less specific reason; refusing it here is
      // what keeps the tolerance below down to "the same credentials twice".
      if (dual === "mixed") {
        const refusal = mixedCredentialsRefusal();
        await logTokenFailure(sent, refusal, registeredClientIds);
        return refusal;
      }

      // Grant-agnostic on purpose: the same Request Parameter rows sit on
      // Arcade's Token Settings and its Refresh Token Settings, so
      // `authorization_code` and `refresh_token` arrive in the same shape and
      // this runs before either is dispatched.
      const forwardedForm = dual === "duplicated" ? withoutBodyClientSecret(sent.form) : sent.form;
      const forwardedBody = dual === "duplicated" ? forwardedForm.toString() : body;

      // Read *before* the handler runs, and this is the whole trick: the plugin
      // answers a replayed code and an unknown one with the same
      // `invalid_grant "invalid code"`, and on the way it revokes the tokens the
      // first exchange minted — which is the only evidence that the code was
      // ever real. Afterwards there is nothing left to tell them apart.
      const presented = sent.form.get("grant_type") === "authorization_code" ? sent.form.get("code") : null;
      const presentedState = presented ? codeState(db, await authorizationCodeId(presented)) : null;

      const response = await auth.handler(
        new Request(request.url, {
          method: "POST",
          headers: forwardedHeaders(request, Buffer.byteLength(forwardedBody)),
          body: forwardedBody,
        }),
      );
      if (response.status >= 400) {
        // Logged as what the plugin was asked, not as what arrived: after the
        // strip this *is* a `client_secret_basic` request, and saying anything
        // else would send a reader looking for a method problem that is gone.
        // The code classification rides along only when the plugin's own answer
        // is the ambiguous one. On any other rejection — wrong secret, wrong
        // redirect_uri, PKCE — the code's history is not the question, and a
        // `code=unknown` beside `invalid_client` would send a reader looking in
        // the wrong place.
        const answered = (await response.clone().json().catch(() => null)) as
          | { error?: string; error_description?: string }
          | null;
        const ambiguous =
          answered?.error === "invalid_grant" && answered?.error_description === "invalid code";
        await logTokenFailure(
          { authorization, form: forwardedForm },
          response,
          registeredClientIds,
          ambiguous ? presentedState : null,
        );
      }
      return response;
    }

    // Everything else is Better Auth: /oauth2/*, /.well-known/*, /sign-in/*, ...
    return auth.handler(request);
  },
});

console.log(
  `[${SERVICE}] listening on :${server.port} — issuer ${config.baseURL}, ` +
    `${countPeople(db)} people in ${config.dbPath}, ` +
    `OAuth client${clients.length > 1 ? "s" : ""} ` +
    `${clients.map((each) => `${each.clientId} (${each.key}, ${each.created ? "created" : "existing"})`).join(", ")}, ` +
    `JWKS ${config.baseURL}${JWKS_PATH} (${ID_TOKEN_ALG})` +
    (usingDevSecret(config) ? " — using the development secret" : ""),
);

console.log(
  resetEnabled(config)
    ? `[${SERVICE}] POST ${RESET_PATH} is enabled (bearer RESET_TOKEN)`
    : `[${SERVICE}] POST ${RESET_PATH} is disabled: RESET_TOKEN is unset, so the route answers 404`,
);

// Its own line, and on stderr when it is the one that costs a human something,
// so `render logs` shows it without anyone having to know to look. The secret
// itself is never printed here, whatever happened to it — `bun run
// oauth-client --rotate` is the only thing that prints one.
for (const each of clients) {
  const label = clients.length > 1 ? `OAuth client secret (${each.key})` : "OAuth client secret";
  const secretLine = `[${SERVICE}] ${label}: ${CLIENT_SECRET_STATE_MESSAGE[each.secretState]}`;
  if (each.secretState === "rotated") console.error(secretLine);
  else console.log(secretLine);
}

// The other thing that can cost a human a field in the Arcade dashboard, and
// the one this boot may just have changed underneath them. On stderr for the
// same reason the rotation line is: `render logs` shows it without anyone
// having to know to look.
for (const each of clients.filter((candidate) => candidate.authMethodReconciled)) {
  console.error(
    `[${SERVICE}] OAuth client token auth method reconciled to ` +
      `${each.tokenEndpointAuthMethod} (#61)${clients.length > 1 ? ` for "${each.key}"` : ""}. ` +
      `The Arcade cg-idp provider's ` +
      `"client authentication" must now be ${each.tokenEndpointAuthMethod} — ` +
      `the credentials are unchanged, and the other form is refused with invalid_client.`,
  );
}

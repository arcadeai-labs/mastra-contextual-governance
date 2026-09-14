/**
 * Every identity route, as plain `(Request) => Promise<Response>` functions.
 *
 * `app/api/**` is a one-line adapter onto each of these. The indirection buys
 * one thing and it is the thing this slice needs most: `test/identity-flow.test.ts`
 * mounts these same functions behind a real `Bun.serve` and drives them with a
 * cookie jar over real HTTP, against a real `apps/idp` subprocess. So the suite
 * exercises the `Set-Cookie` header a browser would actually receive and the
 * redirect chain a browser would actually walk — no framework mock, and no
 * stand-in anywhere except at the network edge where Arcade Cloud is.
 *
 * The five routes, and the two hops they make up:
 *
 *   GET  /api/auth/signin     start sign-in at apps/idp as client C   ─┐ hop 0:
 *   GET  /api/auth/callback   the IdP's return leg; the session is made ┘ who you are
 *   GET  /api/arcade/start    begin the gateway authorization         ─┐ hop 1:
 *   GET  /api/arcade/callback the gateway's return leg; the token      ┘ the bearer
 *   GET  /api/arcade/verify   Arcade's custom user verifier            ← hop 2
 *   POST /api/auth/signout    forget this browser's persona
 */
/**
 * The identity routes read `readIdentitySurface`, not `readWebConfig`.
 *
 * Nothing in this file touches the approvals store, and `readWebConfig` throws
 * under `NODE_ENV=production` when `APPROVALS_STORE_TOKEN` is unset. Going
 * through it would make a missing approvals credential turn every sign-in into
 * a `500` — measured against the production build before this line existed:
 *
 *   GET /api/auth/signin -> 500
 *   Error: APPROVALS_STORE_TOKEN is required in production
 *
 * Same environment, same file reading it; just without a guard that belongs to
 * a credential these routes do not present.
 */
import { gatewayProblems, readIdentitySurface, signinProblems, verifierProblems,
  type IdentitySurface } from "../config.ts";
import { clearLeg, clearSession, GATEWAY_COOKIE, PENDING_FLOW_COOKIE, readLeg, readSession,
  SIGNIN_COOKIE, withGatewayToken, writeLeg, writeSession, type GatewayLeg, type PendingFlow,
  type Session, type SigninLeg } from "./session.ts";
import { escapeHtml, notConfigured, page, redirect, verbatim } from "./pages.ts";
import { authorizeUrl, exchangeCode, fetchUserinfo, nonce, pkce } from "./oidc.ts";
import { exchangeGatewayCode, expiryOf, gatewayAuthorizeUrl, gatewayClient, isExpiring, mcpUrl,
  refreshGatewayToken } from "./gateway.ts";
import { knownPersona } from "./personas.ts";
import { confirmUser, followNextUri } from "./verifier.ts";

export const SIGNIN_PATH = "/api/auth/signin";
export const SIGNIN_CALLBACK_PATH = "/api/auth/callback";
export const GATEWAY_START_PATH = "/api/arcade/start";
export const GATEWAY_CALLBACK_PATH = "/api/arcade/callback";
export const VERIFY_PATH = "/api/arcade/verify";
export const SIGNOUT_PATH = "/api/auth/signout";

/**
 * Query parameters this service refuses to see on the verifier route.
 *
 * Arcade sends a verifier **exactly one** parameter — `flow_id` — measured on
 * #75 by recording the whole query string rather than reading the field we
 * expected. So a request carrying an identity hint did not come from Arcade,
 * and the only reason to send one is to have the verifier confirm a flow as
 * somebody other than the person holding the browser.
 *
 * Ignoring them would be correct — nothing here reads them — but silence is the
 * failure mode this project keeps out of its controls. A refusal is testable
 * from outside, and a log line beats an assurance that some code does not do
 * something.
 */
export const IDENTITY_PARAMS = ["user_id", "email", "sub", "login_hint"] as const;

/** A same-origin path, or the default. Never an absolute URL, and never `//host`. */
export function safeNext(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

function redirectUri(config: IdentitySurface, path: string): string {
  return `${config.identity.publicUrl}${path}`;
}

// ---------------------------------------------------------------------------
// Hop 0 — sign in as a person
// ---------------------------------------------------------------------------

/**
 * `GET /api/auth/signin?persona=&next=`
 *
 * **`prompt=login` on every sign-in, unconditionally.** The issue asks that
 * switching persona never silently reuse the previous persona's IdP session,
 * and the cheap version of that is to detect a switch and force re-auth only
 * then. This does it always instead: a switch that has to be detected is a
 * switch that can be missed, and the cost of being wrong is every tool call for
 * the rest of the demo being made as the wrong person while the screen says
 * otherwise. One password per sign-in is the correct price.
 *
 * The old session is cleared here rather than on the way back, so a sign-in
 * abandoned at the IdP's login page leaves this browser signed in as nobody
 * rather than still signed in as the previous persona.
 */
export async function signin(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const problems = signinProblems(config);
  if (problems.length > 0) return notConfigured("Sign-in", problems);

  const url = new URL(request.url);
  const headers = new Headers();
  clearSession(headers, request, config);

  const { verifier, challenge } = await pkce();
  const state = nonce();
  // The persona key is a label for the page and never an identity — an
  // unknown one is dropped rather than echoed back into a cookie.
  const persona = knownPersona(url.searchParams.get("persona"));
  const leg: SigninLeg = {
    state,
    verifier,
    next: safeNext(url.searchParams.get("next"), GATEWAY_START_PATH),
    ...(persona ? { persona } : {}),
  };
  await writeLeg(headers, SIGNIN_COOKIE, leg, config);

  return redirect(
    authorizeUrl({
      issuer: config.identity.idpIssuer,
      clientId: config.identity.idpClientId,
      redirectUri: redirectUri(config, SIGNIN_CALLBACK_PATH),
      scope: config.identity.idpScopes,
      state,
      challenge,
      prompt: "login",
    }),
    headers,
  );
}

/**
 * `GET /api/auth/callback?code&state`
 *
 * Establishes the session, then does one of three things: completes a parked
 * Arcade verification, reports that a parked one expired, or carries on to
 * hop 1.
 */
export async function signinCallback(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const problems = signinProblems(config);
  if (problems.length > 0) return notConfigured("Sign-in", problems);

  const url = new URL(request.url);
  const leg = await readLeg<SigninLeg>(request, SIGNIN_COOKIE, config);
  const headers = new Headers();
  clearLeg(headers, SIGNIN_COOKIE, config);

  if (!leg) {
    return page(
      "This sign-in did not start here",
      "<p>The request that brought you back has no sign-in in progress on this browser. " +
        "It may have taken more than ten minutes, or this may be a link from somewhere else.</p>" +
        `<p><a href="/">Start again</a>.</p>`,
      400,
      headers,
    );
  }

  const error = url.searchParams.get("error");
  if (error) {
    return page(
      "The identity provider refused",
      verbatim(`${error}: ${url.searchParams.get("error_description") ?? ""}`),
      400,
      headers,
    );
  }
  // A state that does not match is a callback this browser did not ask for.
  if (url.searchParams.get("state") !== leg.state) {
    return page(
      "This sign-in did not start here",
      "<p>The <code>state</code> on the callback is not the one this browser issued.</p>",
      400,
      headers,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return page("No authorization code", "<p>The callback carried no <code>code</code>.</p>", 400, headers);

  const exchanged = await exchangeCode({
    issuer: config.identity.idpIssuer,
    clientId: config.identity.idpClientId,
    clientSecret: config.identity.idpClientSecret,
    redirectUri: redirectUri(config, SIGNIN_CALLBACK_PATH),
    code,
    codeVerifier: leg.verifier,
  });
  if (!exchanged.ok) {
    return page("Token exchange failed", verbatim(`${exchanged.status} ${exchanged.body}`), 502, headers);
  }

  const userinfo = await fetchUserinfo(config.identity.idpIssuer, exchanged.token.access_token);
  if (!userinfo.ok) {
    return page("The identity provider returned no email", verbatim(`${userinfo.status} ${userinfo.body}`), 502, headers);
  }

  const session: Session = { email: userinfo.email, signed_in_at: Date.now() };
  await writeSession(headers, request, session, config);

  // A sign-in that an Arcade verification parked: finish that, not the
  // ordinary landing. The flow cookie is this browser's, sealed, and holds
  // nothing but the id Arcade sent.
  const pending = await readLeg<PendingFlow>(request, PENDING_FLOW_COOKIE, config);
  if (pending?.flow_id) {
    clearLeg(headers, PENDING_FLOW_COOKIE, config);
    return completeVerification(pending.flow_id, session.email, config, headers);
  }
  if (leg.next === VERIFY_PATH) {
    // The sign-in was started *by* the verifier and the parked flow is gone —
    // the ten minutes ran out, or the cookie was dropped. Say so. Arcade's
    // authorization is still half-open and the tool will ask again; what must
    // not happen is this browser landing on a cheerful home page as though the
    // authorization had completed.
    clearLeg(headers, PENDING_FLOW_COOKIE, config);
    return page(
      "That authorization request expired",
      `<p>You are signed in as <code>${escapeHtml(session.email)}</code>, but the tool authorization ` +
        "that sent you here was parked more than ten minutes ago and is no longer held on this browser.</p>" +
        "<p>Ask the agent for the same tool again — Arcade will start a fresh authorization, and this " +
        "time you are already signed in, so it will complete without another password.</p>",
      410,
      headers,
    );
  }

  return redirect(leg.next, headers);
}

/** `POST /api/auth/signout` — forget the persona and the gateway token with it. */
export function signout(request: Request, config: IdentitySurface = readIdentitySurface()): Response {
  const headers = new Headers();
  clearSession(headers, request, config);
  clearLeg(headers, SIGNIN_COOKIE, config);
  clearLeg(headers, GATEWAY_COOKIE, config);
  clearLeg(headers, PENDING_FLOW_COOKIE, config);
  return redirect("/", headers);
}

// ---------------------------------------------------------------------------
// Hop 1 — the gateway token
// ---------------------------------------------------------------------------

/** `GET /api/arcade/start?next=` — begin the gateway authorization for the signed-in persona. */
export async function gatewayStart(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const problems = gatewayProblems(config);
  if (problems.length > 0) return notConfigured("The gateway hop", problems);

  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), "/");
  const session = await readSession(request, config);
  // Not signed in: there is no persona to get a token for. Sign in first, and
  // come back here rather than to the home page.
  if (!session) {
    return redirect(`${SIGNIN_PATH}?next=${encodeURIComponent(`${GATEWAY_START_PATH}?next=${next}`)}`);
  }

  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const callback = redirectUri(config, GATEWAY_CALLBACK_PATH);
  let client;
  try {
    client = await gatewayClient(resource, callback, process.env.ARCADE_MCP_CLIENT_ID?.trim() || undefined);
  } catch (failure) {
    return page("The gateway would not register a client", verbatim(String(failure)), 502);
  }

  const { verifier, challenge } = await pkce();
  const state = nonce();
  const headers = new Headers();
  await writeLeg(headers, GATEWAY_COOKIE, { state, verifier, client_id: client.clientId, next } satisfies GatewayLeg, config);

  return redirect(
    gatewayAuthorizeUrl({ client, redirectUri: callback, resource, state, challenge }),
    headers,
  );
}

/** `GET /api/arcade/callback?code&state` — store the gateway token on this browser's session. */
export async function gatewayCallback(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  // Checked here too, not only where the flow starts. Without a usable
  // `SESSION_SECRET` the leg cookie cannot be opened, and the honest answer to
  // "this authorization did not start here" would be that it did — the service
  // just cannot read its own note. Say which it is.
  const problems = gatewayProblems(config);
  if (problems.length > 0) return notConfigured("The gateway hop", problems);

  const url = new URL(request.url);
  const leg = await readLeg<GatewayLeg>(request, GATEWAY_COOKIE, config);
  const headers = new Headers();
  clearLeg(headers, GATEWAY_COOKIE, config);

  if (!leg) {
    return page(
      "This authorization did not start here",
      "<p>No gateway authorization is in progress on this browser.</p>",
      400,
      headers,
    );
  }

  const error = url.searchParams.get("error");
  if (error) {
    return page("Arcade refused the authorization", verbatim(`${error}: ${url.searchParams.get("error_description") ?? ""}`), 400, headers);
  }
  if (url.searchParams.get("state") !== leg.state) {
    return page(
      "This authorization did not start here",
      "<p>The <code>state</code> on the callback is not the one this browser issued.</p>",
      400,
      headers,
    );
  }

  const session = await readSession(request, config);
  // The session went away mid-flow. Binding a gateway token to a browser with
  // no persona would be storing a credential nobody is accountable for.
  if (!session) {
    return page(
      "You are not signed in",
      `<p>The gateway answered, but this browser has no session to attach the token to. ` +
        `<a href="${SIGNIN_PATH}">Sign in</a> and try again.</p>`,
      400,
      headers,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return page("No authorization code", "<p>The callback carried no <code>code</code>.</p>", 400, headers);

  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const client = await gatewayClient(resource, redirectUri(config, GATEWAY_CALLBACK_PATH), leg.client_id);
  const exchanged = await exchangeGatewayCode({
    client,
    redirectUri: redirectUri(config, GATEWAY_CALLBACK_PATH),
    resource,
    code,
    codeVerifier: leg.verifier,
  });
  if (!exchanged.ok) {
    return page("The gateway refused the code", verbatim(`${exchanged.status} ${exchanged.body}`), 502, headers);
  }

  await writeSession(
    headers,
    request,
    withGatewayToken(session, {
      access_token: exchanged.token.access_token,
      ...(exchanged.token.refresh_token && { refresh_token: exchanged.token.refresh_token }),
      expires_at: expiryOf(exchanged.token),
      client_id: leg.client_id,
    }),
    config,
  );
  return redirect(leg.next, headers);
}

/**
 * The live gateway bearer for a session, refreshed server-side if it is close
 * to expiry.
 *
 * Returns the token **and** the session it belongs to, because a refresh
 * changes the session and the caller has to reseal it — an interface that
 * returned only a string would make "the token was refreshed and then thrown
 * away" the easy mistake. #14 is the first caller; this slice's job is to make
 * the token exist and stay live.
 *
 * **It fails loudly or not at all (#94).** Every path that cannot produce a live
 * bearer returns `{ token: null, reason }` — no token, no expired token, a
 * refresh that answered non-2xx, a refresh that answered 2xx with no
 * `access_token` on it. The one thing it never does is hand back the token it
 * already had: a stale bearer is accepted by the type system, presented to the
 * gateway, refused there, and read on screen as a missing toolkit.
 */
export async function liveGatewayToken(
  session: Session,
  config: IdentitySurface = readIdentitySurface(),
  now = Date.now(),
): Promise<{ token: string; session: Session } | { token: null; reason: string }> {
  if (!session.gateway) return { token: null, reason: "this browser holds no gateway token" };
  if (!isExpiring(session.gateway.expires_at, now)) {
    return { token: session.gateway.access_token, session };
  }
  if (!session.gateway.refresh_token) {
    return { token: null, reason: "the gateway token has expired and there is no refresh token" };
  }

  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const client = await gatewayClient(resource, redirectUri(config, GATEWAY_CALLBACK_PATH), session.gateway.client_id);
  const refreshed = await refreshGatewayToken({
    tokenEndpoint: client.metadata.token_endpoint,
    clientId: session.gateway.client_id,
    refreshToken: session.gateway.refresh_token,
    resource,
  });
  if (!refreshed.ok) {
    // The status, and nothing else. A refusal body belongs to the authorization
    // server and may carry anything, including a credential; the number is the
    // whole diagnosis and it is safe to write down (#94).
    console.warn(`[gateway] refreshing this browser's gateway token answered ${refreshed.status}`);
    return { token: null, reason: `refreshing the gateway token answered ${refreshed.status}` };
  }

  // A 2xx with no `access_token` on it is not a refresh, and it is the shape
  // that made #94 expensive: the field is `undefined`, it flows into the session
  // and out to `MCPClient` as the bearer, and the gateway's refusal surfaces
  // three layers later as "the gateway advertised 0 tools". Nothing usable came
  // back, so nothing is returned — and the token already held is *not* handed
  // back in its place, because a stale bearer fails the same way.
  const access = refreshed.token.access_token;
  if (typeof access !== "string" || access.trim() === "") {
    console.warn(`[gateway] refreshing this browser's gateway token answered ${refreshed.status} with no access_token`);
    return { token: null, reason: `refreshing the gateway token answered ${refreshed.status} with no access_token` };
  }
  console.info(`[gateway] refreshed this browser's gateway token (${refreshed.status})`);

  const gateway = {
    access_token: access,
    // An authorization server may rotate the refresh token or may not; keeping
    // the old one when none comes back is what makes a non-rotating server work.
    refresh_token: refreshed.token.refresh_token ?? session.gateway.refresh_token,
    expires_at: expiryOf(refreshed.token, now),
    client_id: session.gateway.client_id,
  };
  return { token: access, session: withGatewayToken(session, gateway) };
}

// ---------------------------------------------------------------------------
// Hop 2 — the custom verifier
// ---------------------------------------------------------------------------

/**
 * `GET /api/arcade/verify?flow_id=…`
 *
 * The identity comes from this browser's sealed session and from nowhere else.
 * There is no branch in this function that reads a persona from the request,
 * and a request that carries one is refused rather than quietly served.
 */
export async function verify(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const url = new URL(request.url);

  const smuggled = IDENTITY_PARAMS.filter((name) => url.searchParams.has(name));
  if (smuggled.length > 0) {
    return page(
      "This route does not take an identity",
      `<p>The request carried ${escapeHtml(smuggled.join(", "))}. Arcade calls this route with ` +
        "<code>flow_id</code> and nothing else, and the person a flow is confirmed as is read from " +
        "this browser's signed-in session — never from the request.</p>",
      400,
    );
  }

  const flowId = url.searchParams.get("flow_id");
  if (!flowId) {
    return page(
      "No flow_id",
      "<p>Arcade calls this route as <code>/api/arcade/verify?flow_id=…</code>.</p>",
      400,
    );
  }

  const problems = verifierProblems(config);
  if (problems.length > 0) return notConfigured("The custom verifier", problems);

  const session = await readSession(request, config);
  if (!session) {
    // The human's case, and expected on every fresh Chrome profile. Park the
    // flow — sealed, so the id is not readable or forgeable in the browser —
    // and send them to sign in. `next` is the verify path so the callback can
    // tell a sign-in that owes an authorization from one that does not.
    const headers = new Headers();
    await writeLeg(headers, PENDING_FLOW_COOKIE, { flow_id: flowId, parked_at: Date.now() } satisfies PendingFlow, config);
    return redirect(`${SIGNIN_PATH}?next=${encodeURIComponent(VERIFY_PATH)}`, headers);
  }

  return completeVerification(flowId, session.email, config, new Headers());
}

/**
 * The two server-side calls, in the one order that finalises a grant.
 *
 * Shared by the with-session path and the signed-in-just-now path, so the
 * parked flow completes through exactly the same code as an ordinary one.
 */
export async function completeVerification(
  flowId: string,
  email: string,
  config: IdentitySurface,
  headers: Headers,
): Promise<Response> {
  const confirmed = await confirmUser({
    cloudUrl: config.identity.cloudUrl,
    apiKey: config.arcadeApiKey,
    flowId,
    email,
  });
  if (!confirmed.ok) {
    return page(
      "Arcade would not confirm this authorization",
      `<p>Confirming the flow as <code>${escapeHtml(email)}</code> answered ` +
        `<code>${confirmed.status}</code>.</p>${verbatim(confirmed.body)}` +
        "<p>Nothing was authorized. The tool will ask again.</p>",
      502,
      headers,
    );
  }

  const next = typeof confirmed.response.next_uri === "string" ? confirmed.response.next_uri : undefined;
  if (!next) {
    return page(
      "Verified",
      `<p>Confirmed <code>${escapeHtml(email)}</code>, but Arcade returned no <code>next_uri</code>, ` +
        "so there is nothing to finalise the grant against.</p>",
      200,
      headers,
    );
  }

  // Measured on #75: Arcade does not finalise the grant until something fetches
  // this. A 303 the browser follows is not enough — a scripted agent, a
  // prefetch-blocking extension or a closed tab leaves the grant half-made and
  // the tool re-challenging with nothing on screen to say why.
  await followNextUri(next);
  return redirect(next, headers);
}

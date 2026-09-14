/**
 * Hop 1: the gateway token.
 *
 * `DESIGN.md` → **Two hops, two mechanisms**. Hop 1 is MCP client → gateway,
 * governed by the User Source gateway `cg-demo-us`. Arcade brokers the login to
 * `apps/idp`, and the token that comes back is the bearer every later tool call
 * carries — the one whose identity the `/access` and `/pre` hooks see.
 *
 * **`apps/web` drives this flow itself.** Mastra's `MCPClient.authenticate()`
 * refuses a non-loopback redirect URI, and this service is deployed at an
 * HTTPS origin, so the alternative would be a loopback listener on a Render
 * instance nobody's browser can reach. `MCPClient` is handed a static token
 * instead (#14). Every step below is the one spike #04 measured against the
 * live gateway; nothing here is inferred from a specification.
 *
 *   POST <mcp>            no token  -> 401 + WWW-Authenticate: resource_metadata="…"
 *   GET  <resource metadata>        -> authorization_servers[0]
 *   GET  /.well-known/oauth-authorization-server<path>
 *   POST <registration_endpoint>    -> client_id for our HTTPS redirect
 *   GET  <authorization_endpoint>   -> Arcade's consent screen, then our callback
 *   POST <token_endpoint>           -> access + refresh token
 *
 * The `resource` parameter rides on both the authorize and the token request,
 * as RFC 8707 asks and as the measured flow sent it.
 */

/** What the authorization server publishes. Only the three endpoints are used. */
export interface GatewayMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

/** Everything hop 1 needs to start, discovered once and then held. */
export interface GatewayClient {
  metadata: GatewayMetadata;
  clientId: string;
  /** Present only if the authorization server issued one; `none` is what we register for. */
  clientSecret?: string;
}

/** `mcp offline_access` — `offline_access` is what makes a refresh token possible. */
export const GATEWAY_SCOPE = "mcp offline_access";

/**
 * Registration is cached **per process**, keyed by gateway URL and redirect URI.
 *
 * Arcade renders its gateway consent screen once per persona per MCP client id,
 * so a fresh dynamic registration on every sign-in would mean a consent screen
 * on every sign-in. A process-lifetime cache is the cheapest thing that avoids
 * that without a fourth database: one registration per deploy, shared by every
 * persona, and a restart costs one extra consent click per persona — which is
 * the same click a new browser profile costs anyway.
 *
 * `ARCADE_MCP_CLIENT_ID` overrides it for a deployment that would rather pin a
 * registration than let one be minted; nothing in this repo requires it.
 */
const registrations = new Map<string, Promise<GatewayClient>>();

/** The gateway's MCP endpoint: `https://api.arcade.dev/mcp/cg-demo-us`. */
export function mcpUrl(arcadeApiUrl: string, gatewayId: string): string {
  return `${arcadeApiUrl}/mcp/${gatewayId}`;
}

/**
 * The JSON-RPC `initialize` every probe in this file sends.
 *
 * One body, two callers. `discoverGateway` sends it with no bearer to be told
 * where the resource metadata lives; `probeGatewayToken` sends it *with* one to
 * find out whether the gateway still takes it. Sharing the body is what makes
 * the two requests differ in exactly one header — the one under test.
 */
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cg-web", version: "0.1.0" } },
});

/**
 * Discovery, as the 401 drives it.
 *
 * The unauthenticated `initialize` is not a formality — it is where the
 * resource metadata URL comes from. Guessing `/.well-known/…` off the MCP URL
 * would be a second source of truth for something Arcade already states.
 */
export async function discoverGateway(url: string): Promise<GatewayMetadata> {
  const probe = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: INITIALIZE,
  });
  if (probe.status !== 401) {
    throw new Error(`${url} answered ${probe.status} to an unauthenticated initialize, expected 401`);
  }

  const resourceMetadata = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "")?.[1];
  if (!resourceMetadata) throw new Error("no resource_metadata in the gateway's WWW-Authenticate header");

  const resource = (await (await fetch(resourceMetadata)).json()) as { authorization_servers?: string[] };
  const server = resource.authorization_servers?.[0];
  if (!server) throw new Error(`${resourceMetadata} named no authorization_servers`);

  // RFC 8414 §3.1: the well-known segment goes after the origin and before the
  // issuer's path, which is not where a naive join would put it.
  const issuer = new URL(server);
  const metadataUrl = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/+$/, "")}`;
  const metadata = (await (await fetch(metadataUrl)).json()) as Partial<GatewayMetadata>;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) {
    throw new Error(`${metadataUrl} did not publish the three endpoints hop 1 needs`);
  }
  return metadata as GatewayMetadata;
}

/**
 * What the gateway says about one bearer.
 *
 * `rejected` is a decision the gateway made about the credential and has a fix a
 * person can carry out. `unreachable` is everything else and has not. Keeping
 * them apart is the whole point — see `probeGatewayToken`.
 */
export type GatewayTokenProbe =
  | { outcome: "accepted"; status: number }
  | { outcome: "rejected"; status: number }
  | { outcome: "unreachable"; detail: string };

/**
 * Ask the gateway, in one request, whether it still accepts this browser's
 * bearer.
 *
 * **Why this exists.** Measured on #94 against `@mastra/mcp` 1.17.3: a gateway
 * that refuses the bearer does not make `listToolsets()` throw. It *resolves*,
 * with an empty toolset, because Mastra logs the connection failure per server
 * and hands back whatever connected. So a rejected token and a gateway carrying
 * none of our toolkits arrive as the same value — `{}` — and #94's live failure
 * is the second message being printed for the first cause, on stage, with a link
 * to nothing in it.
 *
 * **Why a raw `initialize` rather than `MCPClient.getServerAuthState()`.** The
 * client does expose that state, and it is right when the 401 surfaces as the
 * SDK's `UnauthorizedError`: measured on #94, a stub answering 401 to the
 * streamable POST leaves `getServerAuthState("arcade") === "needs-auth"`. But it
 * is `undefined` whenever the POST fails any other way and the client falls back
 * to SSE — measured with a stub answering 405, which reproduces the live cg-web
 * log line for line, down to *"Could not connect to server with any available
 * HTTP transport"*. A control whose answer depends on which error class a
 * dependency happened to raise is a control that stops answering without saying
 * so. An HTTP status code is the gateway's own word about the credential and it
 * is the same number in both shapes.
 *
 * The token goes out on the wire and comes back as a number. It is never
 * returned, logged or put in a message.
 *
 * One `initialize` with no `notifications/initialized` after it leaves a session
 * the gateway will expire on its own; that is the price of one round trip per
 * turn, and it is paid on the turn rather than on stage.
 */
export async function probeGatewayToken(
  url: string,
  token: string,
  timeoutMs = 10_000,
): Promise<GatewayTokenProbe> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: INITIALIZE,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    return { outcome: "unreachable", detail: cause instanceof Error ? cause.message : String(cause) };
  }
  // Nothing here reads the result, and on the streamable transport the body may
  // be an open event stream. Dropped rather than parsed, so the socket closes
  // with the probe.
  await response.body?.cancel().catch(() => undefined);

  // 403 alongside 401 because a gateway may spell "this bearer is not good for
  // this resource" either way, and both end at the same place: hop 1 again.
  if (response.status === 401 || response.status === 403) return { outcome: "rejected", status: response.status };
  if (response.ok) return { outcome: "accepted", status: response.status };
  return { outcome: "unreachable", detail: `the gateway answered ${response.status}` };
}

/**
 * Discover and register, once per process per (gateway, redirect URI).
 *
 * `token_endpoint_auth_method: "none"` — a public client, because this
 * registration is minted at runtime and there is nowhere durable to keep a
 * secret for it. PKCE is what protects the code, and that is on every leg.
 */
export function gatewayClient(
  url: string,
  redirectUri: string,
  pinnedClientId?: string,
): Promise<GatewayClient> {
  const key = `${url}|${redirectUri}|${pinnedClientId ?? ""}`;
  const held = registrations.get(key);
  if (held) return held;

  const minted = (async () => {
    const metadata = await discoverGateway(url);
    if (pinnedClientId) return { metadata, clientId: pinnedClientId };

    const response = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Contextual Governance — apps/web",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: GATEWAY_SCOPE,
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`dynamic client registration -> ${response.status} ${body}`);
    const registered = JSON.parse(body) as { client_id?: string; client_secret?: string };
    if (!registered.client_id) throw new Error("the registration response carried no client_id");
    const client: GatewayClient = { metadata, clientId: registered.client_id };
    if (registered.client_secret) client.clientSecret = registered.client_secret;
    return client;
  })();

  // Cache the promise, not the result, so two sign-ins racing at boot share one
  // registration — two would mean two consent screens for the same persona.
  // A failure is dropped so the next attempt rediscovers rather than replaying
  // the error forever.
  registrations.set(key, minted);
  minted.catch(() => registrations.delete(key));
  return minted;
}

/** Only for tests, which point this at a stand-in and must not inherit the last one's registration. */
export function forgetGatewayClients() {
  registrations.clear();
}

export function gatewayAuthorizeUrl(options: {
  client: GatewayClient;
  redirectUri: string;
  resource: string;
  state: string;
  challenge: string;
}): string {
  return `${options.client.metadata.authorization_endpoint}?${new URLSearchParams({
    response_type: "code",
    client_id: options.client.clientId,
    redirect_uri: options.redirectUri,
    scope: GATEWAY_SCOPE,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    resource: options.resource,
  })}`;
}

export interface GatewayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export type GatewayTokenResult =
  /** `status` on this branch too, so a caller can log what a *success* answered without the body. */
  | { ok: true; status: number; token: GatewayTokenResponse }
  | { ok: false; status: number; body: string };

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<GatewayTokenResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, body };
  try {
    return { ok: true, status: response.status, token: JSON.parse(body) as GatewayTokenResponse };
  } catch {
    return { ok: false, status: response.status, body };
  }
}

export function exchangeGatewayCode(options: {
  client: GatewayClient;
  redirectUri: string;
  resource: string;
  code: string;
  codeVerifier: string;
}): Promise<GatewayTokenResult> {
  return tokenRequest(options.client.metadata.token_endpoint, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.client.clientId,
    code_verifier: options.codeVerifier,
    resource: options.resource,
  });
}

/**
 * Refresh, server-side.
 *
 * The browser never sees either token and never drives this: the refresh is a
 * server-to-server call made on the next request that needs a live bearer, and
 * the result is resealed into the same cookie.
 */
export function refreshGatewayToken(options: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string;
}): Promise<GatewayTokenResult> {
  return tokenRequest(options.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    resource: options.resource,
  });
}

/**
 * The usable `access_token` on a token response, or `null` if the body is not
 * one.
 *
 * **Total, and deliberately typed `unknown`.** `tokenRequest` hands back
 * `JSON.parse(body)` under the `GatewayTokenResponse` type, and that type is a
 * claim about a remote server's output rather than a fact about it. Round 2 of
 * #98's review found the gap: an authorization server that answers `200` with
 * the body `null` parses to `null`, which satisfies the type and throws on the
 * first property read — `TypeError: null is not an object (evaluating
 * 'refreshed.token.access_token')` — so the one path this whole issue exists to
 * build, "no usable token, go and re-authorize", became an unshaped 500.
 *
 * So the read is done here, once, against `unknown`, and every shape that is
 * not an object carrying a non-empty string comes back `null`: `null` itself, a
 * JSON scalar, an array, a missing field, a field that is not a string, an
 * empty one. The callers branch on `null` and cannot throw on the way.
 */
export function accessTokenOf(token: unknown): string | null {
  if (typeof token !== "object" || token === null) return null;
  const value = (token as { access_token?: unknown }).access_token;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * When a token issued now expires.
 *
 * A missing `expires_in` is treated as **one hour**, not as "never": a token
 * assumed immortal is one this service keeps presenting after Arcade stopped
 * accepting it, and the symptom is a tool call that fails with nothing on the
 * panel — hop 1 is upstream of every hook.
 */
export function expiryOf(token: GatewayTokenResponse, now = Date.now()): number {
  return now + (token.expires_in ?? 3600) * 1000;
}

/** Refresh this far before expiry, so a token does not die mid-call. */
export const REFRESH_SKEW_MS = 60_000;

export function isExpiring(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - REFRESH_SKEW_MS <= now;
}

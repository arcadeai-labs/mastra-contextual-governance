/**
 * What the identity suite runs against.
 *
 * Three processes, and the line between "real" and "stand-in" is drawn exactly
 * once, at the network edge:
 *
 * - **`apps/idp` is real.** Booted as a subprocess the way Render boots it,
 *   with its own client C (`IDP_OAUTH_CLIENTS=web`) whose redirect URI is this
 *   harness's own callback. Every sign-in in this suite is a real
 *   authorization-code + PKCE flow against Better Auth, with a real password
 *   typed into a real login form. `prompt=login` is measured against it rather
 *   than assumed — the issue asked for that specifically.
 * - **`apps/web`'s handlers are real, behind a real server.** `Bun.serve` on
 *   `:0`, routing to the same `lib/identity/handlers.ts` functions `app/api/**`
 *   calls. Nothing is mocked: the suite drives them with a cookie jar over HTTP
 *   and asserts on the `Set-Cookie` headers a browser would actually get.
 * - **Arcade Cloud is a stand-in, and only Arcade Cloud.** It speaks the MCP
 *   authorization discovery Arcade speaks (401 → protected-resource metadata →
 *   authorization-server metadata → dynamic registration → authorize → token),
 *   checks PKCE for real, and serves `confirm_user` and a `next_uri` whose code
 *   is single-use, the way #100 measured Better Auth's to be. It is a
 *   stand-in because the real one needs a project API key and a human's
 *   dashboard field; the shape it imitates is the one spike #04 and #75
 *   measured off the live service, hop for hop.
 *
 * Every port is `:0` and read back. This worktree owns a block of ten and the
 * reviewer's owns a different block, so nothing here may pick a number.
 */
import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readWebConfig, type WebConfig } from "../lib/config.ts";
import {
  gatewayCallback,
  gatewayStart,
  signin,
  signinCallback,
  signout,
  verify,
} from "../lib/identity/handlers.ts";
import { forgetGatewayClients } from "../lib/identity/gateway.ts";
import { nonce, pkce } from "../lib/identity/oidc.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The four demo people, as `apps/idp/src/fixtures/people.json` seeds them. */
export const PEOPLE = {
  dana: { email: "alice@bank.example", password: "dana-demo-2026" },
  sam: { email: "bob@bank.example", password: "sam-demo-2026" },
  riley: { email: "charlie@bank.example", password: "riley-demo-2026" },
  morgan: { email: "michael@bank.example", password: "morgan-demo-2026" },
} as const;

export type PersonaKey = keyof typeof PEOPLE;

export const SESSION_SECRET = "identity-suite-session-secret-0123456789";
export const ARCADE_API_KEY = "identity-suite-arcade-key";
export const GATEWAY_ID = "cg-demo-us";

/** A port the OS says is free. Never a guess — `tools/loan/tests/conftest.py::_free_port` does the same. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  return port;
}

// ---------------------------------------------------------------------------
// A browser, minus the browser
// ---------------------------------------------------------------------------

/**
 * A cookie jar and manual redirects.
 *
 * Flat across hosts on purpose: real browsers key cookies by host and ignore
 * the port, so `localhost:<web>` and `localhost:<idp>` genuinely do share a jar
 * on a developer's machine. Imitating that is what makes "the IdP's session
 * cookie is still here when the second sign-in starts" a real condition rather
 * than one the harness arranged away — which is the whole of the `prompt=login`
 * measurement.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** Every response, in order, as `status METHOD url` — what a redirect chain looked like. */
  readonly visited: string[] = [];
  /** Hosts that rendered a form. Which server asked for the password. */
  readonly pageHosts: string[] = [];

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.visited.push(`${response.status} ${init.method ?? "GET"} ${url.split("?")[0]}`);
    this.store(response);
    return response;
  }

  store(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * Walk a redirect chain, filling in whatever HTML form appears, until the
   * chain lands on a page with no form or on a path this caller is waiting for.
   *
   * `stopAt` is a substring rather than a full URL because the interesting stop
   * is usually a path on a host whose port is assigned at boot.
   */
  async follow(
    from: string,
    fill: (fields: Record<string, string>, html: string) => Record<string, string>,
    options: { stopAt?: string; limit?: number } = {},
  ): Promise<{ url: string; response: Response; html: string }> {
    let url = from;
    for (let hop = 0; hop < (options.limit ?? 25); hop += 1) {
      const response = await this.fetch(url, { headers: { accept: "text/html" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`${response.status} with no Location at ${url}`);
        url = new URL(location, url).toString();
        if (options.stopAt && url.includes(options.stopAt)) {
          return { url, response, html: "" };
        }
        continue;
      }

      const html = await response.text();
      const form = parseForm(html);
      if (!form) return { url, response, html };

      this.pageHosts.push(new URL(url).host);
      const action = new URL(form.action || url, url).toString();
      const post = await this.fetch(action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
        body: new URLSearchParams(fill(form.fields, html)).toString(),
      });
      const location = post.headers.get("location");
      if (!location) return { url: action, response: post, html: await post.text() };
      url = new URL(location, action).toString();
      if (options.stopAt && url.includes(options.stopAt)) return { url, response: post, html: "" };
    }
    throw new Error(`the chain from ${from} did not terminate`);
  }
}

interface ParsedForm {
  action: string;
  fields: Record<string, string>;
}

/**
 * HTML entities, back to characters.
 *
 * A browser does this and a regex does not, and the difference is not cosmetic:
 * `apps/idp` puts the plugin's **signed** OAuth query in a hidden field, so
 * every `&` in it arrives as `&amp;`. Posting that back splits one parameter
 * into two, the signature over the canonicalised parameters no longer matches,
 * and Better Auth answers `invalid_signature` — which the login page renders as
 * "This sign-in request has expired". Cost an hour on this slice; the login
 * page is telling the truth about the symptom and nothing about the cause.
 */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/** The pages here are server-rendered HTML with one form; a regex parse is enough. */
export function parseForm(html: string): ParsedForm | null {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(form[0])?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of form[1]!.matchAll(/<(?:input|button)\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1];
    if (!name) continue;
    fields[name] = unescapeHtml(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? "");
  }
  return { action, fields };
}

// ---------------------------------------------------------------------------
// The Arcade stand-in
// ---------------------------------------------------------------------------

export interface ArcadeStandIn {
  url: string;
  /** Every dynamic registration, in order. One per MCP client id. */
  registrations: Array<{ client_id: string; redirect_uris: string[] }>;
  /** Which client ids have already been consented to, per persona-less browser session. */
  consents: string[];
  /** Every `confirm_user` call, as Arcade received it. The identity assertion under test. */
  confirmations: Array<{ flow_id: string; user_id: string; authorized: boolean }>;
  /** `next_uri`s that were actually fetched. Measured on #75: the grant needs this. */
  nextUriFetches: string[];
  /**
   * What `next_uri` answers with.
   *
   * `continuation` is the live service's shape as #100 reads it: landing there
   * runs Arcade's provider exchange and 302s onward to a page that is *not*
   * `next_uri`. `terminal` is a 200 with no `Location`, which is the other end
   * of the range and the case where the verifier has nowhere left to send the
   * browser. Both have to leave the code redeemed exactly once.
   */
  nextUriAnswer: "continuation" | "terminal";
  /**
   * Every `next_uri` hit, as `flow_id` — including the replays #100 is about.
   *
   * Separate from `nextUriFetches`, which is deduplicated per flow, because the
   * bug is a *second* hit on a flow that already had one, and a list that folds
   * them together cannot see it.
   */
  nextUriHits: string[];
  /**
   * Every `Location` this stand-in answered a `next_uri` fetch with, in order.
   *
   * #118: the browser is never sent to any of them. A test asserting that has
   * to know what Arcade offered, and reconstructing it from the URL template
   * would be the test checking its own copy of the stand-in rather than the
   * stand-in — the same reason `nextUriOf` exists.
   */
  continuations: string[];
  /**
   * The `next_uri` this stand-in handed back for a flow.
   *
   * A test asserting "the browser was not sent to `next_uri`" has to know what
   * `next_uri` was, and reconstructing it from the URL template would be the
   * test asserting against its own copy of the stand-in rather than against the
   * stand-in.
   */
  nextUriOf(flowId: string): string | undefined;
  /** Bearers presented to the MCP endpoint, in order. */
  bearers: string[];
  /** Force the next `confirm_user` to fail with this status and body. */
  failConfirm: { status: number; body: string } | null;
  /** Answer `confirm_user` without a `next_uri`. */
  omitNextUri: boolean;
  /** Seconds put on every access token this stand-in issues. */
  tokenLifetimeSeconds: number;
  refreshes: number;

  // -- #113: a gateway that expires tokens and drops connections ------------
  /** Every access token this stand-in has issued, in order. */
  issued: string[];
  /**
   * Stop accepting every access token issued so far.
   *
   * The MCP endpoint then answers those bearers `401 invalid_token`, which is
   * what a real gateway does to an expired one — **and it says nothing to the
   * sealed cookie**, whose `expires_at` goes on claiming the token is live.
   * That gap is the whole of #113: expiry as the session records it and expiry
   * as the gateway enforces it are two different facts, and only one of them
   * is a clock this service owns.
   */
  expireIssuedTokens(): void;
  /**
   * While false, every access token this stand-in issues is dead the moment it
   * exists — the token endpoint hands one back and the MCP endpoint refuses it.
   *
   * The gateway nothing can rescue. It is what a retry has to terminate
   * against: a service that kept refreshing here would spend a person's
   * credentials in a loop against a server that has already said no.
   */
  acceptsIssuedTokens: boolean;
  /**
   * While true, `tools/list` comes back empty — the gateway takes the bearer
   * and lists nothing, which is a broken control plane rather than a broken
   * credential (#15).
   */
  listsNothing: boolean;
  /**
   * While true, the MCP endpoint accepts the request and then drops the
   * connection mid-body.
   *
   * The other half of #113's measurement: a turn that dies on the transport
   * rather than on the credential, which is what *"Could not connect to server
   * with any available HTTP transport"* looks like from this side.
   */
  dropConnections: boolean;
  /**
   * Rotate the refresh token on every refresh, invalidating the one presented.
   *
   * Off by default, because the stand-in's original behaviour was to keep one
   * refresh token alive forever and the identity suite is written against that.
   * On, it is the stricter authorization server: a refresh whose result is not
   * resealed into the cookie costs the browser its session. That is the thing
   * "re-seal the cookie" has to be tested against rather than asserted.
   */
  rotateRefreshTokens: boolean;
  /** Every `grant_type` the token endpoint was asked for, in order. */
  grants: string[];
  /**
   * Test-only view of a hop-2 grant. It intentionally carries identities, but
   * never an authorization code, access token, refresh token or URL value.
   * This is the observation that joins the verifier's confirmation to the
   * real IdP token/userinfo exchange below.
   */
  grantObservations: Array<{
    flow_id: string;
    confirmed_user_id: string;
    effective_user_id: string | null;
    finalized: boolean;
  }>;
  /** The later Loan_SearchLoans auth decision, with no credential material. */
  loanSearchCalls: Array<{
    user_id: string;
    grant_flow_id: string | null;
    outcome: "grant" | "fresh_challenge";
  }>;
  /** Configure the real local IdP route used by the provider leg below. */
  configureIdpProvider(options: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): void;
  /** The local provider's public client id; the secret never leaves the stand-in. */
  providerClientIdForTest(): string;
  /** Capture one provider code inside the harness; the code never leaves it. */
  bindProviderCode(flowId: string, authorizationState: string, codeVerifier: string): void;
  /** A gateway bearer whose actor is the supplied test persona. */
  issueToolToken(email: string): string;
  /** Reset only the stand-in's provider grants between focused test cases. */
  clearToolGrantsForTest(): void;
  stop(): void;
}

/**
 * Arcade Cloud, as far as this slice can see it.
 *
 * Faithful where it matters and no further: the discovery chain is the one
 * measured on #04, PKCE is verified rather than accepted, `confirm_user`
 * demands the project API key, and the grant is only recorded once something
 * fetches `next_uri`. The focused `Loan_SearchLoans` probe below is the one
 * tool path modeled here; all other tool execution remains absent because this
 * harness does not attempt to model the whole gateway.
 */
export function startArcadeStandIn(): ArcadeStandIn {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const refreshTokens = new Map<string, string>();
  const flows = new Map<
    string,
    {
      user_id: string;
      next_uri: string;
      authorized: boolean;
      redeemed: boolean;
      provider?: { code: string; codeVerifier: string };
      effective_user_id?: string | null;
    }
  >();
  const providerCodes = new Map<string, string>();
  const pendingProvider = new Map<string, { code: string; codeVerifier: string }>();
  const actors = new Map<string, string>();
  const grantsByUser = new Map<string, string>();
  let idpProvider: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null = null;

  /** Access tokens the gateway still accepts. Expiry is removal from this set. */
  const liveAccess = new Set<string>();

  const state: ArcadeStandIn = {
    url: "",
    registrations: [],
    consents: [],
    confirmations: [],
    nextUriFetches: [],
    nextUriAnswer: "continuation",
    nextUriHits: [],
    continuations: [],
    nextUriOf: (flowId) => flows.get(flowId)?.next_uri,
    bearers: [],
    failConfirm: null,
    omitNextUri: false,
    tokenLifetimeSeconds: 3600,
    refreshes: 0,
    issued: [],
    expireIssuedTokens: () => liveAccess.clear(),
    acceptsIssuedTokens: true,
    listsNothing: false,
    dropConnections: false,
    rotateRefreshTokens: false,
    grants: [],
    grantObservations: [],
    loanSearchCalls: [],
    configureIdpProvider(options) {
      idpProvider = options;
    },
    providerClientIdForTest() {
      if (!idpProvider) throw new Error("the local IdP provider is not configured");
      return idpProvider.clientId;
    },
    bindProviderCode(flowId, authorizationState, codeVerifier) {
      const code = providerCodes.get(authorizationState);
      if (!code) throw new Error(`no local IdP authorization code captured for state ${authorizationState}`);
      const flow = flows.get(flowId);
      if (flow) flow.provider = { code, codeVerifier };
      else pendingProvider.set(flowId, { code, codeVerifier });
    },
    issueToolToken(email) {
      const token = `gw-tool-${crypto.randomUUID()}`;
      actors.set(token, email.trim().toLowerCase());
      liveAccess.add(token);
      return token;
    },
    clearToolGrantsForTest() {
      grantsByUser.clear();
    },
    stop: () => server.stop(true),
  };

  const issue = (clientId: string) => {
    const access = `gw-access-${crypto.randomUUID()}`;
    const refresh = `gw-refresh-${crypto.randomUUID()}`;
    refreshTokens.set(refresh, clientId);
    if (state.acceptsIssuedTokens) liveAccess.add(access);
    state.issued.push(access);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: state.tokenLifetimeSeconds,
    };
  };

  /**
   * A connection the gateway accepts and then closes without answering.
   *
   * A real drop rather than an error status: the body never produces a byte and
   * the per-request idle timeout closes the socket underneath it, so the client
   * sees the connection go away mid-request — *"The socket connection was
   * closed unexpectedly"* — instead of reading a status code. That is the
   * difference between "the gateway said no" and "there was nothing to say no",
   * and `probeGatewayToken` is built on exactly that distinction.
   */
  const dropConnection = (request: Request, listener: { timeout(request: Request, seconds: number): void }) => {
    listener.timeout(request, 1);
    return new Response(new ReadableStream({ start() { /* never writes, never closes */ } }));
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request, listener) {
      const url = new URL(request.url);
      const { pathname } = url;

      // The gateway's MCP endpoint. Unauthenticated: a 401 that names where the
      // protected-resource metadata lives, which is how discovery starts.
      if (pathname === `/mcp/${GATEWAY_ID}`) {
        // The transport, dead. Answered before the method check so the SDK's
        // SSE fallback dies the same way its streamable POST did — which is
        // what makes the client report that it could reach the server by no
        // available HTTP transport rather than that the credential was refused.
        if (state.dropConnections) return dropConnection(request, listener);
        if (request.method !== "POST") return new Response(null, { status: 405 });

        const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
        const unauthorized = () =>
          new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 401,
            headers: {
              "www-authenticate":
                `Bearer resource_metadata="${state.url}/.well-known/oauth-protected-resource/mcp/${GATEWAY_ID}"`,
              "content-type": "application/json",
            },
          });
        if (!bearer) return unauthorized();
        state.bearers.push(bearer);
        // An access token the gateway no longer accepts is refused here and
        // nowhere else. Nothing tells the holder in advance.
        if (!liveAccess.has(bearer)) return unauthorized();

        const body = (await request.json()) as { id?: number; method?: string; params?: { name?: string } };
        if (body.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
        if (body.method === "tools/list") {
          if (state.listsNothing) return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "Loan_GetLoan",
                  description: "Read one loan file.",
                  inputSchema: {
                    type: "object",
                    properties: { loan_id: { type: "string" } },
                    required: ["loan_id"],
                    additionalProperties: false,
                  },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          const toolName = body.params?.name;
          if (toolName === "Loan_SearchLoans") {
            const actor = actors.get(bearer) ?? "";
            const grantFlowId = grantsByUser.get(actor) ?? null;
            state.loanSearchCalls.push({
              user_id: actor,
              grant_flow_id: grantFlowId,
              outcome: grantFlowId === null ? "fresh_challenge" : "grant",
            });
            if (grantFlowId === null) {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        authorization_url: `${state.url}/oauth/authorize?tool=Loan_SearchLoans`,
                        llm_instructions: "Authorize the tool and try again.",
                      }),
                    },
                  ],
                },
              });
            }
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ count: 1, loans: [{ loan_id: "LN-2291" }] }) }],
              },
            });
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `{"loan_id":"LN-2291","status":"pending"}` }] },
          });
        }
        // `capabilities` and `serverInfo` are not decoration: the MCP client
        // validates the `initialize` result and an incomplete one makes it fall
        // back to SSE and then give up, which reads as a transport failure
        // rather than as the malformed answer it is.
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "arcade-stand-in", version: "0.1.0" },
          },
        });
      }

      if (pathname === `/.well-known/oauth-protected-resource/mcp/${GATEWAY_ID}`) {
        return Response.json({ resource: `${state.url}/mcp/${GATEWAY_ID}`, authorization_servers: [`${state.url}/`] });
      }

      if (pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: `${state.url}/`,
          authorization_endpoint: `${state.url}/oauth/authorize`,
          token_endpoint: `${state.url}/oauth/token`,
          registration_endpoint: `${state.url}/oauth/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (pathname === "/oauth/register" && request.method === "POST") {
        const body = (await request.json()) as { redirect_uris?: string[] };
        const clientId = `mcp-client-${state.registrations.length + 1}`;
        state.registrations.push({ client_id: clientId, redirect_uris: body.redirect_uris ?? [] });
        return Response.json({ client_id: clientId, redirect_uris: body.redirect_uris }, { status: 201 });
      }

      // Arcade's own gateway consent screen — once per persona per MCP client
      // id. Rendered as a form so the suite has to press it, the way a human
      // does, rather than having the flow complete invisibly.
      if (pathname === "/oauth/authorize" && request.method === "GET") {
        const query = url.search;
        return new Response(
          `<!doctype html><title>Arcade — allow access</title><form method="post" action="/oauth/authorize${query}">` +
            `<button name="decision" value="allow">Allow</button></form>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (pathname === "/oauth/authorize" && request.method === "POST") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        state.consents.push(clientId);
        const code = `gw-code-${crypto.randomUUID()}`;
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          clientId,
          redirectUri,
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return new Response(null, { status: 303, headers: { location: back.toString() } });
      }

      if (pathname === "/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        state.grants.push(form.get("grant_type") ?? "");
        if (form.get("grant_type") === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          const clientId = refreshTokens.get(presented);
          if (!clientId || clientId !== form.get("client_id")) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          state.refreshes += 1;
          // A rotating server hands back a new refresh token and stops taking
          // the old one, so a caller that does not store what came back has
          // spent the browser's session rather than extended it.
          if (state.rotateRefreshTokens) refreshTokens.delete(presented);
          return Response.json(issue(clientId));
        }

        const record = codes.get(form.get("code") ?? "");
        if (!record) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(form.get("code")!);
        // PKCE, checked rather than accepted: a stand-in that ignores the
        // verifier would let a broken challenge pass every test here.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(form.get("code_verifier") ?? ""),
        );
        if (Buffer.from(digest).toString("base64url") !== record.challenge) {
          return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
        }
        if (form.get("client_id") !== record.clientId) {
          return Response.json({ error: "invalid_client" }, { status: 400 });
        }
        return Response.json(issue(record.clientId));
      }

      // Hop 2. The project API key is demanded, because the real one does.
      if (pathname === "/api/v1/oauth/confirm_user" && request.method === "POST") {
        if (request.headers.get("authorization") !== `Bearer ${ARCADE_API_KEY}`) {
          return new Response(JSON.stringify({ code: 401, msg: "Unauthorized" }), { status: 401 });
        }
        if (state.failConfirm) {
          const { status, body } = state.failConfirm;
          return new Response(body, { status });
        }
        const body = (await request.json()) as { flow_id?: string; user_id?: string };
        if (!body.flow_id || !body.user_id) {
          return new Response(JSON.stringify({ code: 400, msg: "Bad request" }), { status: 400 });
        }
        const nextUri = `${state.url}/api/v1/oauth/callback_success?flow_id=${encodeURIComponent(body.flow_id)}`;
        const provider = pendingProvider.get(body.flow_id);
        flows.set(body.flow_id, {
          user_id: body.user_id,
          next_uri: nextUri,
          authorized: false,
          redeemed: false,
          ...(provider ? { provider } : {}),
        });
        pendingProvider.delete(body.flow_id);
        state.confirmations.push({ flow_id: body.flow_id, user_id: body.user_id, authorized: false });
        return Response.json({
          auth_id: `auth_${body.flow_id}`,
          ...(state.omitNextUri ? {} : { next_uri: nextUri }),
        });
      }

      // Measured on #75: the grant is not finalised until something lands here.
      //
      // And measured on #100: the code behind it is single-use. This stand-in
      // redeems it the first time and refuses every hit after that, the way
      // Better Auth's token endpoint does — `invalid_grant "invalid code"`, and
      // the grant already made is revoked rather than left alone. Without the
      // refusal a replay is invisible here and a test asserting "one hit" is
      // asserting nothing about what a second one would cost.
      if (pathname === "/api/v1/oauth/callback_success") {
        const flowId = url.searchParams.get("flow_id") ?? "";
        state.nextUriHits.push(flowId);
        const flow = flows.get(flowId);
        if (!flow || flow.redeemed) {
          if (flow) {
            // `revokeTokensIssuedForAuthorizationCode`, in one line.
            flow.authorized = false;
            for (const confirmation of state.confirmations) {
              if (confirmation.flow_id === flowId) confirmation.authorized = false;
            }
          }
          return Response.json(
            { error: "invalid_grant", error_description: "invalid code" },
            { status: 400 },
          );
        }

        flow.redeemed = true;
        flow.authorized = true;
        state.nextUriFetches.push(flowId);

        // In the live path Arcade exchanges the provider code after the
        // verifier confirms the user. When a test binds a real local IdP code
        // to this flow, perform that same server-to-server exchange here and
        // derive the effective identity from /userinfo. The ordinary identity
        // tests do not bind a code, so their narrower stand-in behavior stays
        // unchanged.
        if (flow.provider && idpProvider) {
          const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
          const basic = Buffer.from(
            `${formEncode(idpProvider.clientId)}:${formEncode(idpProvider.clientSecret)}`,
          ).toString("base64");
          const tokenResponse = await fetch(`${idpProvider.issuer}/oauth2/token`, {
            method: "POST",
            headers: {
              authorization: `Basic ${basic}`,
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "identity-harness/1.0",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: flow.provider.code,
              redirect_uri: idpProvider.redirectUri,
              client_id: idpProvider.clientId,
              code_verifier: flow.provider.codeVerifier,
            }).toString(),
          });
          const token = (await tokenResponse.json().catch(() => null)) as
            | { access_token?: string }
            | null;
          let effective: string | null = null;
          if (tokenResponse.ok && typeof token?.access_token === "string") {
            const userinfo = await fetch(`${idpProvider.issuer}/oauth2/userinfo`, {
              headers: { authorization: `Bearer ${token.access_token}` },
            });
            const identity = (await userinfo.json().catch(() => null)) as { email?: string } | null;
            if (userinfo.ok && typeof identity?.email === "string") effective = identity.email.trim().toLowerCase();
          }
          flow.effective_user_id = effective;
          flow.authorized = effective === flow.user_id.trim().toLowerCase();
          state.grantObservations.push({
            flow_id: flowId,
            confirmed_user_id: flow.user_id,
            effective_user_id: effective,
            finalized: flow.authorized,
          });
          if (flow.authorized) grantsByUser.set(flow.user_id.trim().toLowerCase(), flowId);
        }

        for (const confirmation of state.confirmations) {
          if (confirmation.flow_id === flowId) confirmation.authorized = flow.authorized;
        }
        if (state.nextUriAnswer === "terminal") {
          return new Response("authorized", { headers: { "content-type": "text/plain" } });
        }
        // The continuation: somewhere that is not `next_uri`, carrying the
        // authorization leg's query string — which is why the verifier's log
        // line prints parameter names and not values.
        const continuation =
          `${state.url}/authorized?flow_id=${encodeURIComponent(flowId)}&code=s3cr3t-should-not-be-logged`;
        state.continuations.push(continuation);
        return new Response(null, { status: 302, headers: { location: continuation } });
      }

      // Where Arcade's continuation lands. Renders no form, so a browser
      // walking the chain stops here.
      if (pathname === "/idp/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code && state) providerCodes.set(state, code);
        return Response.json({ received: Boolean(code && state) });
      }

      if (pathname === "/authorized") {
        return new Response("<!doctype html><p>Arcade: authorized", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  state.url = `http://localhost:${server.port}`;
  return state;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface IdentityHarness {
  webUrl: string;
  idpUrl: string;
  arcade: ArcadeStandIn;
  config: WebConfig;
  /** Everything `apps/idp` printed, for assertions about what it was asked. */
  idpLog(): Promise<string>;
  stop(): Promise<void>;
}

export async function startIdentityHarness(): Promise<IdentityHarness> {
  // Registration is a module-level cache keyed by gateway URL, and every run of
  // this harness stands a new one up on a new port. Clearing it is what keeps
  // one suite's registration out of the next suite's flow.
  forgetGatewayClients();

  const arcade = startArcadeStandIn();

  // The web server needs the IdP's issuer and the IdP needs the web server's
  // callback URL, so one of them has to be known before the other is up. The
  // port is taken from the OS first and the server bound to it after the IdP is
  // configured — the same trick, and the same reason, as binding `:0`.
  const webPort = freePort();
  const webUrl = `http://localhost:${webPort}`;

  const idpPort = freePort();
  const idpUrl = `http://localhost:${idpPort}`;
  const dbPath = join(tmpdir(), `cg-web-identity-${crypto.randomUUID()}`, "idp.db");
  const logPath = join(dirname(dbPath), "idp.log");
  mkdirSync(dirname(dbPath), { recursive: true });

  // A developer's own PERSONA_* and IDP_* values are deliberately not passed
  // through: these tests are about the fixture.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  const idpEnv: Record<string, string> = {
    ...inherited,
    PORT: String(idpPort),
    IDP_DB_PATH: dbPath,
    IDP_PUBLIC_URL: idpUrl,
    BETTER_AUTH_SECRET: "identity-suite-idp-secret".padEnd(48, "x"),
    // Client A stays the Arcade registration; client C is `apps/web`'s own —
    // DESIGN.md's "one OAuth client per relying party", settled on #75/#79.
    IDP_OAUTH_CLIENTS: "web",
    IDP_OAUTH_REDIRECT_URIS_WEB: `${webUrl}/api/auth/callback,${arcade.url}/idp/callback`,
    NODE_ENV: "test",
  };

  const idp = spawn(["bun", join(REPO_ROOT, "apps", "idp", "src", "index.ts")], {
    env: idpEnv,
    stdout: Bun.file(logPath),
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${idpUrl}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      idp.kill();
      throw new Error(`apps/idp did not come up:\n${await new Response(idp.stderr as ReadableStream).text()}`);
    }
    await Bun.sleep(50);
  }

  // The secret is stored hashed and cannot be printed twice (#70), so the
  // operational path a human takes on a fresh deploy is the one taken here:
  // rotate once, under the same client id, to obtain a readable one.
  const rotate = spawn(
    ["bun", join(REPO_ROOT, "apps", "idp", "scripts", "oauth-client.ts"), "--json", "--client", "web", "--rotate"],
    { env: idpEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [rotateOut, rotateErr, rotateCode] = await Promise.all([
    new Response(rotate.stdout).text(),
    new Response(rotate.stderr).text(),
    rotate.exited,
  ]);
  if (rotateCode !== 0) throw new Error(`oauth-client --client web --rotate exited ${rotateCode}: ${rotateErr}`);
  const credentials = JSON.parse(rotateOut) as {
    clients: Array<{ key: string; client_id: string; client_secret: string | null }>;
  };
  const clientC = credentials.clients.find((each) => each.key === "web");
  if (!clientC?.client_secret) throw new Error(`no readable secret for client C in:\n${rotateOut}`);

  // The same real local IdP client is used as the provider leg in the focused
  // hop-2 regression. The callback is a route on the Arcade stand-in, so the
  // browser captures the authorization code there and the stand-in exchanges
  // it through the actual `/oauth2/token` and `/oauth2/userinfo` routes during
  // next_uri finalization. No code or token is exposed by the harness API.
  arcade.configureIdpProvider({
    issuer: idpUrl,
    clientId: clientC.client_id,
    clientSecret: clientC.client_secret,
    redirectUri: `${arcade.url}/idp/callback`,
  });

  const config = readWebConfig({
    ARCADE_API_URL: arcade.url,
    ARCADE_API_KEY: ARCADE_API_KEY,
    ARCADE_CLOUD_URL: arcade.url,
    ARCADE_GATEWAY_ID: GATEWAY_ID,
    IDP_ISSUER: idpUrl,
    IDP_CLIENT_ID: clientC.client_id,
    IDP_CLIENT_SECRET: clientC.client_secret,
    SESSION_SECRET,
    PUBLIC_URL: webUrl,
    // Not used by any route this suite drives — nothing here runs the agent.
    // Present because `deploymentReadiness` counts the agent as the fourth
    // capability since #14, and the assertion below is about what a *fully*
    // configured deployment reports. Leaving it out would make this harness
    // describe a deployment whose chat page cannot run.
    ANTHROPIC_API_KEY: "anthropic-key-for-identity-tests",
  });

  const web = Bun.serve({
    port: webPort,
    idleTimeout: 30,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/signin") return signin(request, config);
      if (pathname === "/api/auth/callback") return signinCallback(request, config);
      if (pathname === "/api/auth/signout" && request.method === "POST") return signout(request, config);
      if (pathname === "/api/arcade/start") return gatewayStart(request, config);
      if (pathname === "/api/arcade/callback") return gatewayCallback(request, config);
      if (pathname === "/api/arcade/verify") return verify(request, config);
      // Stands in for the app shell: the landing page a completed sign-in
      // reaches. It renders no form, so the browser stops here.
      if (pathname === "/") return new Response("<!doctype html><p>home", { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });

  return {
    webUrl,
    idpUrl,
    arcade,
    config,
    idpLog: () => Bun.file(logPath).text(),
    async stop() {
      web.stop(true);
      arcade.stop();
      idp.kill();
      await idp.exited;
      rmSync(dirname(dbPath), { recursive: true, force: true });
    },
  };
}

/**
 * Mint a provider authorization code in the real local IdP, retaining it only
 * inside the Arcade stand-in until a flow's `next_uri` is finalized.
 */
export async function prepareProviderCode(
  browser: Browser,
  harness: IdentityHarness,
  persona: PersonaKey,
): Promise<{ authorizationState: string; codeVerifier: string }> {
  const { verifier, challenge } = await pkce();
  const authorizationState = nonce();
  const authorize = new URL(`${harness.idpUrl}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: harness.arcade.providerClientIdForTest(),
    redirect_uri: `${harness.arcade.url}/idp/callback`,
    scope: "openid email",
    state: authorizationState,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  await browser.follow(
    authorize.toString(),
    (fields) => ({
      ...fields,
      ...(fields.email !== undefined
        ? { email: PEOPLE[persona].email, password: PEOPLE[persona].password }
        : {}),
      ...(fields.decision !== undefined ? { decision: "allow" } : {}),
    }),
  );
  return { authorizationState, codeVerifier: verifier };
}

/**
 * Sign a persona in from scratch: press their button, land on the IdP, type the
 * password, accept consent if it is offered, and come back.
 *
 * Returns where the chain ended, so a caller can assert it reached hop 1 rather
 * than an error page.
 */
export async function signInAs(
  browser: Browser,
  harness: IdentityHarness,
  persona: PersonaKey,
  options: { from?: string; stopAt?: string } = {},
): Promise<{ url: string; response: Response; html: string }> {
  const person = PEOPLE[persona];
  return browser.follow(
    options.from ?? `${harness.webUrl}/api/auth/signin?persona=${persona}`,
    (fields) => {
      const filled: Record<string, string> = { ...fields };
      // The login form asks for an identifier and a password; the consent form
      // does not. Filling by shape rather than by page means this helper does
      // not have to know how many pages the IdP decided to show.
      if ("email" in fields) {
        filled.email = person.email;
        filled.password = person.password;
      }
      if ("decision" in fields) filled.decision = "allow";
      return filled;
    },
    { ...(options.stopAt !== undefined && { stopAt: options.stopAt }) },
  );
}

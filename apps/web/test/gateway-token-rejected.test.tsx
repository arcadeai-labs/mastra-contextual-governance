/**
 * #94 — a gateway that refuses the bearer, told apart from a gateway that has
 * none of our tools.
 *
 * The failure this file exists to keep out: Alice, signed in, asks for the $95K
 * loan on the live Render URL and reads *"The gateway advertised 0 tools and
 * none of them belong to \"Loan\" or \"Approvals\" … Check ARCADE_LOAN_TOOLKIT
 * and ARCADE_APPROVALS_TOOLKIT"*. Both variables were correct. Her gateway
 * token was not, and one click on `/api/arcade/start` was the whole fix.
 *
 * The cause is measured in the first `describe` below and it is not ours:
 * `@mastra/mcp` 1.17.3 does not throw when a server refuses the bearer, and
 * neither does 2.0.0 (#187).
 * `listToolsets()` **resolves**, with `{}`, because the connection failure is
 * logged per server and dropped. So "your token is dead" and "your toolkit name
 * is wrong" arrive as the same value, and one of the two messages gets printed
 * for both causes.
 *
 * Everything here runs over real HTTP against a real `Bun.serve` stub of the
 * gateway — no mock of the unit under test, and every port is `:0`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { decodeEvents, NDJSON, type ChatEvent } from "../lib/agent/events.ts";
import { chat } from "../lib/agent/handlers.ts";
import { sessionTools } from "../lib/agent/tool-list.ts";
import { gatewayClient, governedToolset, SERVER_KEY } from "../lib/agent/tools.ts";
import { configurationProblems, readIdentitySurface, type IdentitySurface } from "../lib/config.ts";
import { forgetGatewayClients, probeGatewayToken } from "../lib/identity/gateway.ts";
import { GATEWAY_START_PATH, liveGatewayToken } from "../lib/identity/handlers.ts";
import { readSessionFromCookies, writeSession, type Session } from "../lib/identity/session.ts";
import { SessionChrome } from "../components/identity/SessionChrome.tsx";

const SESSION_SECRET = "gateway-rejection-suite-session-secret-0123456789";
const GATEWAY_ID = "cg-demo-us";
const DANA = "alice@bank.example";
/** A value no test may ever find in a response body, a log line or an event. */
const TOKEN = "gw-access-token-that-must-never-be-printed";

// ---------------------------------------------------------------------------
// A gateway, in each of the four shapes that matter
// ---------------------------------------------------------------------------

type Shape =
  /** The bearer is not accepted: 401 to the streamable POST, 405 to the SSE GET. */
  | "refuses-the-bearer"
  /** Nothing MCP is there at all: 405 either way — the live cg-web log's shape. */
  | "405-everywhere"
  /** A real `tools/list`, carrying the project's toolkits. */
  | "serves-the-toolkits"
  /** A real `tools/list` that genuinely carries none of ours. */
  | "serves-no-toolkits"
  /** A real `tools/list` carrying nothing at all — #15's dead-control-plane shape. */
  | "serves-nothing";

interface Stub {
  url: string;
  /** Every request the gateway saw, `METHOD /path`. */
  seen: string[];
  stop(): void;
}

function startGateway(shape: Shape): Stub {
  const seen: string[] = [];
  const path = `/mcp/${GATEWAY_ID}`;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname !== path) return new Response(null, { status: 404 });

      if (shape === "405-everywhere") return new Response(null, { status: 405 });
      if (request.method !== "POST") return new Response(null, { status: 405 });

      if (shape === "refuses-the-bearer") {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const message = (await request.json().catch(() => null)) as { id?: unknown; method?: string } | null;
      if (message?.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (message?.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "stub", version: "0.1.0" },
          },
        });
      }
      if (message?.method === "tools/list") {
        const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
        const builtins = ["System_ManageAuthorization", "Arcade_ListApps"];
        const names =
          shape === "serves-the-toolkits"
            ? ["Loan_GetLoan", ...builtins]
            : shape === "serves-nothing"
              ? []
              : builtins;
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: names.map((name) => ({ name, description: name, inputSchema: schema })) },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32601, message: "no" } });
    },
  });

  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true) };
}

function surfaceFor(arcadeApiUrl: string): IdentitySurface {
  return readIdentitySurface({
    ARCADE_API_URL: arcadeApiUrl,
    ARCADE_API_KEY: "gateway-rejection-suite-arcade-key",
    ARCADE_GATEWAY_ID: GATEWAY_ID,
    ARCADE_LOAN_TOOLKIT: "Loan",
    ARCADE_APPROVALS_TOOLKIT: "Approvals",
    ANTHROPIC_API_KEY: "gateway-rejection-suite-anthropic-key",
    SESSION_SECRET,
    PUBLIC_URL: "http://localhost:1",
    IDP_ISSUER: "http://localhost:1",
    IDP_CLIENT_ID: "web",
    IDP_CLIENT_SECRET: "gateway-rejection-suite-client-secret",
  });
}

/** The cookie a browser signed in as Alice and holding a gateway token would send. */
async function browserCookie(config: IdentitySurface, session: Session): Promise<string> {
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, config);
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
}

function signedInWithToken(): Session {
  return {
    email: DANA,
    signed_in_at: Date.now(),
    gateway: { access_token: TOKEN, expires_at: Date.now() + 3_600_000, client_id: "mcp-client-1" },
  };
}

interface Turn {
  status: number;
  contentType: string;
  body: string;
  events: ChatEvent[];
  setCookie: string[];
}

/** Mount `chat` behind a real server, POST one prompt, read the whole answer back. */
async function ask(config: IdentitySurface, cookie: string): Promise<Turn> {
  const server = Bun.serve({ port: 0, fetch: (request) => chat(request, { config }) });
  try {
    const response = await fetch(`http://localhost:${server.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: "Approve the loan for $95K." }),
    });
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
      events: decodeEvents(body),
      setCookie: response.headers.getSetCookie(),
    };
  } finally {
    server.stop(true);
  }
}

/**
 * A cookie jar, the way a browser keeps one.
 *
 * Real enough to matter: a session that shrinks writes `Max-Age=0` for the
 * chunks it no longer needs, and a jar that kept them would hand the next
 * request a value the seal refuses. Round 1 of #98's review drove two
 * consecutive POSTs, so this suite has to carry state between them the way
 * Chrome would rather than re-minting a cookie each time.
 */
function applyCookies(jar: Map<string, string>, setCookie: readonly string[]): Map<string, string> {
  for (const header of setCookie) {
    const [pair, ...attributes] = header.split(";");
    const cut = (pair ?? "").indexOf("=");
    if (cut <= 0) continue;
    const name = (pair as string).slice(0, cut);
    const value = (pair as string).slice(cut + 1);
    if (value === "" || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

/** What that jar sends on the next request. */
function cookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Re-open the session a `Set-Cookie` header left on the browser. */
async function sessionAfter(turn: Turn, config: IdentitySurface): Promise<Session | null> {
  return readSessionFromCookies(applyCookies(new Map(), turn.setCookie), config);
}

// ---------------------------------------------------------------------------

describe("the cause, measured rather than assumed", () => {
  test("a gateway that refuses the bearer makes listToolsets() resolve empty instead of throwing", async () => {
    const gateway = startGateway("refuses-the-bearer");
    const client = gatewayClient({ arcadeApiUrl: gateway.url, gatewayId: GATEWAY_ID, token: TOKEN, timeoutMs: 5_000 });
    try {
      // The bug's exact shape. Not a rejection, not a throw: an empty object,
      // which is also what a gateway carrying none of our toolkits produces.
      await expect(client.listToolsets()).resolves.toEqual({});

      // And `governedToolset` now says which of the two it was.
      const selected = await governedToolset(client, { toolkits: ["Loan", "Approvals"] });
      expect(selected.advertised).toEqual([]);
      expect(selected.error).toBeTruthy();
    } finally {
      await client.disconnect().catch(() => undefined);
      gateway.stop();
    }
  });

  test("the client's own auth state is right for a 401 and blind to the live 405 shape", async () => {
    // Why the fix is a raw `initialize` and not `getServerAuthState()`. With a
    // 401 the SDK raises `UnauthorizedError` and Mastra records `needs-auth`…
    const refusing = startGateway("refuses-the-bearer");
    const a = gatewayClient({ arcadeApiUrl: refusing.url, gatewayId: GATEWAY_ID, token: TOKEN, timeoutMs: 5_000 });
    try {
      await a.listToolsets();
      expect(a.getServerAuthState(SERVER_KEY)).toBe("needs-auth");
    } finally {
      await a.disconnect().catch(() => undefined);
      refusing.stop();
    }

    // …but when the streamable POST fails any other way, no `UnauthorizedError`
    // is ever raised and the auth state stays `undefined`. This shape is the one
    // the live cg-web log showed, down to "Could not connect to server with any
    // available HTTP transport". Under `@mastra/mcp` 1.x the client then fell
    // back to SSE with a `GET`; 2.0 removed that transport (#187), so the POST
    // is the only request and its failure is the whole answer.
    const dead = startGateway("405-everywhere");
    const b = gatewayClient({ arcadeApiUrl: dead.url, gatewayId: GATEWAY_ID, token: TOKEN, timeoutMs: 5_000 });
    try {
      await b.listToolsets();
      expect(b.getServerAuthState(SERVER_KEY)).toBeUndefined();
      expect(new Set(dead.seen)).toEqual(new Set([`POST /mcp/${GATEWAY_ID}`]));
    } finally {
      await b.disconnect().catch(() => undefined);
      dead.stop();
    }
  });
});

describe("probeGatewayToken", () => {
  test("401 and 403 are the gateway refusing the credential", async () => {
    const refusing = startGateway("refuses-the-bearer");
    try {
      expect(await probeGatewayToken(`${refusing.url}/mcp/${GATEWAY_ID}`, TOKEN)).toEqual({
        outcome: "rejected",
        status: 401,
      });
    } finally {
      refusing.stop();
    }

    const forbidding = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 403 }) });
    try {
      expect(await probeGatewayToken(`http://localhost:${forbidding.port}/mcp/${GATEWAY_ID}`, TOKEN)).toEqual({
        outcome: "rejected",
        status: 403,
      });
    } finally {
      forbidding.stop(true);
    }
  });

  test("a gateway that answers the initialize has accepted the credential", async () => {
    const gateway = startGateway("serves-the-toolkits");
    try {
      expect(await probeGatewayToken(`${gateway.url}/mcp/${GATEWAY_ID}`, TOKEN)).toEqual({
        outcome: "accepted",
        status: 200,
      });
    } finally {
      gateway.stop();
    }
  });

  test("anything else is unreachable, which is not a statement about the credential", async () => {
    const broken = startGateway("405-everywhere");
    const on405 = await probeGatewayToken(`${broken.url}/mcp/${GATEWAY_ID}`, TOKEN);
    broken.stop();
    expect(on405.outcome).toBe("unreachable");

    // Nothing listening: the port is bound to read it back, then released.
    const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = closed.port;
    closed.stop(true);
    const offline = await probeGatewayToken(`http://localhost:${port}/mcp/${GATEWAY_ID}`, TOKEN);
    expect(offline.outcome).toBe("unreachable");
  });

  test("the token goes out on the wire and never comes back", async () => {
    const refusing = startGateway("refuses-the-bearer");
    try {
      const probe = await probeGatewayToken(`${refusing.url}/mcp/${GATEWAY_ID}`, TOKEN);
      expect(JSON.stringify(probe)).not.toContain(TOKEN);
    } finally {
      refusing.stop();
    }
  });
});

describe("POST /api/chat, when the gateway rejects this browser's token", () => {
  test("it answers a re-authorize link, not the toolkit-name message", async () => {
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const turn = await ask(config, await browserCookie(config, signedInWithToken()));

      // A stream, because a link has to be clickable and `Chat.tsx` renders a
      // non-2xx body as flat text.
      expect(turn.status).toBe(200);
      expect(turn.contentType).toContain(NDJSON);

      const authorization = turn.events.find((event) => event.kind === "authorization");
      expect(authorization).toBeDefined();
      if (authorization?.kind === "authorization") {
        expect(authorization.url).toContain(GATEWAY_START_PATH);
        expect(authorization.tool).toBe(GATEWAY_ID);
        expect(authorization.instructions).toContain("401");
        expect(authorization.instructions).toContain(DANA);
      }
      expect(turn.events.at(-1)).toEqual({ kind: "done", calls: 0 });

      // The message that sent a person to check two correct variables.
      expect(turn.body).not.toContain("ARCADE_LOAN_TOOLKIT");
      expect(turn.body).not.toContain("advertised 0 tools");
      // And no claim that anything was decided.
      expect(turn.events.some((event) => event.kind === "denied")).toBe(false);
      // Never the token.
      expect(turn.body).not.toContain(TOKEN);
    } finally {
      gateway.stop();
    }
  });

  test("the dead token is dropped from the session and the sign-in is kept", async () => {
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const turn = await ask(config, await browserCookie(config, signedInWithToken()));
      const after = await sessionAfter(turn, config);

      expect(after?.email).toBe(DANA);
      expect(after?.gateway).toBeUndefined();
      expect(after?.gateway_rejected_at).toBeGreaterThan(0);
      // The whole `Set-Cookie` set, token included, never carries the bearer.
      expect(turn.setCookie.join(" ")).not.toContain(TOKEN);
    } finally {
      gateway.stop();
    }
  });

  test("every later Send answers the same way, with the same link (round 1, finding 1)", async () => {
    // The reviewer's exercise, reproduced: one gateway stub, two consecutive
    // `POST /api/chat` calls carrying the cookie the previous one set. Round 1
    // found the first answering `200 application/x-ndjson` with a clickable
    // `/api/arcade/start` and the second answering `401 application/json`
    // — `{"error":"this browser holds no gateway token…"}` — which `Chat.tsx`
    // paints as red text after clearing the events the link was in. So the
    // person who pressed Send twice was left with no way forward on screen.
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const jar = applyCookies(new Map(), [
        // The browser's starting state, as a signed-in Alice holding a bearer.
        ...(await browserCookie(config, signedInWithToken())).split("; "),
      ]);

      const first = await ask(config, cookieHeader(jar));
      applyCookies(jar, first.setCookie);
      const second = await ask(config, cookieHeader(jar));
      applyCookies(jar, second.setCookie);
      // A third, so this is a state the route is in rather than an off-by-one.
      const third = await ask(config, cookieHeader(jar));

      for (const [ordinal, turn] of [["first", first], ["second", second], ["third", third]] as const) {
        expect(`${ordinal}: ${turn.status}`).toBe(`${ordinal}: 200`);
        expect(turn.contentType).toContain(NDJSON);

        const authorization = turn.events.find((event) => event.kind === "authorization");
        expect(`${ordinal}: ${authorization === undefined ? "no link" : "link"}`).toBe(`${ordinal}: link`);
        if (authorization?.kind === "authorization") {
          expect(authorization.url).toContain(GATEWAY_START_PATH);
          expect(authorization.tool).toBe(GATEWAY_ID);
        }
        expect(turn.events.at(-1)).toEqual({ kind: "done", calls: 0 });
        // The unlinkable sentence round 1 read on the second turn.
        expect(turn.body).not.toContain("holds no gateway token");
        expect(turn.body).not.toContain("ARCADE_LOAN_TOOLKIT");
        expect(turn.body).not.toContain(TOKEN);
      }

      // The later turns say *why* there is no token, rather than reporting the
      // absence as though hop 1 had never run.
      const later = second.events.find((event) => event.kind === "authorization");
      if (later?.kind === "authorization") {
        expect(later.instructions).toContain("rejected");
        expect(later.instructions).toContain(DANA);
      }

      // Still signed in, still no bearer, and the stamp is the moment the gap
      // began rather than the last time somebody pressed Send.
      const after = await readSessionFromCookies(jar, config);
      expect(after?.email).toBe(DANA);
      expect(after?.gateway).toBeUndefined();
      const began = (await sessionAfter(first, config))?.gateway_rejected_at;
      expect(after?.gateway_rejected_at).toBe(began as number);
    } finally {
      gateway.stop();
    }
  });

  test("a browser that never ran hop 1 still gets the plain refusal", async () => {
    // The one case that is *not* a re-authorization: nothing was refused and
    // there is nothing to drop, so the flat 401 stays. Kept under test because
    // the fix for finding 1 is a condition on this branch.
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const cookie = await browserCookie(config, { email: DANA, signed_in_at: Date.now() });
      const turn = await ask(config, cookie);

      expect(turn.status).toBe(401);
      expect(turn.contentType).toContain("application/json");
      const body = JSON.parse(turn.body) as { error?: string };
      expect(body.error).toContain("holds no gateway token");
      expect(body.error).toContain(GATEWAY_START_PATH);
    } finally {
      gateway.stop();
    }
  });

  test("the next visit reads 'Gateway token: rejected' rather than 'none'", async () => {
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const turn = await ask(config, await browserCookie(config, signedInWithToken()));
      const after = await sessionAfter(turn, config);

      const html = renderToStaticMarkup(
        <SessionChrome session={after} problems={configurationProblems(config)} />,
      );
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

      expect(text).toContain("Gateway token rejected");
      expect(text).not.toContain("Gateway token none");
      // And the way back is on the same line of chrome.
      expect(html).toContain(GATEWAY_START_PATH);
      expect(html).not.toContain(TOKEN);

      // The other direction, so "none" stays reserved for a browser that never
      // ran hop 1 rather than drifting into meaning both.
      const never = renderToStaticMarkup(
        <SessionChrome
          session={{ email: DANA, signed_in_at: Date.now() }}
          problems={configurationProblems(config)}
        />,
      );
      const neverText = never.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      expect(neverText).toContain("Gateway token none");
      expect(neverText).not.toContain("rejected");
    } finally {
      gateway.stop();
    }
  });
});

describe("POST /api/chat, when the token is fine and the toolkits are not", () => {
  test("a 200 tools/list without the toolkits is still the toolkit-name message", async () => {
    // Criterion 4: the message #94 was about keeps the one cause it is true for.
    const gateway = startGateway("serves-no-toolkits");
    const config = surfaceFor(gateway.url);
    try {
      const turn = await ask(config, await browserCookie(config, signedInWithToken()));
      const body = JSON.parse(turn.body) as { error?: string };

      expect(turn.status).toBe(502);
      expect(body.error).toContain("ARCADE_LOAN_TOOLKIT");
      expect(body.error).toContain("advertised 2 tools");
      // The gateway was asked about the bearer first, and answered.
      expect(gateway.seen.filter((line) => line.startsWith("POST")).length).toBeGreaterThan(1);
    } finally {
      gateway.stop();
    }
  });

  test("a gateway that cannot be reached is plumbing, and says so", async () => {
    const gateway = startGateway("405-everywhere");
    const config = surfaceFor(gateway.url);
    try {
      const turn = await ask(config, await browserCookie(config, signedInWithToken()));
      const body = JSON.parse(turn.body) as { error?: string };

      expect(turn.status).toBe(502);
      expect(body.error).toContain("could not be reached");
      expect(body.error).not.toContain("ARCADE_LOAN_TOOLKIT");
    } finally {
      gateway.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// The refresh, which is the other half of #94
// ---------------------------------------------------------------------------

/**
 * Just enough authorization server for `liveGatewayToken` to reach its token
 * endpoint: the 401 that starts discovery, the two metadata documents, and a
 * `/oauth/token` whose refresh answer each test chooses.
 */
function startAuthorizationServer(refresh: { status: number; body: unknown }) {
  const path = `/mcp/${GATEWAY_ID}`;
  let url = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === path) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource${path}"`,
          },
        });
      }
      if (pathname === `/.well-known/oauth-protected-resource${path}`) {
        return Response.json({ resource: `${url}${path}`, authorization_servers: [`${url}/`] });
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: `${url}/`,
          authorization_endpoint: `${url}/oauth/authorize`,
          token_endpoint: `${url}/oauth/token`,
          registration_endpoint: `${url}/oauth/register`,
        });
      }
      if (pathname === "/oauth/token") {
        return new Response(JSON.stringify(refresh.body), {
          status: refresh.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  url = `http://localhost:${server.port}`;
  return { url, stop: () => server.stop(true) };
}

/** An expiring token, so `liveGatewayToken` has to refresh it. */
function expiringSession(): Session {
  return {
    email: DANA,
    signed_in_at: Date.now(),
    gateway: {
      access_token: TOKEN,
      refresh_token: "gw-refresh-token-that-must-never-be-printed",
      expires_at: Date.now() - 1_000,
      client_id: "mcp-client-1",
    },
  };
}

describe("liveGatewayToken never hands back a stale bearer", () => {
  test("a refresh that answers non-2xx returns no token and the status as the reason", async () => {
    forgetGatewayClients();
    const as = startAuthorizationServer({ status: 400, body: { error: "invalid_grant" } });
    try {
      const live = await liveGatewayToken(expiringSession(), surfaceFor(as.url));

      expect(live.token).toBeNull();
      if (live.token === null) {
        expect(live.reason).toContain("400");
        // The status, not the body, and never the credential.
        expect(live.reason).not.toContain("invalid_grant");
        expect(live.reason).not.toContain(TOKEN);
      }
    } finally {
      as.stop();
      forgetGatewayClients();
    }
  });

  test("a 2xx refresh carrying no access_token returns no token, not the old one", async () => {
    forgetGatewayClients();
    // The shape that made #94 expensive: a success with the field missing, which
    // used to flow on as `undefined` and be presented to the gateway as a bearer.
    const as = startAuthorizationServer({ status: 200, body: { token_type: "Bearer", expires_in: 3600 } });
    try {
      const live = await liveGatewayToken(expiringSession(), surfaceFor(as.url));

      expect(live.token).toBeNull();
      if (live.token === null) {
        expect(live.reason).toContain("access_token");
        expect(live.reason).not.toContain(TOKEN);
      }
    } finally {
      as.stop();
      forgetGatewayClients();
    }
  });

  test("a 200 whose body is the JSON literal null is a reason, not a throw (round 2)", async () => {
    // The reviewer's exact shape. `JSON.parse("null")` is `null`, which satisfies
    // `GatewayTokenResponse` and threw on the first property read — so the one
    // path this issue exists to build became
    // `TypeError: null is not an object (evaluating 'refreshed.token.access_token')`
    // and a 500.
    forgetGatewayClients();
    const as = startAuthorizationServer({ status: 200, body: null });
    try {
      const live = await liveGatewayToken(expiringSession(), surfaceFor(as.url));

      expect(live.token).toBeNull();
      if (live.token === null) {
        expect(live.reason).toContain("access_token");
        expect(live.reason).not.toContain(TOKEN);
      }
    } finally {
      as.stop();
      forgetGatewayClients();
    }
  });

  test("every 2xx body that is not a token is a reason, and none of them throw", async () => {
    // One guard, every shape it has to be total over. A property read is fine
    // for the object cases and fatal for the rest, which is why the read moved
    // into `accessTokenOf` and takes `unknown`.
    const bodies: ReadonlyArray<readonly [string, unknown]> = [
      ["the JSON literal null", null],
      ["an array", []],
      ["a string", "not-a-token-response"],
      ["a number", 42],
      ["an object with no access_token", { token_type: "Bearer", expires_in: 3600 }],
      ["an access_token that is not a string", { access_token: 42 }],
      ["an empty access_token", { access_token: "   " }],
    ];

    for (const [shape, body] of bodies) {
      forgetGatewayClients();
      const as = startAuthorizationServer({ status: 200, body });
      try {
        // Named in the expectation so a failure says which shape broke.
        const live = await liveGatewayToken(expiringSession(), surfaceFor(as.url));
        expect(`${shape}: ${live.token === null ? "no token" : "a token"}`).toBe(`${shape}: no token`);
        if (live.token === null) expect(live.reason).not.toContain(TOKEN);
      } finally {
        as.stop();
        forgetGatewayClients();
      }
    }
  });

  test("a refresh that works replaces the bearer and clears any earlier rejection", async () => {
    forgetGatewayClients();
    const as = startAuthorizationServer({
      status: 200,
      body: { access_token: "gw-access-the-second", refresh_token: "gw-refresh-the-second", expires_in: 3600 },
    });
    try {
      const live = await liveGatewayToken(
        { ...expiringSession(), gateway_rejected_at: 1 },
        surfaceFor(as.url),
      );

      expect(live.token).toBe("gw-access-the-second");
      if (live.token !== null) {
        expect(live.session.gateway?.access_token).toBe("gw-access-the-second");
        // A credential that has just been issued has not been refused.
        expect(live.session.gateway_rejected_at).toBeUndefined();
      }
    } finally {
      as.stop();
      forgetGatewayClients();
    }
  });
});

// ---------------------------------------------------------------------------
// The same distinction, on the page that lists a persona's tools (#15)
// ---------------------------------------------------------------------------

describe("the persona tool list", () => {
  test("a rejected token names the token, not the control plane", async () => {
    // #15's `sessionTools` reads the same `listToolsets()` this issue is about,
    // so it inherits the same ambiguity: a refused bearer and a dead `/access`
    // both arrive as `{}`. Composing rather than duplicating — the probe answers
    // which, and only then does the `/access` sentence get used.
    const gateway = startGateway("refuses-the-bearer");
    const config = surfaceFor(gateway.url);
    try {
      const listed = await sessionTools(signedInWithToken(), { config });

      expect(listed.ok).toBe(false);
      if (!listed.ok) {
        expect(listed.reason).toContain("401");
        expect(listed.reason).toContain(GATEWAY_START_PATH);
        expect(listed.reason).not.toContain("/access");
        expect(listed.reason).not.toContain(TOKEN);
      }
    } finally {
      gateway.stop();
    }
  });

  test("an accepted token that lists nothing at all still names the control plane", async () => {
    // #15's sentence, kept for the one cause it is true for.
    const gateway = startGateway("serves-nothing");
    const config = surfaceFor(gateway.url);
    try {
      const listed = await sessionTools(signedInWithToken(), { config });

      expect(listed.ok).toBe(false);
      if (!listed.ok) {
        expect(listed.reason).toContain("/access");
        expect(listed.reason).not.toContain("401");
      }
    } finally {
      gateway.stop();
    }
  });
});

describe("POST /api/chat, when the refresh answers 200 with no token (round 2)", () => {
  test("the turn is the 200 ndjson re-authorization, not a 500", async () => {
    // The reviewer drove this over HTTP and read
    // `500 {"error":"The chat route failed before it could stream, while it
    // tried to refresh this browser's gateway token."}`. A throw inside the
    // pre-stream section is shaped by #92's `serverFault`, so the 500 was
    // well-formed JSON — and still the wrong answer, because there is a
    // perfectly good re-authorization to offer and nobody was offered it.
    forgetGatewayClients();
    const as = startAuthorizationServer({ status: 200, body: null });
    const config = surfaceFor(as.url);
    try {
      const turn = await ask(config, await browserCookie(config, expiringSession()));

      expect(turn.status).toBe(200);
      expect(turn.contentType).toContain(NDJSON);
      expect(turn.body).not.toContain("failed before it could stream");
      expect(turn.body).not.toContain("is not an object");

      const authorization = turn.events.find((event) => event.kind === "authorization");
      expect(authorization).toBeDefined();
      if (authorization?.kind === "authorization") {
        expect(authorization.url).toContain(GATEWAY_START_PATH);
        expect(authorization.instructions).toContain("access_token");
      }
      expect(turn.events.at(-1)).toEqual({ kind: "done", calls: 0 });
      expect(turn.body).not.toContain(TOKEN);

      // And the dead bearer is dropped, so the next Send takes the same shape
      // rather than the never-authorized refusal (round 1's finding).
      const after = await sessionAfter(turn, config);
      expect(after?.email).toBe(DANA);
      expect(after?.gateway).toBeUndefined();
      expect(after?.gateway_rejected_at).toBeGreaterThan(0);
    } finally {
      as.stop();
      forgetGatewayClients();
    }
  });
});

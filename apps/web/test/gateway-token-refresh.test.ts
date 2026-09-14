/**
 * #113 — a stale gateway session refreshes itself, and a turn after a forced
 * expiry completes with nobody clicking anything.
 *
 * The live failure: after a while, Dana's chat stops working on Render until
 * she re-authorizes by hand. #94 made that honest — a refused bearer became a
 * re-authorization card instead of "0 tools" — but honest is not the same as
 * fixed, and the card is still a human in the loop on a demo whose whole point
 * is that nothing in the loop is a human's judgement.
 *
 * ## The two candidates, and which one this is
 *
 * The issue named two failures with different fixes, and the first `describe`
 * below measures both rather than picking one:
 *
 * 1. **The gateway answers 401 to a bearer the sealed cookie still believes is
 *    live.** `liveGatewayToken` refreshes on `expires_at` and on nothing else,
 *    so a token the gateway stopped accepting *early* — revoked, rotated,
 *    dropped by the authorization server, or simply expiring on a clock this
 *    service does not own — is presented, refused, and turned straight into the
 *    card. No refresh is attempted. **This is the one.**
 * 2. **A cached `MCPClient` holding a dead transport.** Ruled out by
 *    measurement: `lib/agent/tools.ts` builds a client per request under a
 *    random id and disconnects it, and the test below drops a connection
 *    mid-turn and shows the *next* turn connecting fine.
 *
 * Everything here runs over real HTTP: a real `Bun.serve` mounting the real
 * `chat` handler, a real sealed cookie a real browser jar carries between
 * turns, and the identity suite's Arcade stand-in — extended on this slice to
 * expire the tokens it issues and to drop connections, which is the one thing
 * it could not do before. No third stand-in (#87). Every port is `:0`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { decodeEvents, NDJSON, type ChatEvent } from "../lib/agent/events.ts";
import { chat } from "../lib/agent/handlers.ts";
import { sessionTools } from "../lib/agent/tool-list.ts";
import { readIdentitySurface, type IdentitySurface } from "../lib/config.ts";
import {
  exchangeGatewayCode,
  forgetGatewayClients,
  gatewayAuthorizeUrl,
  gatewayClient,
  mcpUrl,
} from "../lib/identity/gateway.ts";
import { liveGatewayToken } from "../lib/identity/handlers.ts";
import { pkce } from "../lib/identity/oidc.ts";
import {
  readSessionFromCookies,
  withGatewayToken,
  writeSession,
  type Session,
} from "../lib/identity/session.ts";
import { GATEWAY_ID, parseForm, startArcadeStandIn, type ArcadeStandIn } from "./identity-harness.ts";
import { scriptedModel, type Turn } from "./model.ts";

const SESSION_SECRET = "gateway-refresh-suite-session-secret-0123456789";
const DANA = "dana.okafor@bank.example";
const WEB_URL = "http://localhost:1";
const CALLBACK = `${WEB_URL}/api/arcade/callback`;

let arcade: ArcadeStandIn;
let config: IdentitySurface;

beforeEach(() => {
  // A module-level registration cache keyed by gateway URL, and every test
  // stands a new stand-in up on a new port.
  forgetGatewayClients();
  arcade = startArcadeStandIn();
  config = readIdentitySurface({
    ARCADE_API_URL: arcade.url,
    ARCADE_API_KEY: "gateway-refresh-suite-arcade-key",
    ARCADE_CLOUD_URL: arcade.url,
    ARCADE_GATEWAY_ID: GATEWAY_ID,
    ARCADE_LOAN_TOOLKIT: "Loan",
    ARCADE_APPROVALS_TOOLKIT: "Approvals",
    ANTHROPIC_API_KEY: "gateway-refresh-suite-anthropic-key",
    SESSION_SECRET,
    PUBLIC_URL: WEB_URL,
    IDP_ISSUER: WEB_URL,
    IDP_CLIENT_ID: "web",
    IDP_CLIENT_SECRET: "gateway-refresh-suite-client-secret",
  });
});

afterEach(() => {
  arcade.stop();
});

// ---------------------------------------------------------------------------
// Hop 1, for real, against the stand-in
// ---------------------------------------------------------------------------

/**
 * Walk the gateway's authorization code flow and come back with the session a
 * finished hop 1 leaves behind.
 *
 * Every step is the production function `lib/identity/handlers.ts` calls —
 * discovery, dynamic registration, the authorize URL, PKCE, the code exchange.
 * Nothing is minted by hand, which is what makes the access token in the
 * resulting session one the stand-in actually issued and can therefore stop
 * accepting.
 */
async function signedInThroughHop1(): Promise<Session> {
  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const client = await gatewayClient(resource, CALLBACK);
  const { verifier, challenge } = await pkce();

  const consent = await fetch(
    gatewayAuthorizeUrl({ client, redirectUri: CALLBACK, resource, state: "state-value", challenge }),
  );
  const form = parseForm(await consent.text());
  if (!form) throw new Error("the gateway stand-in rendered no consent form");
  const allowed = await fetch(new URL(form.action, consent.url).toString(), {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ decision: "allow" }),
  });
  const code = new URL(allowed.headers.get("location") ?? "", WEB_URL).searchParams.get("code");
  if (!code) throw new Error("the consent form led to no authorization code");

  const exchanged = await exchangeGatewayCode({
    client,
    redirectUri: CALLBACK,
    resource,
    code,
    codeVerifier: verifier,
  });
  if (!exchanged.ok) throw new Error(`the code exchange answered ${exchanged.status}: ${exchanged.body}`);

  return withGatewayToken(
    { email: DANA, signed_in_at: Date.now() },
    {
      access_token: exchanged.token.access_token,
      ...(exchanged.token.refresh_token === undefined
        ? {}
        : { refresh_token: exchanged.token.refresh_token }),
      expires_at: Date.now() + (exchanged.token.expires_in ?? 3600) * 1000,
      client_id: client.clientId,
    },
  );
}

// ---------------------------------------------------------------------------
// A browser, minus the browser
// ---------------------------------------------------------------------------

interface Answer {
  status: number;
  contentType: string;
  events: ChatEvent[];
}

/**
 * A cookie jar that keeps what a turn wrote.
 *
 * The reseal is the half of this issue that a single-request test cannot see:
 * a refresh that is not carried to the *next* turn has bought one request and
 * left the browser exactly as stale as it was.
 */
class Jar {
  private readonly cookies = new Map<string, string>();

  async seed(session: Session) {
    const headers = new Headers();
    await writeSession(headers, new Request(WEB_URL), session, config);
    this.absorb(headers.getSetCookie());
  }

  absorb(setCookie: readonly string[]) {
    for (const header of setCookie) {
      const [pair, ...attributes] = header.split(";");
      const cut = (pair ?? "").indexOf("=");
      if (cut <= 0) continue;
      const name = (pair as string).slice(0, cut);
      const value = (pair as string).slice(cut + 1);
      if (value === "" || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) {
        this.cookies.delete(name);
      } else this.cookies.set(name, value);
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  session(): Promise<Session | null> {
    return readSessionFromCookies(new Map(this.cookies), config);
  }
}

/** Mount `chat` behind a real server, POST one prompt, keep whatever cookies came back. */
async function ask(jar: Jar, script: readonly Turn[]): Promise<Answer> {
  const model = scriptedModel(script);
  const server = Bun.serve({
    port: 0,
    fetch: (request) => chat(request, { config, model: () => model.model }),
  });
  try {
    const response = await fetch(`http://localhost:${server.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header },
      body: JSON.stringify({ prompt: "Read the file for LN-2291." }),
    });
    const body = await response.text();
    jar.absorb(response.headers.getSetCookie());
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      events: response.headers.get("content-type") === NDJSON ? decodeEvents(body) : [],
    };
  } finally {
    server.stop(true);
  }
}

/** One tool call and a sentence: a turn that used the gateway rather than one that skipped it. */
const A_TURN: readonly Turn[] = [
  { call: "Loan_GetLoan", input: { loan_id: "LN-2291" } },
  { say: "LN-2291 is pending." },
];

function kinds(events: readonly ChatEvent[]): string[] {
  return events.map((event) => event.kind);
}

// ---------------------------------------------------------------------------
// The measurement — which of the two failures this is
// ---------------------------------------------------------------------------

describe("the cause, measured rather than picked", () => {
  test("candidate 1: the gateway refuses a bearer the sealed cookie still calls live, and nothing refreshes it", async () => {
    const session = await signedInThroughHop1();
    // The session's own clock says there is nearly an hour left.
    expect(session.gateway!.expires_at).toBeGreaterThan(Date.now() + 3_000_000);

    // The gateway stops accepting it anyway. This is the asymmetry the whole
    // issue rests on: expiry as the cookie records it and expiry as the gateway
    // enforces it are two different facts.
    arcade.expireIssuedTokens();

    const refreshesBefore = arcade.refreshes;
    const live = await liveGatewayToken(session, config);
    // `liveGatewayToken` hands back the dead bearer unchanged and calls no
    // token endpoint, because `expires_at` is the only trigger it has.
    expect(live.token).toBe(session.gateway!.access_token);
    expect(arcade.refreshes).toBe(refreshesBefore);

    // And the gateway's own answer to that bearer is a 401.
    const refused = await fetch(mcpUrl(config.arcadeApiUrl, GATEWAY_ID), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${session.gateway!.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(refused.status).toBe(401);
    await refused.body?.cancel().catch(() => undefined);
  });

  test("candidate 2, ruled out: a dropped connection dies with its turn and the next turn connects", async () => {
    const jar = new Jar();
    await jar.seed(await signedInThroughHop1());

    // The transport failure, forced. This is the shape behind "Could not
    // connect to server with any available HTTP transport".
    arcade.dropConnections = true;
    const broken = await ask(jar, A_TURN);
    expect(broken.status).toBe(502);

    // Nothing was cached: the very next turn, with the same cookie and the same
    // process, reaches the gateway. A per-process `MCPClient` would have kept
    // the dead transport and failed here too.
    arcade.dropConnections = false;
    const recovered = await ask(jar, A_TURN);
    expect(recovered.status).toBe(200);
    expect(kinds(recovered.events)).toContain("tool-result");
  });
});

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

describe("POST /api/chat, after the gateway stops accepting this browser's bearer", () => {
  test("the turn completes with nobody clicking anything, and the refresh happened once", async () => {
    const jar = new Jar();
    const session = await signedInThroughHop1();
    await jar.seed(session);
    arcade.expireIssuedTokens();

    const answer = await ask(jar, A_TURN);

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe(NDJSON);
    // No card, no link, no human. The turn ran.
    expect(kinds(answer.events)).not.toContain("authorization");
    expect(kinds(answer.events)).toEqual(["tool-call", "tool-result", "text", "done"]);
    // One refresh, not a retry storm.
    expect(arcade.refreshes).toBe(1);
    expect(arcade.grants).toEqual(["authorization_code", "refresh_token"]);
  });

  test("the refreshed token is resealed into the cookie, so the next turn needs no second refresh", async () => {
    const jar = new Jar();
    const before = await signedInThroughHop1();
    await jar.seed(before);
    arcade.expireIssuedTokens();

    await ask(jar, A_TURN);

    const after = await jar.session();
    expect(after?.gateway?.access_token).toBeTruthy();
    expect(after?.gateway?.access_token).not.toBe(before.gateway!.access_token);
    expect(after?.gateway_rejected_at).toBeUndefined();

    // The proof that the reseal was real rather than cosmetic: a second turn on
    // the same jar spends no second refresh, because the cookie is carrying a
    // bearer the gateway takes.
    const second = await ask(jar, A_TURN);
    expect(second.status).toBe(200);
    expect(arcade.refreshes).toBe(1);
  });

  test("a rotating authorization server survives two forced expiries, because the new refresh token is kept", async () => {
    // The stricter server: every refresh invalidates the refresh token it was
    // given. A service that refreshed and did not store what came back would
    // work once here and lose the session on the second expiry.
    arcade.rotateRefreshTokens = true;
    const jar = new Jar();
    await jar.seed(await signedInThroughHop1());

    arcade.expireIssuedTokens();
    expect((await ask(jar, A_TURN)).status).toBe(200);

    arcade.expireIssuedTokens();
    const second = await ask(jar, A_TURN);
    expect(second.status).toBe(200);
    expect(kinds(second.events)).not.toContain("authorization");
    expect(arcade.refreshes).toBe(2);
  });

  test("a turn that refreshes and then fails for some other reason still hands the new token back", async () => {
    // The gateway takes the refreshed bearer and then cannot list its tools —
    // a 502 about the control plane, not about the credential. The refresh
    // still happened, and a response that dropped it on the floor would have
    // spent the browser's refresh token for nothing.
    arcade.rotateRefreshTokens = true;
    const jar = new Jar();
    const before = await signedInThroughHop1();
    await jar.seed(before);
    arcade.expireIssuedTokens();
    arcade.listsNothing = true;

    const answer = await ask(jar, A_TURN);
    expect(answer.status).toBe(502);

    const after = await jar.session();
    expect(after?.gateway?.access_token).not.toBe(before.gateway!.access_token);
    expect(after?.gateway?.refresh_token).not.toBe(before.gateway!.refresh_token);

    // And the session that came back is usable: the next turn runs on it with
    // no further refresh, which a rotating server would have made impossible
    // had the first one been discarded.
    arcade.listsNothing = false;
    const next = await ask(jar, A_TURN);
    expect(next.status).toBe(200);
    expect(arcade.refreshes).toBe(1);
  });

  test("the bearer the gateway ends up accepting is the refreshed one, and it is the last one on the wire", async () => {
    const jar = new Jar();
    const before = await signedInThroughHop1();
    await jar.seed(before);
    arcade.expireIssuedTokens();

    await ask(jar, A_TURN);

    const after = await jar.session();
    expect(arcade.bearers.at(-1)).toBe(after!.gateway!.access_token);
    expect(arcade.bearers).toContain(before.gateway!.access_token);
  });
});

describe("only when the refresh itself fails does the re-authorization card come back (#94)", () => {
  test("a refresh token the authorization server will not honour ends at the card", async () => {
    const jar = new Jar();
    const session = await signedInThroughHop1();
    // A refresh token this gateway has never issued: the token endpoint answers
    // `invalid_grant`, which is the one case #94's card is for.
    await jar.seed(
      withGatewayToken(session, { ...session.gateway!, refresh_token: "gw-refresh-never-issued" }),
    );
    arcade.expireIssuedTokens();

    const answer = await ask(jar, A_TURN);

    expect(answer.status).toBe(200);
    expect(kinds(answer.events)).toEqual(["authorization", "done"]);
    const card = answer.events[0] as Extract<ChatEvent, { kind: "authorization" }>;
    expect(card.url).toContain("/api/arcade/start");
    expect(card.instructions).toContain("hop 1");
    // The dead bearer is dropped, exactly as it was before this slice.
    const after = await jar.session();
    expect(after?.gateway).toBeUndefined();
    expect(after?.gateway_rejected_at).toBeTruthy();
  });

  test("a session with no refresh token at all says so, and says it about the refusal", async () => {
    const jar = new Jar();
    const session = await signedInThroughHop1();
    const { refresh_token: _dropped, ...withoutRefresh } = session.gateway!;
    await jar.seed(withGatewayToken(session, withoutRefresh));
    arcade.expireIssuedTokens();

    const answer = await ask(jar, A_TURN);

    expect(kinds(answer.events)).toEqual(["authorization", "done"]);
    const card = answer.events[0] as Extract<ChatEvent, { kind: "authorization" }>;
    expect(card.instructions).toContain("401 to this browser's gateway token, and there is no refresh token");
    expect(arcade.refreshes).toBe(0);
  });

  test("a gateway that refuses even the freshly refreshed bearer asks once and then stops", async () => {
    const jar = new Jar();
    await jar.seed(await signedInThroughHop1());

    // Dead on issue: the token endpoint still answers 200 with a token, and the
    // MCP endpoint refuses that token too. Nothing this service does unassisted
    // can fix that, so the point is that it tries exactly once and stops rather
    // than spending a person's credentials in a loop.
    arcade.acceptsIssuedTokens = false;
    arcade.expireIssuedTokens();

    const answer = await ask(jar, A_TURN);

    expect(kinds(answer.events)).toEqual(["authorization", "done"]);
    const card = answer.events[0] as Extract<ChatEvent, { kind: "authorization" }>;
    expect(card.instructions).toContain("401 to this browser's gateway token, and 401 to the refreshed one");
    expect(arcade.refreshes).toBe(1);
  });
});

describe("the tool list on the page recovers the same way", () => {
  test("a refused bearer is refreshed rather than reported, so act 1 still has a list", async () => {
    const session = await signedInThroughHop1();
    arcade.expireIssuedTokens();

    const listed = await sessionTools(session, { config, timeoutMs: 10_000 });

    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.tools.map((tool) => tool.name)).toEqual(["Loan_GetLoan"]);
    expect(arcade.refreshes).toBe(1);
  });

  test("when the refresh fails the page says so and names the hop, without claiming policy hid anything", async () => {
    const session = await signedInThroughHop1();
    const broken = withGatewayToken(session, { ...session.gateway!, refresh_token: "gw-refresh-never-issued" });
    arcade.expireIssuedTokens();

    const listed = await sessionTools(broken, { config, timeoutMs: 10_000 });

    expect(listed.ok).toBe(false);
    if (!listed.ok) {
      expect(listed.reason).toContain("/api/arcade/start");
      expect(listed.reason).toContain("hop 1");
    }
  });
});

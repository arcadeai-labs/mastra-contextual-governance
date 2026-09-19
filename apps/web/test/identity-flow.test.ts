/**
 * Sign-in, the gateway hop, and the custom verifier — over real HTTP, against a
 * real `apps/idp`.
 *
 * What is real and what stands in is stated in `identity-harness.ts` and is
 * worth restating because the value of this suite depends on it: the identity
 * provider is the actual service, booted as a subprocess with its own client C;
 * the route handlers are the actual handlers, mounted behind an actual server
 * and driven with a cookie jar; and the only stand-in is Arcade Cloud, at the
 * network edge, speaking the discovery and confirmation chain spikes #04 and
 * #75 measured off the live service.
 *
 * The measurements this suite exists to make, rather than assume:
 *
 *  - which host renders the login page (cg-idp's, never Arcade's)
 *  - that `prompt=login` actually forces re-authentication on Better Auth, so a
 *    persona switch cannot silently continue as the previous persona
 *  - that `confirm_user` receives the email from the sealed session and nothing
 *    from the request
 *  - that `next_uri` is fetched server-side, without which the grant does not
 *    store (#75)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { deploymentReadiness, readIdentitySurface, readWebConfig } from "../lib/config.ts";
import { readSession } from "../lib/identity/session.ts";
import { SIGNIN_PATH } from "../lib/identity/handlers.ts";
import { SESSION_SECRET_MIN_LENGTH, sessionSecretProblem } from "../lib/identity/seal.ts";
import {
  Browser,
  PEOPLE,
  SESSION_SECRET,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
} from "./identity-harness.ts";

/** Put `process.env` back exactly as it was, including keys that were unset. */
function restoreEnv(previous: NodeJS.ProcessEnv, keys: string[]) {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

/**
 * A `SESSION_SECRET` shaped like one a human would actually produce —
 * `openssl rand -hex 32`. Written out rather than generated so a failure here
 * is reproducible, and used everywhere a test needs a *usable* secret, because
 * the placeholder `"x"` this file used to carry is now refused (and the test
 * below is why).
 */
const GOOD_SECRET = "3f9a1c7e5b2d84069a1fe73c05b8d42e6c917ab3fd50e28c47196baf3d0c5e81";

let harness: IdentityHarness;

beforeAll(async () => {
  harness = await startIdentityHarness();
});

afterAll(async () => {
  await harness?.stop();
});

beforeEach(() => {
  harness.arcade.failConfirm = null;
  harness.arcade.omitNextUri = false;
  harness.arcade.confirmations.length = 0;
  harness.arcade.nextUriFetches.length = 0;
  harness.arcade.nextUriHits.length = 0;
  harness.arcade.nextUriAnswer = "continuation";
});

/** The session a browser is carrying, unsealed with the harness's own key. */
function sessionOf(browser: Browser) {
  return readSession(
    new Request(`${harness.webUrl}/`, {
      headers: { cookie: [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
    }),
    harness.config,
  );
}

describe("signing in as a person", () => {
  /**
   * #176's third criterion, against the real IdP.
   *
   * The bank's chrome renders **one** `Sign in` and its href is this path with
   * nothing on it — no persona hint, because there are no persona buttons left
   * to have pressed. What has to still be true is the thing that was always the
   * point: the browser lands on **cg-idp's** login page, and the person who
   * comes back is whoever types a password there.
   *
   * The literal is imported rather than typed, so this and
   * `components/identity/SessionChrome.tsx` cannot drift into testing different
   * addresses.
   */
  test("the chrome's one Sign in lands on cg-idp's login page, with no persona chosen", async () => {
    const browser = new Browser();
    const started = await browser.fetch(`${harness.webUrl}${SIGNIN_PATH}`);

    expect(started.status).toBe(303);
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin).toBe(harness.idpUrl);
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(harness.config.identity.idpClientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${harness.webUrl}/api/auth/callback`);
    // Still forced re-authentication, so a browser that was somebody a moment
    // ago cannot be quietly continued as them.
    expect(authorize.searchParams.get("prompt")).toBe("login");

    const landed = await browser.follow(authorize.toString(), (fields) => fields, { limit: 4 });
    expect(new URL(landed.url).origin).toBe(harness.idpUrl);
    expect(landed.html).toContain("Sign in");
  });

  test("the route still accepts a persona hint, and lands in the same place", async () => {
    const browser = new Browser();
    const started = await browser.fetch(`${harness.webUrl}/api/auth/signin?persona=dana`);

    expect(started.status).toBe(303);
    const authorize = new URL(started.headers.get("location")!);
    // The IdP's own origin, and the IdP's own authorize endpoint.
    expect(authorize.origin).toBe(harness.idpUrl);
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(harness.config.identity.idpClientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${harness.webUrl}/api/auth/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid email");

    // Follow it and see who actually rendered a form.
    const landed = await browser.follow(authorize.toString(), (fields) => fields, { limit: 4 });
    expect(new URL(landed.url).origin).toBe(harness.idpUrl);
    expect(landed.html).toContain("Sign in");
  });

  test("after login the sealed cookie carries Alice's lowercase email", async () => {
    const browser = new Browser();
    const ended = await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    expect(ended.url).toContain("/api/arcade/start");

    const session = await sessionOf(browser);
    expect(session?.email).toBe(PEOPLE.dana.email);
    expect(session?.email).toBe(session?.email.toLowerCase());

    // The password was typed at the IdP and nowhere else.
    expect(browser.pageHosts.every((host) => host === new URL(harness.idpUrl).host)).toBe(true);
  });

  test("the cookie the browser was given is HttpOnly and unreadable without the key", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const sealed = browser.cookies.get("cg_session.0")!;
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain("dana");

    // Decoding without the key fails: not obfuscated, encrypted.
    const wrongKey = readWebConfig({
      SESSION_SECRET: "a-completely-different-session-secret-xyz",
      PUBLIC_URL: harness.webUrl,
    });
    expect(
      await readSession(
        new Request(`${harness.webUrl}/`, { headers: { cookie: `cg_session.0=${sealed}` } }),
        wrongKey,
      ),
    ).toBeNull();

    // And HttpOnly on the wire, so no script in the page can read it either.
    const fresh = new Browser();
    const started = await fresh.fetch(`${harness.webUrl}/api/auth/signin?persona=dana`);
    expect(started.headers.getSetCookie().every((raw) => raw.includes("HttpOnly"))).toBe(true);
  });

  test("an unknown persona key is dropped rather than echoed into the session", async () => {
    const browser = new Browser();
    const started = await browser.fetch(`${harness.webUrl}/api/auth/signin?persona=mallory`);
    expect(started.status).toBe(303);
    // The button pressed is a label. The identity still comes from whoever
    // types a password, so an unknown key changes nothing about the flow.
    const ended = await browser.follow(
      started.headers.get("location")!,
      (fields) => ({
        ...fields,
        ...("email" in fields ? { email: PEOPLE.sam.email, password: PEOPLE.sam.password } : {}),
        ...("decision" in fields ? { decision: "allow" } : {}),
      }),
      { stopAt: "/api/arcade/start" },
    );
    expect(ended.url).toContain("/api/arcade/start");
    expect((await sessionOf(browser))?.email).toBe(PEOPLE.sam.email);
  });

  test("a callback with a state this browser did not issue is refused", async () => {
    const browser = new Browser();
    await browser.fetch(`${harness.webUrl}/api/auth/signin?persona=dana`);
    const forged = await browser.fetch(`${harness.webUrl}/api/auth/callback?code=whatever&state=not-the-one`);
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("did not start here");
    expect(await sessionOf(browser)).toBeNull();
  });

  test("a callback with no sign-in in progress says so rather than 500ing", async () => {
    const browser = new Browser();
    const orphan = await browser.fetch(`${harness.webUrl}/api/auth/callback?code=x&state=y`);
    expect(orphan.status).toBe(400);
    expect(await orphan.text()).toContain("did not start here");
  });
});

describe("switching persona", () => {
  test("Alice then Bob in one browser: the second sign-in asks for a password again", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    expect((await sessionOf(browser))?.email).toBe(PEOPLE.dana.email);

    // The browser still holds the IdP's own session cookie from Alice's login.
    // This is the condition the measurement needs: without `prompt=login`,
    // Better Auth would continue the authorization off that session and never
    // show a form.
    const idpSessionCookies = [...browser.cookies.keys()].filter((name) => name.includes("session"));
    expect(idpSessionCookies.length).toBeGreaterThan(0);

    const pagesBefore = browser.pageHosts.length;
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });

    // Measured, not assumed. Run with `prompt: "login"` commented out of
    // `signin()`, the same two sign-ins produce:
    //
    //   after 'Sign in as Alice' : alice@bank.example | pages shown: 2
    //   after 'Sign in as Bob'  : alice@bank.example | new pages: 0
    //
    // No page, and the session is still Alice's while the button said Bob. That
    // is the failure the issue names: every tool call for the rest of the demo
    // made as the wrong person, with the screen saying otherwise. With it:
    //
    //   after 'Sign in as Bob'  : bob@bank.example   | new pages: 2
    expect(browser.pageHosts.length).toBeGreaterThan(pagesBefore);
    expect(browser.pageHosts.at(-1)).toBe(new URL(harness.idpUrl).host);

    const session = await sessionOf(browser);
    expect(session?.email).toBe(PEOPLE.sam.email);
    expect(session?.email).not.toBe(PEOPLE.dana.email);
  });

  test("the request that starts a switch carries prompt=login", async () => {
    const browser = new Browser();
    const started = await browser.fetch(`${harness.webUrl}/api/auth/signin?persona=riley`);
    expect(new URL(started.headers.get("location")!).searchParams.get("prompt")).toBe("login");
  });

  test("starting a sign-in clears the old session before leaving, not after coming back", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    expect((await sessionOf(browser))?.email).toBe(PEOPLE.dana.email);

    // Press "Sign in as Bob" and then abandon it at the IdP's login page.
    await browser.fetch(`${harness.webUrl}/api/auth/signin?persona=sam`);
    // This browser is now signed in as nobody — never still as Alice.
    expect(await sessionOf(browser)).toBeNull();
  });

  test("signing out forgets the persona and the gateway token together", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "morgan", { stopAt: "/api/arcade/start" });
    await completeGateway(browser);
    expect((await sessionOf(browser))?.gateway?.access_token).toBeTruthy();

    const out = await browser.fetch(`${harness.webUrl}/api/auth/signout`, { method: "POST" });
    expect(out.status).toBe(303);
    expect(await sessionOf(browser)).toBeNull();
  });
});

/** Drive hop 1 to completion from a signed-in browser and land back on the app. */
async function completeGateway(browser: Browser) {
  return browser.follow(
    `${harness.webUrl}/api/arcade/start`,
    (fields) => ({ ...fields, ...("decision" in fields ? { decision: "allow" } : {}) }),
  );
}

describe("hop 1 — the gateway token", () => {
  test("after sign-in the gateway authorization completes and a token is stored", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    const landed = await completeGateway(browser);

    expect(landed.html).toContain("home");
    const session = await sessionOf(browser);
    expect(session?.email).toBe(PEOPLE.dana.email);
    expect(session?.gateway?.access_token).toMatch(/^gw-access-/);
    expect(session?.gateway?.refresh_token).toMatch(/^gw-refresh-/);
    expect(session!.gateway!.expires_at).toBeGreaterThan(Date.now());

    // The redirect URI registered with the gateway is this service's HTTPS-form
    // public callback, not a loopback port — which is the whole reason
    // `apps/web` drives this flow instead of `MCPClient.authenticate()`.
    expect(harness.arcade.registrations.at(-1)?.redirect_uris).toEqual([
      `${harness.webUrl}/api/arcade/callback`,
    ]);
  });

  test("the stored token is the bearer the gateway accepts", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "riley", { stopAt: "/api/arcade/start" });
    await completeGateway(browser);
    const session = await sessionOf(browser);

    const listed = await fetch(`${harness.config.arcadeApiUrl}/mcp/cg-demo-us`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session!.gateway!.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    expect(harness.arcade.bearers.at(-1)).toBe(session!.gateway!.access_token);
  });

  test("the MCP client is registered once, so consent is not asked again per sign-in", async () => {
    const before = harness.arcade.registrations.length;
    const first = new Browser();
    await signInAs(first, harness, "dana", { stopAt: "/api/arcade/start" });
    await completeGateway(first);
    const second = new Browser();
    await signInAs(second, harness, "sam", { stopAt: "/api/arcade/start" });
    await completeGateway(second);

    // Arcade renders its gateway consent screen once per persona per MCP client
    // id, so a fresh registration per sign-in would mean a consent screen per
    // sign-in. One registration, two personas.
    expect(harness.arcade.registrations.length).toBe(before);
  });

  test("starting hop 1 with no session sends the browser to sign in first", async () => {
    const browser = new Browser();
    const started = await browser.fetch(`${harness.webUrl}/api/arcade/start`);
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toContain("/api/auth/signin");
  });

  test("a gateway callback whose state this browser did not issue is refused", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    await browser.fetch(`${harness.webUrl}/api/arcade/start`);
    const forged = await browser.fetch(`${harness.webUrl}/api/arcade/callback?code=x&state=wrong`);
    expect(forged.status).toBe(400);
    expect((await sessionOf(browser))?.gateway).toBeUndefined();
  });
});

describe("hop 1 — refresh, server-side", () => {
  test("a token close to expiry is refreshed without the browser doing anything", async () => {
    const { liveGatewayToken } = await import("../lib/identity/handlers.ts");

    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    await completeGateway(browser);
    const session = (await sessionOf(browser))!;

    const refreshesBefore = harness.arcade.refreshes;
    // Ask for the bearer as if the token were about to expire.
    const live = await liveGatewayToken(session, harness.config, session.gateway!.expires_at);
    expect(live.token).toBeTruthy();
    expect(harness.arcade.refreshes).toBe(refreshesBefore + 1);
    expect(live.token).not.toBe(session.gateway!.access_token);
    if (live.token) {
      expect(live.session.gateway!.expires_at).toBeGreaterThan(session.gateway!.expires_at);
      // A rotated refresh token replaces the old one; a server that does not
      // rotate leaves the old one in place rather than losing it.
      expect(live.session.gateway!.refresh_token).toBeTruthy();
    }
  });

  test("a live token is returned as it stands, with no call to the gateway", async () => {
    const { liveGatewayToken } = await import("../lib/identity/handlers.ts");

    const browser = new Browser();
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });
    await completeGateway(browser);
    const session = (await sessionOf(browser))!;

    const refreshesBefore = harness.arcade.refreshes;
    const live = await liveGatewayToken(session, harness.config);
    expect(live.token).toBe(session.gateway!.access_token);
    expect(harness.arcade.refreshes).toBe(refreshesBefore);
  });

  test("no token at all is reported as a reason, not as an empty string", async () => {
    const { liveGatewayToken } = await import("../lib/identity/handlers.ts");
    const live = await liveGatewayToken({ email: PEOPLE.dana.email, signed_in_at: 1 }, harness.config);
    expect(live.token).toBeNull();
    if (live.token === null) expect(live.reason).toContain("no gateway token");
  });
});

describe("hop 2 — the custom verifier", () => {
  test("with a session it confirms the flow as the signed-in persona and fetches next_uri", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    expect(verified.status).toBe(200);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: true },
    ]);
    // Measured on #75: without this fetch the grant does not store, and the
    // tool re-challenges forever with nothing on the panel to say why.
    expect(harness.arcade.nextUriFetches).toEqual([flowId]);
    // #100: the browser is never sent back to `next_uri`. #118: it is not sent
    // to Arcade's continuation either — it stays here, on this app's own page.
    // See `hop2-single-exchange.test.ts` for the counting.
    expect(verified.headers.get("location")).toBeNull();
    expect(await verified.text()).toContain("Authorized");
  });

  test("the confirmed identity comes from the session even when the request suggests another", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    // A parameter Arcade does not send and this route does not read. Bob's
    // session is what decides, not the query string.
    await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}&persona=dana`);
    expect(harness.arcade.confirmations.at(-1)?.user_id).toBe(PEOPLE.sam.email);
  });

  test("a request carrying user_id or email is refused outright", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    for (const [name, value] of [
      ["user_id", "michael@bank.example"],
      ["email", "michael@bank.example"],
      ["sub", "michael@bank.example"],
      ["login_hint", "michael@bank.example"],
    ]) {
      const refused = await browser.fetch(
        `${harness.webUrl}/api/arcade/verify?flow_id=f-${name}&${name}=${encodeURIComponent(value!)}`,
      );
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("does not take an identity");
    }
    // Nothing was confirmed as anybody.
    expect(harness.arcade.confirmations).toEqual([]);
  });

  test("no flow_id is a clear refusal, not a login", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    const refused = await browser.fetch(`${harness.webUrl}/api/arcade/verify`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("flow_id");
  });

  test("a confirm_user refusal is shown verbatim and nothing is authorized", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    harness.arcade.failConfirm = { status: 400, body: '{"code":400,"msg":"Bad request"}' };

    const failed = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=doomed`);
    expect(failed.status).toBe(502);
    const html = await failed.text();
    expect(html).toContain("Bad request");
    expect(html).toContain("Nothing was authorized");
    expect(harness.arcade.nextUriFetches).toEqual([]);
  });

  test("a 200 with no next_uri says so instead of claiming the grant landed", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    harness.arcade.omitNextUri = true;

    const answered = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=no-next`);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain("no <code>next_uri</code>");
    expect(harness.arcade.nextUriFetches).toEqual([]);
  });
});

describe("hop 2 — the no-session path, which is the human's case", () => {
  test("a fresh browser parks the flow, signs in, and completes the same two calls", async () => {
    const fresh = new Browser();
    const flowId = `flow-${crypto.randomUUID()}`;

    const parked = await fresh.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);
    expect(parked.status).toBe(303);
    expect(parked.headers.get("location")).toContain("/api/auth/signin");
    // The flow id is parked sealed, so it is neither readable nor forgeable in
    // the browser.
    const parkedCookie = fresh.cookies.get("cg_arcade_flow");
    expect(parkedCookie).toBeTruthy();
    expect(parkedCookie).not.toContain(flowId);

    // Nothing has been confirmed yet — there is nobody to confirm it as.
    expect(harness.arcade.confirmations).toEqual([]);

    const ended = await signInAs(fresh, harness, "riley", {
      from: new URL(parked.headers.get("location")!, harness.webUrl).toString(),
    });

    // #118: the chain ends here, on this app's Authorized page, rather than on
    // whatever Arcade's continuation pointed at.
    expect(ended.response.status).toBe(200);
    expect(ended.html).toContain("Authorized");
    expect(ended.html).toContain(PEOPLE.riley.email);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.riley.email, authorized: true },
    ]);
    expect(harness.arcade.nextUriFetches).toEqual([flowId]);
    expect((await sessionOf(fresh))?.email).toBe(PEOPLE.riley.email);
  });

  test("an expired parked flow renders a page that says what to do, and drops nothing silently", async () => {
    const fresh = new Browser();
    const parked = await fresh.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=expired-flow`);
    expect(parked.status).toBe(303);

    // Ten minutes pass: the browser no longer carries the parked flow.
    fresh.cookies.delete("cg_arcade_flow");

    const ended = await signInAs(fresh, harness, "dana", {
      from: new URL(parked.headers.get("location")!, harness.webUrl).toString(),
    });

    expect(ended.response.status).toBe(410);
    expect(ended.html).toContain("expired");
    expect(ended.html).toContain("Ask the agent for the same tool again");
    // Signed in, but nothing pretended to be authorized.
    expect((await sessionOf(fresh))?.email).toBe(PEOPLE.dana.email);
    expect(harness.arcade.confirmations).toEqual([]);
  });

  test("a parked flow belongs to the browser that parked it", async () => {
    const one = new Browser();
    await one.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=belongs-to-one`);

    // A second browser signing in does not pick up the first one's flow.
    const two = new Browser();
    await signInAs(two, harness, "morgan", { stopAt: "/api/arcade/start" });
    expect(harness.arcade.confirmations).toEqual([]);
  });
});

describe("/health", () => {
  test("it reports the four capability fields", async () => {
    const ready = deploymentReadiness(harness.config);
    expect(ready).toEqual({
      status: "ok",
      signin: "configured",
      gateway: "configured",
      verifier: "configured",
      // The fourth since #14. `ANTHROPIC_API_KEY` is set on this harness for
      // this line alone — a deployment that signs Alice in and then cannot run
      // a turn is not `ok` either.
      agent: "configured",
    });

    expect(deploymentReadiness(readWebConfig({}))).toEqual({
      status: "degraded",
      signin: "missing",
      gateway: "missing",
      verifier: "missing",
      agent: "missing",
    });

    // Each capability fails on its own variables rather than as one flag.
    const signinOnly = readWebConfig({
      IDP_ISSUER: harness.idpUrl,
      IDP_CLIENT_ID: "c",
      IDP_CLIENT_SECRET: "s",
      SESSION_SECRET: GOOD_SECRET,
      PUBLIC_URL: harness.webUrl,
    });
    expect(deploymentReadiness(signinOnly)).toEqual({
      // One of four configured is still `degraded`: a deployment that can sign
      // Alice in and then cannot make a tool call is not `ok`, and round 2 of
      // this PR's review found exactly that shape reporting itself as fine.
      status: "degraded",
      signin: "configured",
      gateway: "missing",
      verifier: "missing",
      agent: "missing",
    });
  });

  test("the route itself answers with them", async () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        IDP_ISSUER: harness.idpUrl,
        IDP_CLIENT_ID: "c",
        IDP_CLIENT_SECRET: "s",
        SESSION_SECRET: GOOD_SECRET,
        PUBLIC_URL: harness.webUrl,
        ARCADE_GATEWAY_ID: "cg-demo-us",
        ARCADE_API_KEY: "k",
        // The two capabilities that arrived after #82, both pinned rather
        // than left to the ambient environment so this stays a test about
        // identity: without them the answer would depend on whoever ran the
        // suite, and on this machine `ANTHROPIC_API_KEY` may well be set.
        ANTHROPIC_API_KEY: "a",
        GOVERNANCE_STREAM: "fixture",
      });
      const { GET } = await import("../app/health/route.ts");
      expect(await GET().json()).toEqual({
        status: "ok",
        service: "web",
        signin: "configured",
        gateway: "configured",
        verifier: "configured",
        agent: "configured",
        panel_stream: "fixture",
        reset: "disabled",
      });
    } finally {
      for (const key of ["IDP_ISSUER", "IDP_CLIENT_ID", "IDP_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_URL", "ARCADE_GATEWAY_ID", "ARCADE_API_KEY", "ANTHROPIC_API_KEY", "GOVERNANCE_STREAM"]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});


describe("a SESSION_SECRET that is set but too weak", () => {
  /**
   * Round 1 of this PR's review, verbatim: with `NODE_ENV=production` and
   * `SESSION_SECRET=x`, the built service reached `Ready`, `/health` answered
   * `{"signin":"configured","gateway":"configured","verifier":"configured"}`
   * and `GET /api/auth/signin?persona=dana` answered `303`. The cookie that
   * sign-in would go on to write holds two bearer tokens.
   *
   * A refusal that only fires on an *absent* value misses the case a human
   * actually produces, and every surface said the deployment was fine. These
   * tests are that measurement, inverted.
   */
  const FILLED = {
    IDP_ISSUER: "https://cg-idp-or5b.onrender.com",
    IDP_CLIENT_ID: "client-c",
    IDP_CLIENT_SECRET: "client-c-secret",
    PUBLIC_URL: "https://cg-web-sa31.onrender.com",
    ARCADE_GATEWAY_ID: "cg-demo-us",
    ARCADE_API_KEY: "arcade-key",
  };

  test("the check itself: what is refused and what is not", () => {
    const refused = [
      undefined,
      "",
      "   ",
      "x",
      // Thirty-one characters: one short of the floor, which is the boundary
      // a length check is most often written on the wrong side of.
      "a".repeat(16) + "bcdefghijklmnop",
      // Thirty-two characters and about one bit — length alone is satisfiable
      // by padding, which is exactly what a human under time pressure types.
      "x".repeat(32),
      "abababababababababababababababab",
    ];
    for (const value of refused) {
      const problem = sessionSecretProblem(value);
      expect(problem).not.toBeNull();
      // Every refusal names the minimum and how to produce one, because whoever
      // reads it is about to go and set the value.
      expect(problem).toContain(`at least ${SESSION_SECRET_MIN_LENGTH} characters`);
      expect(problem).toContain("openssl rand -hex 32");
    }
    expect((refused[4] as string).length).toBe(SESSION_SECRET_MIN_LENGTH - 1);

    // What a human is told to run, both forms, and the harness's own. Written
    // out rather than generated: round 2 of this PR's review found a test that
    // was a coin flip at 1.5%, and a suite that generates its own inputs is a
    // suite whose green is a sample.
    const ACCEPTED = [
      GOOD_SECRET, // openssl rand -hex 32
      "Xh3n5RkqB2vPz9LmTfW0aYdJ8cGsQe4U1oIrNyVbKxM=", // openssl rand -base64 32
      SESSION_SECRET, // what the harness runs on
    ];
    for (const value of ACCEPTED) {
      expect(sessionSecretProblem(value)).toBeNull();
    }
  });

  test("the secret itself never appears in the refusal", () => {
    const problem = sessionSecretProblem("hunter2")!;
    expect(problem).not.toBeNull();
    expect(problem).not.toContain("hunter2");
    // The length is on the line, and that is deliberate: it is a property
    // rather than the value, and without it "too short" is a refusal nobody
    // can act on.
    expect(problem).toContain("7 characters");
  });

  test("the limit of the check, stated rather than left to be discovered", () => {
    // `hunter2` four times over is thirty-two characters with nine distinct
    // ones, and this check accepts it. It is a length-and-variety floor, not an
    // entropy estimate, and the alternative — a repetition detector, a
    // dictionary, a zxcvbn dependency — buys a guess at strength in exchange
    // for false refusals of real random values. The floor catches what a human
    // under time pressure actually types (`x`, `changeme`, a padded string);
    // it does not catch a passphrase someone constructed on purpose.
    expect(sessionSecretProblem("hunter2-hunter2-hunter2-hunter2!")).toBeNull();
  });

  test("/health reports every capability as missing", async () => {
    const weak = readIdentitySurface({ ...FILLED, SESSION_SECRET: "x" });
    expect(deploymentReadiness(weak)).toEqual({
      status: "degraded",
      signin: "missing",
      gateway: "missing",
      verifier: "missing",
      agent: "missing",
    });

    // And through the route the reviewer actually curled.
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        ...FILLED,
        NODE_ENV: "production",
        SESSION_SECRET: "x",
        GOVERNANCE_STREAM: "fixture",
      });
      const { GET } = await import("../app/health/route.ts");
      const answer = GET();
      // 200 on the wire, `degraded` in the body: Render abandons a deploy whose
      // health check is not 200, and an instance that never comes up is an
      // instance whose /health nobody can read.
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({
        status: "degraded",
        service: "web",
        signin: "missing",
        gateway: "missing",
        verifier: "missing",
        agent: "missing",
        // `fixture` rather than `unconfigured`: the panel is watching something
        // it was told to watch, so it is not what makes this `degraded` — the
        // four missing capabilities are. Both halves of the status expression
        // are exercised, one at a time.
        panel_stream: "fixture",
        reset: "disabled",
      });
    } finally {
      restoreEnv(previous, [...Object.keys(FILLED), "NODE_ENV", "SESSION_SECRET", "GOVERNANCE_STREAM"]);
    }
  });

  test("every identity route answers 503 over HTTP and names the minimum", async () => {
    const weak = readIdentitySurface({ ...FILLED, SESSION_SECRET: "x" });
    const { gatewayStart, signin, signinCallback, verify } = await import("../lib/identity/handlers.ts");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/auth/signin") return signin(request, weak);
        if (pathname === "/api/auth/callback") return signinCallback(request, weak);
        if (pathname === "/api/arcade/start") return gatewayStart(request, weak);
        if (pathname === "/api/arcade/verify") return verify(request, weak);
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const base = `http://localhost:${server.port}`;
      for (const path of [
        "/api/auth/signin?persona=dana",
        "/api/auth/callback?code=x&state=y",
        "/api/arcade/start",
        "/api/arcade/verify?flow_id=f1",
      ]) {
        const answer = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(answer.status).toBe(503);
        const html = await answer.text();
        expect(html).toContain(`at least ${SESSION_SECRET_MIN_LENGTH} characters`);
        // No Set-Cookie: nothing was sealed on the way to refusing.
        expect(answer.headers.getSetCookie()).toEqual([]);
      }
    } finally {
      server.stop(true);
    }
  });

  test("sealing under a weak secret is refused, so no route can get there by another path", async () => {
    const { seal } = await import("../lib/identity/seal.ts");
    expect(seal({ email: PEOPLE.dana.email }, "x")).rejects.toThrow(
      new RegExp(`at least ${SESSION_SECRET_MIN_LENGTH} characters`),
    );
  });
});

describe("an unconfigured deployment", () => {
  test("every route says which variable is missing rather than failing obscurely", async () => {
    const bare = readWebConfig({});
    const { signin, verify } = await import("../lib/identity/handlers.ts");

    const signinAnswer = await signin(new Request("https://cg-web-sa31.onrender.com/api/auth/signin"), bare);
    expect(signinAnswer.status).toBe(503);
    expect(await signinAnswer.text()).toContain("IDP_ISSUER");

    const verifyAnswer = await verify(
      new Request("https://cg-web-sa31.onrender.com/api/arcade/verify?flow_id=x"),
      bare,
    );
    expect(verifyAnswer.status).toBe(503);
    expect(await verifyAnswer.text()).toContain("ARCADE_API_KEY");
  });

  test("a production service with no APPROVALS_STORE_TOKEN still serves the identity routes", async () => {
    // Not hypothetical. `readWebConfig` throws in production without that
    // token, the route adapters call these handlers with no config argument, and
    // against the real production build that turned every sign-in into:
    //
    //   GET /api/auth/signin -> 500
    //   Error: APPROVALS_STORE_TOKEN is required in production
    //
    // The identity routes present no approvals credential and must not fail on
    // one. Called with no config, so the default read is what is under test.
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: "production",
        IDP_ISSUER: harness.idpUrl,
        IDP_CLIENT_ID: "c",
        IDP_CLIENT_SECRET: "s",
        SESSION_SECRET: GOOD_SECRET,
        PUBLIC_URL: harness.webUrl,
      });
      delete process.env.APPROVALS_STORE_TOKEN;

      const { signin } = await import("../lib/identity/handlers.ts");
      const answer = await signin(new Request(`${harness.webUrl}/api/auth/signin?persona=dana`));
      expect(answer.status).toBe(303);
      expect(answer.headers.get("location")).toContain(`${harness.idpUrl}/oauth2/authorize`);
    } finally {
      for (const key of ["NODE_ENV", "IDP_ISSUER", "IDP_CLIENT_ID", "IDP_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_URL", "APPROVALS_STORE_TOKEN"]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

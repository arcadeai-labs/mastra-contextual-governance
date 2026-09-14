/**
 * Where the browser goes after hop 2 — #100, and then #118.
 *
 * #100's bug was not a failure to authorize. It is worse, and that is why it
 * took three sittings to find: the verifier fetched `next_uri` server-side
 * (required, measured on #75) and *then* redirected the browser to the same
 * URL. Arcade's provider exchanged the authorization code at `cg-idp` twice,
 * and Better Auth's token endpoint does not merely refuse the replay —
 * `checkVerificationValue` calls `revokeTokensIssuedForAuthorizationCode`,
 * which deletes the access and refresh tokens the *first*, successful exchange
 * minted. So the visible outcome was a verifier that said "authorized", an
 * Arcade grant that existed, and a tool that failed three layers away at
 * `GET /oauth2/userinfo` with "The identity provider rejected the token."
 * Measured in the cg-idp log as two `invalid_grant "invalid code"` rejections
 * 216 ms apart.
 *
 * #100 fixed that by sending the browser to the **continuation** Arcade handed
 * the server fetch, guarded so that a continuation which was `next_uri` written
 * differently was refused. #118 removes the fork instead: the browser always
 * lands on cg-web's own Authorized page, and Arcade's `Location` is read for
 * one log line and nothing else. Decided by the human at the #100 merge gate.
 *
 * So the assertions here are about *counting* and about *ending up here*:
 *
 * - `next_uri` is hit exactly once per verification, and the browser walking
 *   the whole chain to its end does not add a second hit;
 * - every verifier path — session present, and parked flow completed from the
 *   sign-in callback — ends on this app's Authorized page;
 * - no `Location` Arcade answered with is ever handed to the browser, whether
 *   the browser would have replayed `next_uri` by following it or not.
 *
 * And one test proves the count is load-bearing rather than decorative: the
 * stand-in refuses a replayed code and revokes the grant, exactly as Better
 * Auth does, so "exactly one hit" is a statement about a thing that would
 * otherwise break. A control that cannot fail is not a control.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { followNextUri, loggable } from "../lib/identity/verifier.ts";
import {
  Browser,
  PEOPLE,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
} from "./identity-harness.ts";

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
  harness.arcade.nextUriAnswer = "continuation";
  harness.arcade.confirmations.length = 0;
  harness.arcade.nextUriFetches.length = 0;
  harness.arcade.nextUriHits.length = 0;
  harness.arcade.continuations.length = 0;
});

/**
 * Whatever the handlers wrote to `console.info` while `run` was in flight.
 *
 * The log line is the deliverable for one of #100's criteria — before it, the
 * status and the continuation were computed and discarded — and #118 keeps it
 * for the same reason it stops using the value: the continuation is now
 * *only* visible in this line, so a line that stopped being written would take
 * the last evidence of Arcade's half of the flow with it. It is asserted on
 * rather than eyeballed. The handlers run in this process behind the harness's
 * own `Bun.serve`, which is what makes that possible.
 */
async function captureInfo<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.info = original;
  }
}

/** Every URL this browser was answered from, as an origin+path string. */
function visitedPaths(browser: Browser): string[] {
  return browser.visited.map((entry) => entry.split(" ").at(-1) ?? "");
}

describe("the browser ends on this app's Authorized page", () => {
  test("with a session: one hit on next_uri, and the page is cg-web's own", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    expect(verified.status).toBe(200);
    expect(verified.headers.get("location")).toBeNull();
    const html = await verified.text();
    expect(html).toContain("Authorized");
    // Named, because binding the grant to the wrong persona is the failure hop
    // 2 exists to prevent, and a page that does not say who is no evidence.
    expect(html).toContain(PEOPLE.dana.email);
    // The one link on it is this app's chat, which is `/` since #22 and not the
    // `/chat` scaffold the pre-#118 page pointed at.
    expect(html).toContain('href="/"');
    expect(html).not.toContain('href="/chat"');
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: true },
    ]);
  });

  test("Arcade did offer a continuation, and the browser was not given it", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    // The premise: this is not a test that passes because there was nothing to
    // forward. The stand-in answered the server's fetch with a `Location`, the
    // way the live service does.
    expect(harness.arcade.continuations).toHaveLength(1);
    const offered = harness.arcade.continuations[0]!;

    expect(verified.status).toBe(200);
    expect(verified.headers.get("location")).toBeNull();
    // And not smuggled into the page either: the only link on it is the
    // same-origin return path.
    expect(await verified.text()).not.toContain(new URL(offered).origin);
  });

  test("and walking the chain to its end still leaves exactly one hit", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    // The browser does what a browser does: follows every redirect until a page
    // renders. The old code put `next_uri` in that chain, which is the bug.
    const ended = await browser.follow(
      `${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`,
      (fields) => fields,
    );

    expect(ended.response.status).toBe(200);
    expect(ended.html).toContain("Authorized");
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: true },
    ]);
    // Nothing in the chain the browser walked was `next_uri`, and nothing in it
    // was Arcade's continuation either.
    const nextUriPath = new URL(harness.arcade.nextUriOf(flowId)!).pathname;
    expect(visitedPaths(browser).filter((entry) => entry.includes(nextUriPath))).toEqual([]);
    const offered = new URL(harness.arcade.continuations[0]!);
    expect(
      visitedPaths(browser).filter((entry) => entry.startsWith(`${offered.origin}${offered.pathname}`)),
    ).toEqual([]);
  });

  test("the parked-flow path behaves the same, because it is the same function", async () => {
    const fresh = new Browser();
    const flowId = `flow-${crypto.randomUUID()}`;

    const parked = await fresh.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);
    expect(parked.headers.get("location")).toContain("/api/auth/signin");

    // Sign in, which completes the parked flow from the sign-in callback, and
    // keep following until a page renders — the same as above.
    const ended = await signInAs(fresh, harness, "morgan", {
      from: new URL(parked.headers.get("location")!, harness.webUrl).toString(),
    });

    expect(ended.response.status).toBe(200);
    expect(ended.html).toContain("Authorized");
    expect(ended.html).toContain(PEOPLE.morgan.email);
    expect(ended.html).toContain('href="/"');
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.morgan.email, authorized: true },
    ]);
    const nextUriPath = new URL(harness.arcade.nextUriOf(flowId)!).pathname;
    expect(visitedPaths(fresh).filter((entry) => entry.includes(nextUriPath))).toEqual([]);
    const offered = new URL(harness.arcade.continuations[0]!);
    expect(
      visitedPaths(fresh).filter((entry) => entry.startsWith(`${offered.origin}${offered.pathname}`)),
    ).toEqual([]);
  });

  test("a second hit on next_uri would revoke the grant — so the count is load-bearing", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);
    expect(harness.arcade.confirmations.at(-1)?.authorized).toBe(true);

    // What the pre-#100 verifier made the browser do. Better Auth answers
    // `invalid_grant "invalid code"` and revokes the tokens the first exchange
    // minted; the stand-in does the same.
    const replay = await browser.fetch(harness.arcade.nextUriOf(flowId)!);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant", error_description: "invalid code" });
    expect(harness.arcade.nextUriHits).toEqual([flowId, flowId]);
    // The grant that existed a moment ago is gone. This is the whole of #100.
    expect(harness.arcade.confirmations.at(-1)?.authorized).toBe(false);
  });

  test("a next_uri that ends the chain lands on the same page, not on a blank 200", async () => {
    harness.arcade.nextUriAnswer = "terminal";
    const browser = new Browser();
    await signInAs(browser, harness, "riley", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    expect(verified.status).toBe(200);
    const html = await verified.text();
    expect(html).toContain("Authorized");
    expect(html).toContain(PEOPLE.riley.email);
    expect(html).toContain('href="/"');
    // Still exactly one, and still authorized.
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations.at(-1)?.authorized).toBe(true);
  });
});

describe("the verifier says what next_uri answered", () => {
  test("the status and the continuation are logged, and no value on it is", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const { lines } = await captureInfo(() =>
      browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`),
    );

    const line = lines.find((each) => each.includes("[verifier] next_uri answered"));
    expect(line).toBeTruthy();
    expect(line).toContain("302");
    expect(line).toContain("/authorized");
    expect(line).toContain(flowId);
    // The stand-in puts this on the continuation's query string on purpose.
    // Parameter names are the diagnosis; the values are credentials.
    expect(line).toContain("code=…");
    expect(line).not.toContain("s3cr3t-should-not-be-logged");
  });

  test("a next_uri that ends the chain is logged as such rather than silently", async () => {
    harness.arcade.nextUriAnswer = "terminal";
    const browser = new Browser();
    await signInAs(browser, harness, "sam", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const { lines } = await captureInfo(() =>
      browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`),
    );

    const line = lines.find((each) => each.includes("[verifier] next_uri answered"));
    expect(line).toContain("200");
    expect(line).toContain("(none)");
  });
});

describe("followNextUri — the server walks the leg, and only the server", () => {
  test("the redirect is read, not followed, so a single-use endpoint is spent once", async () => {
    // A single-use endpoint that 302s onward and answers every hit after the
    // first the way Better Auth does. Following the `Location` server-side, or
    // handing it to a browser, is what costs the grant.
    let hits = 0;
    const single = Bun.serve({
      port: 0,
      fetch(request) {
        hits += 1;
        const url = new URL(request.url);
        if (hits === 1) {
          return new Response(null, { status: 302, headers: { location: `${url.pathname}?done=1` } });
        }
        return Response.json({ error: "invalid_grant", error_description: "invalid code" }, { status: 400 });
      },
    });

    try {
      const nextUri = `http://localhost:${single.port}/callback?a=1&b=2`;
      const followed = await followNextUri(nextUri);
      expect(followed.status).toBe(302);
      expect(followed.location).toBe("/callback?done=1");
      // The server fetch spent the code, and stopped there.
      expect(hits).toBe(1);
    } finally {
      single.stop(true);
    }
  });
});

describe("loggable — a URL with the values taken out", () => {
  test("origin and path survive; every query value is elided", () => {
    expect(loggable("https://cloud.arcade.dev/auth/done?code=abc123&state=xyz")).toBe(
      "https://cloud.arcade.dev/auth/done?code=…&state=…",
    );
  });

  test("absence and garbage are named rather than printed", () => {
    expect(loggable(null)).toBe("(none)");
    expect(loggable("not a url")).toBe("(unparseable)");
  });
});

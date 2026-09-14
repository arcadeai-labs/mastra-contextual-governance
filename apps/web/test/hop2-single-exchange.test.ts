/**
 * #100 — `next_uri` is walked once, by the server, and the browser is sent
 * somewhere else.
 *
 * The bug this file exists to keep out is not a failure to authorize. It is
 * worse, and that is why it took three sittings to find: the verifier fetched
 * `next_uri` server-side (required, measured on #75) and *then* redirected the
 * browser to the same URL. Arcade's provider exchanged the authorization code
 * at `cg-idp` twice, and Better Auth's token endpoint does not merely refuse the
 * replay — `checkVerificationValue` calls
 * `revokeTokensIssuedForAuthorizationCode`, which deletes the access and refresh
 * tokens the *first*, successful exchange minted. So the visible outcome was a
 * verifier that said "authorized", an Arcade grant that existed, and a tool that
 * failed three layers away at `GET /oauth2/userinfo` with "The identity provider
 * rejected the token." Measured in the cg-idp log as two `invalid_grant "invalid
 * code"` rejections 216 ms apart.
 *
 * So the assertions here are about *counting*, not about success:
 *
 * - `next_uri` is hit exactly once per verification, and the browser walking the
 *   whole chain to its end does not add a second hit;
 * - the verifier's `Location` is never `next_uri`;
 * - both verifier paths — session present, and parked flow completed from the
 *   sign-in callback — behave the same, because both go through one function.
 *
 * And one test proves the count is load-bearing rather than decorative: the
 * stand-in refuses a replayed code and revokes the grant, exactly as Better Auth
 * does, so "exactly one hit" is a statement about a thing that would otherwise
 * break. A control that cannot fail is not a control.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { continuationOf, loggable } from "../lib/identity/verifier.ts";
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
});

/**
 * Whatever the handlers wrote to `console.info` while `run` was in flight.
 *
 * The log line is the deliverable for one of this slice's criteria — before it,
 * the status and the continuation were computed and discarded — so it is
 * asserted on rather than eyeballed. The handlers run in this process behind the
 * harness's own `Bun.serve`, which is what makes that possible.
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

describe("the browser is never sent to next_uri", () => {
  test("with a session: one hit on next_uri, and the Location is the continuation", async () => {
    const browser = new Browser();
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    const nextUri = harness.arcade.nextUriOf(flowId);
    expect(nextUri).toBeTruthy();
    expect(verified.status).toBe(303);

    const location = verified.headers.get("location");
    expect(location).not.toBe(nextUri);
    // Not merely a different string: not the same *URL*. A `Location` that
    // differed only in query-parameter order would be the same replay.
    expect(new URL(location!).href).not.toBe(new URL(nextUri!).href);
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
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
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: true },
    ]);
    // Nothing in the chain the browser walked was `next_uri`.
    const nextUriPath = new URL(harness.arcade.nextUriOf(flowId)!).pathname;
    expect(browser.visited.filter((entry) => entry.includes(nextUriPath))).toEqual([]);
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
    expect(harness.arcade.nextUriHits).toEqual([flowId]);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.morgan.email, authorized: true },
    ]);
    const nextUriPath = new URL(harness.arcade.nextUriOf(flowId)!).pathname;
    expect(fresh.visited.filter((entry) => entry.includes(nextUriPath))).toEqual([]);
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

  test("a next_uri that ends the chain lands on a local page, not on a blank 200", async () => {
    harness.arcade.nextUriAnswer = "terminal";
    const browser = new Browser();
    await signInAs(browser, harness, "riley", { stopAt: "/api/arcade/start" });

    const flowId = `flow-${crypto.randomUUID()}`;
    const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);

    expect(verified.status).toBe(200);
    const html = await verified.text();
    expect(html).toContain("Authorized");
    // Named, because binding the grant to the wrong persona is the failure hop
    // 2 exists to prevent, and a page that does not say who is no evidence.
    expect(html).toContain(PEOPLE.riley.email);
    expect(html).toContain('href="/chat"');
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

describe("continuationOf — what the browser may be handed", () => {
  const next = "https://cloud.arcade.dev/api/v1/oauth/callback_success?flow_id=f1";

  test("a Location that resolves back to next_uri is refused", () => {
    expect(continuationOf(next, next)).toBeNull();
    // The relative form of the same URL, which is what a `Location: ./…` gives.
    expect(continuationOf(next, "callback_success?flow_id=f1")).toBeNull();
  });

  test("no Location is nowhere to send the browser", () => {
    expect(continuationOf(next, null)).toBeNull();
  });

  test("a scheme a browser should not be pointed at is refused", () => {
    expect(continuationOf(next, "javascript:alert(1)")).toBeNull();
    expect(continuationOf(next, "data:text/html,<script>1</script>")).toBeNull();
  });

  test("an ordinary continuation is resolved against next_uri and handed back", () => {
    expect(continuationOf(next, "https://cloud.arcade.dev/auth/done")).toBe("https://cloud.arcade.dev/auth/done");
    expect(continuationOf(next, "/auth/done")).toBe("https://cloud.arcade.dev/auth/done");
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

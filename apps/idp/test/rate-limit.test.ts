/**
 * The ceilings this service refuses at, measured over the wire.
 *
 * #166 was a live outage caused by a rate limit nobody in this repo had
 * chosen: the plugin's inherited 60-per-60s on `/oauth2/userinfo` emptied
 * under the bank's polling and took every persona's sign-in down with it. The
 * fix is a `rateLimit` block with numbers argued in `src/auth.ts`. This is
 * what stops a later edit from dropping it quietly — a configuration that has
 * gone missing looks exactly like one that is present until something is
 * counted.
 *
 * So the ceilings are *measured*, not read back out of the options object: the
 * service is booted the way its Dockerfile boots it, requests are sent until
 * one is refused, and the count is compared with what `RATE_LIMIT` claims.
 * `NODE_ENV=production` is the whole trick — `enabled` defaults to
 * `isProduction`, so a limiter that is off in every other test run is on in
 * this one. Nothing here is authenticated: a request that gets past the
 * limiter answers 401/400/302, one that does not answers 429, and the
 * difference is the measurement.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authOptions, RATE_LIMIT, SIGN_IN_PATH } from "../src/auth.ts";

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "cg-idp-rate-limit-"));

/** One entry of a plugin's `rateLimit` array, as the limiter reads it. */
interface Rule {
  pathMatcher: (path: string) => boolean;
  window: number;
  max: number;
}

let child: Subprocess;
let baseUrl: string;

/** A port the OS says is free — same reasoning as `flow.test.ts::freePort`. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("Bun.serve({ port: 0 }) reported no port");
  return port;
}

/**
 * One unauthenticated request per rate-limited path, each landing on the route
 * rather than on a credential check the limiter sits in front of.
 *
 * `/sign-in/email` deliberately names nobody: a seeded persona must not
 * collect failed password attempts because a test ran.
 */
const probes: Record<string, (nonce: string) => Promise<Response>> = {
  "/oauth2/userinfo": (nonce) =>
    fetch(`${baseUrl}/oauth2/userinfo`, { headers: { authorization: `Bearer probe-${nonce}` } }),
  "/oauth2/token": (nonce) =>
    fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=probe-${nonce}&client_id=probe&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback`,
    }),
  "/oauth2/authorize": (nonce) =>
    fetch(`${baseUrl}/oauth2/authorize?client_id=probe-${nonce}&response_type=code`, { redirect: "manual" }),
  [SIGN_IN_PATH]: (nonce) =>
    fetch(`${baseUrl}${SIGN_IN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `probe-${nonce}@example.invalid`, password: "not-the-password" }),
    }),
};

/**
 * Sends requests to one path until one is refused, and answers how many were
 * allowed first. `cap` is well above every configured ceiling, so running into
 * it means the rule is not being applied at all — reported as the count rather
 * than as a hang.
 */
async function allowedBeforeRefusal(path: string, cap: number): Promise<number> {
  const probe = probes[path]!;
  for (let sent = 1; sent <= cap; sent++) {
    if ((await probe(String(sent))).status === 429) return sent - 1;
  }
  return cap;
}

beforeAll(async () => {
  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>),
      // The limiter is on only here. Every Dockerfile sets this; no other test
      // does, which is why nothing caught #166.
      NODE_ENV: "production",
      PORT: String(port),
      IDP_DB_PATH: join(dir, "idp.db"),
      IDP_PUBLIC_URL: baseUrl,
      IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
      // Made here, held in this child's environment, never written anywhere
      // and gone when the run ends — the database it signs for is a temporary
      // directory removed below.
      BETTER_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`idp did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`);
    }
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the numbers are the ones the comment argues", () => {
  // Written out rather than read from RATE_LIMIT: a test that compares a
  // constant with itself passes whatever the constant becomes. These are the
  // values `src/auth.ts` shows its arithmetic for, so changing one without
  // changing the argument fails here.
  test("RATE_LIMIT holds the argued values", () => {
    expect(RATE_LIMIT).toEqual({
      userinfo: { window: 2, max: 120 },
      token: { window: 60, max: 60 },
      authorize: { window: 60, max: 60 },
      introspect: { window: 60, max: 100 },
      revoke: { window: 60, max: 30 },
      register: { window: 60, max: 5 },
      signIn: { window: 10, max: 30 },
      everythingElse: { window: 10, max: 100 },
    });
  });

  test("every ceiling reaches the rule the limiter will match", () => {
    const options = authOptions({
      db: null as never,
      baseURL: "http://127.0.0.1:1",
      secret: "unused-by-this-assertion",
    });

    // Not the options the plugin was handed — the rules it built from them.
    // `resolveRateLimitConfig` picks a rule by calling these matchers against
    // the request path, so this asks the same question the limiter asks: for
    // this path, which numbers apply? An option that never arrived leaves the
    // plugin's `?? 60` default in place and raises no error, which is the
    // whole failure mode.
    const rules = (options.plugins[1] as unknown as Rule[] & { rateLimit: Rule[] }).rateLimit;
    const applying = (path: string) => {
      const matched = rules.filter((rule) => rule.pathMatcher(path));
      expect(matched).toHaveLength(1);
      return { window: matched[0]!.window, max: matched[0]!.max };
    };

    expect(applying("/oauth2/userinfo")).toEqual({ window: 2, max: 120 });
    expect(applying("/oauth2/token")).toEqual({ window: 60, max: 60 });
    expect(applying("/oauth2/authorize")).toEqual({ window: 60, max: 60 });
    expect(applying("/oauth2/introspect")).toEqual({ window: 60, max: 100 });
    expect(applying("/oauth2/revoke")).toEqual({ window: 60, max: 30 });
    expect(applying("/oauth2/register")).toEqual({ window: 60, max: 5 });

    // Sign-in is Better Auth's own special rule, so it can only be raised from
    // the top-level custom rules — and only for a path spelled exactly right.
    expect(options.rateLimit).toEqual({
      window: 10,
      max: 100,
      customRules: { "/sign-in/email": { window: 10, max: 30 } },
    });
  });

  test("`enabled` is left to default, so `bun test` is not rate limited", () => {
    const options = authOptions({
      db: null as never,
      baseURL: "http://127.0.0.1:1",
      secret: "unused-by-this-assertion",
    });
    expect(options.rateLimit).not.toHaveProperty("enabled");
  });
});

describe("measured over the wire, booted with NODE_ENV=production", () => {
  // Each path is its own `<ip>|<path>` bucket, so one measurement does not
  // spend another's allowance. The cap is far above every ceiling: reaching it
  // means the rule matched nothing, which is the failure this repo cares about
  // most — indistinguishable from a rule that permits.
  const cap = 400;

  test(
    "/oauth2/userinfo allows 120, not the inherited 60",
    async () => {
      expect(await allowedBeforeRefusal("/oauth2/userinfo", cap)).toBe(RATE_LIMIT.userinfo.max);
    },
    30_000,
  );

  test(
    "two seconds of silence clears the count completely",
    async () => {
      // The counter resets only after a full window with no *allowed* request,
      // and a refusal does not slide it. This is the property the whole fix
      // rests on: with a 2-second window, the quiet gaps the demo's own
      // traffic leaves (at least 60/N seconds for N live tokens) reset the
      // count every minute, so it never accumulates towards the ceiling.
      //
      // Exhausted here rather than inherited from the test above, so this
      // measures its own bucket and not the order the file happened to run in
      // — starting from the quiet that clears whatever ran before it.
      await Bun.sleep(RATE_LIMIT.userinfo.window * 1_000 + 300);
      expect(await allowedBeforeRefusal("/oauth2/userinfo", cap)).toBe(RATE_LIMIT.userinfo.max);
      expect((await probes["/oauth2/userinfo"]!("still-full")).status).toBe(429);
      await Bun.sleep(RATE_LIMIT.userinfo.window * 1_000 + 300);
      expect(await allowedBeforeRefusal("/oauth2/userinfo", cap)).toBe(RATE_LIMIT.userinfo.max);
    },
    30_000,
  );

  test(
    "/sign-in/email allows 30, so the custom rule is matching the real path",
    async () => {
      expect(await allowedBeforeRefusal(SIGN_IN_PATH, cap)).toBe(RATE_LIMIT.signIn.max);
    },
    30_000,
  );

  test(
    "/oauth2/token allows 60, not the inherited 20",
    async () => {
      expect(await allowedBeforeRefusal("/oauth2/token", cap)).toBe(RATE_LIMIT.token.max);
    },
    30_000,
  );

  test(
    "/oauth2/authorize allows 60, not the inherited 30",
    async () => {
      expect(await allowedBeforeRefusal("/oauth2/authorize", cap)).toBe(RATE_LIMIT.authorize.max);
    },
    30_000,
  );
});

/**
 * Arcade's provider token request, accepted as it is actually sent (#79).
 *
 * The Arcade dashboard's custom OAuth provider carries `auth_method:
 * client_secret_basic` **and** the template's `client_id={{client_id}}` /
 * `client_secret={{client_secret}}` Request Parameter rows, on Token Settings
 * and Refresh Token Settings alike. So its token request presents the same
 * credentials twice, which RFC 6749 §2.3 forbids and
 * `@better-auth/oauth-provider` enforces in
 * `normalizeClientAuthenticationParameters` (`utils-C2yu_zRr.mjs:541`).
 * Measured on the live `cg-idp`, spike #75, 2026-09-11T17:38Z:
 *
 * ```
 * [idp] POST /oauth2/token rejected: status=400 error=invalid_request
 *   error_description="A request must use only one client authentication method"
 *   client_auth="client_secret_basic" client_id=RskTFjl6…
 * ```
 *
 * The human will not remove those rows, so this service accepts the shape. It
 * accepts **only** that shape: identical credentials presented twice. Two
 * different identities in one request stay refused, and the refusal says which
 * of the two cases it was, because a control that cannot be told from a
 * permission is not a control.
 *
 * Booted the way Render boots it, over real HTTP, on a port the OS chose.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadPeople } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const dbPath = join(tmpdir(), `cg-idp-dual-${crypto.randomUUID()}`, "idp.db");
const logPath = join(dirname(dbPath), "stdout.log");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const SECRET = "test-secret-".padEnd(48, "x");

const people = loadPeople({});
const dana = people.find((person) => person.persona === "dana")!;

let child: Subprocess;
let baseUrl: string;
let env: Record<string, string>;
let clientId: string;
let clientSecret: string;

/** See `test/flow.test.ts::freePort` — bind `:0` and read it back, never guess. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error(`Bun.serve({ port: 0 }) reported no port`);
  return port;
}

/**
 * `Authorization: Basic base64(client_id ":" client_secret)`, RFC 6749 §2.3.1:
 * each half `application/x-www-form-urlencoded` before the base64.
 *
 * Hand-rolled rather than imported from the server, so this is the header a
 * relying party that only read the RFC would build. A shared helper would agree
 * with the server by construction.
 */
function basicAuth(id: string, secret: string): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${half(id)}:${half(secret)}`).toString("base64")}`;
}

function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest()).toString(
    "base64url",
  );
  return { verifier, challenge };
}

/** A browser, minus the browser: a cookie jar and manual redirects. */
class Browser {
  private cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async submit(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

/**
 * Walks Alice to a real, unused authorization code.
 *
 * The `authorization_code` grant consumes the code **before** it authenticates
 * the client, so a placeholder code answers `invalid_grant` without ever
 * reaching the credential checks — and every assertion below would pass on a
 * service that had none. One genuine code per attempt; the failing attempt
 * burns it too.
 */
async function mintCode(): Promise<{ code: string; verifier: string }> {
  const browser = new Browser();
  const { verifier, challenge } = pkce();

  const authorize = await browser.fetch(
    `${baseUrl}/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "openid profile email offline_access",
        state: "state-" + crypto.randomUUID(),
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
  );
  let location = authorize.headers.get("location") ?? "";

  if (/\/login(\?|$)/.test(location)) {
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: new URL(location, baseUrl).search.slice(1),
    });
    expect(login.status).toBe(303);
    location = login.headers.get("location") ?? "";
  }
  if (/\/consent\?/.test(location)) {
    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "allow",
      oauth_query: new URL(location, baseUrl).search.slice(1),
    });
    expect(consent.status).toBe(303);
    location = consent.headers.get("location") ?? "";
  }

  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

interface TokenResponse {
  status: number;
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** One POST to the token endpoint, with the form built in the order given. */
async function postToken(
  fields: Array<[string, string]>,
  headers: Record<string, string> = {},
): Promise<TokenResponse & { headers: Headers }> {
  const body = fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const response = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  const parsed = (await response.json().catch(() => ({}))) as Omit<TokenResponse, "status">;
  return { status: response.status, headers: response.headers, ...parsed };
}

/** A live refresh token, spent by whichever test asks for one. */
async function mintRefreshToken(): Promise<string> {
  const { code, verifier } = await mintCode();
  const token = await postToken(
    [
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", REDIRECT_URI],
      ["code_verifier", verifier],
    ],
    { authorization: basicAuth(clientId, clientSecret) },
  );
  expect(token.status).toBe(200);
  expect(token.refresh_token).toBeTruthy();
  return token.refresh_token!;
}

/** How much of the log has already been written, so a test reads its own line. */
async function logLength(): Promise<number> {
  return (await Bun.file(logPath).text().catch(() => "")).length;
}

/** Waits for a line matching `match` after `from`, and returns it with the whole tail. */
async function waitForLogLine(
  match: RegExp,
  from: number,
  timeoutMs = 5_000,
): Promise<{ line: string; tail: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tail = (await Bun.file(logPath).text().catch(() => "")).slice(from);
    const line = tail.split("\n").find((candidate) => match.test(candidate));
    if (line) return { line, tail };
    if (Date.now() > deadline) throw new Error(`no log line matching ${match} in:\n${tail}`);
    await Bun.sleep(25);
  }
}

const REJECTION = /POST \/oauth2\/token rejected:/;

beforeAll(async () => {
  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  env = {
    ...inherited,
    PORT: String(port),
    IDP_DB_PATH: dbPath,
    IDP_PUBLIC_URL: baseUrl,
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
    BETTER_AUTH_SECRET: SECRET,
  };

  mkdirSync(dirname(logPath), { recursive: true });
  child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env,
    stdout: Bun.file(logPath),
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
      throw new Error(
        `idp did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`,
      );
    }
    await Bun.sleep(50);
  }

  // The service created the client on the line above and hashed its secret, so
  // rotate once for one this test can send. The operational path on a fresh
  // deploy (#70).
  const rotate = Bun.spawn(["bun", join(ROOT, "scripts", "oauth-client.ts"), "--json", "--rotate"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exit] = await Promise.all([new Response(rotate.stdout).text(), rotate.exited]);
  expect(exit).toBe(0);
  const credentials = JSON.parse(out) as { client_id: string; client_secret: string };
  clientId = credentials.client_id;
  clientSecret = credentials.client_secret;
  expect(clientSecret).toBeTruthy();
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

describe("authorization_code: the four ways a client can present itself", () => {
  test("(a) Basic and a matching body pair is accepted, and the code is real", async () => {
    const { code, verifier } = await mintCode();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
        ["client_id", clientId],
        ["client_secret", clientSecret],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.error).toBeUndefined();
    expect(token.access_token).toBeTruthy();

    // The token is worth something: the same access token identifies Alice at
    // userinfo. A 200 with a token nothing accepts would pass a weaker check.
    const who = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(who.status).toBe(200);
    expect(((await who.json()) as { email: string }).email).toBe(dana.email);
  });

  test("(b) Basic and a mismatched body pair is refused, logged once, with no secret", async () => {
    const { code, verifier } = await mintCode();
    const from = await logLength();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
        ["client_id", clientId],
        ["client_secret", "a-different-secret-entirely"],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_request");
    expect(token.access_token).toBeUndefined();

    // The refusal is this service's, so it must not be distinguishable in form
    // from the plugin's own token errors — RFC 6749 §5.1, and measured against
    // what @better-auth/oauth-provider puts on an `invalid_request`.
    expect(token.headers.get("cache-control")).toBe("no-store");
    expect(token.headers.get("pragma")).toBe("no-cache");

    const { line, tail } = await waitForLogLine(/client_auth="mixed"/, from);
    expect(line).toMatch(REJECTION);
    expect(line).toContain("status=400");
    expect(line).toContain("error=invalid_request");
    expect(line).toContain(`client_id=${clientId}`);

    // One line, not two: the refusal is this service's, so Better Auth never
    // saw the request and has nothing of its own to say about it.
    expect(tail.split("\n").filter((candidate) => REJECTION.test(candidate))).toHaveLength(1);

    // Neither secret, the real one or the decoy. A log line that leaks a
    // credential while reporting a credential problem is worse than silence.
    expect(tail).not.toContain(clientSecret);
    expect(tail).not.toContain("a-different-secret-entirely");
  });

  test("(b2) a body pair whose client_id differs is refused the same way", async () => {
    const { code, verifier } = await mintCode();
    const from = await logLength();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
        ["client_id", "some-other-client"],
        ["client_secret", clientSecret],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_request");

    const { line } = await waitForLogLine(/client_auth="mixed"/, from);
    expect(line).toContain("error=invalid_request");
  });

  test("(b3) a body client_secret with no client_id beside it is refused: half a pair is not a duplicate", async () => {
    const { code, verifier } = await mintCode();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
        ["client_secret", clientSecret],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_request");
    expect(token.access_token).toBeUndefined();
  });

  test("(c) body-only credentials are still refused — the registered method has not moved", async () => {
    const { code, verifier } = await mintCode();
    const from = await logLength();

    const token = await postToken([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", REDIRECT_URI],
      ["code_verifier", verifier],
      ["client_id", clientId],
      ["client_secret", clientSecret],
    ]);

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_client");
    expect(token.error_description).toBe(
      "client registered for client_secret_basic cannot use client_secret_post",
    );

    // And it is logged as the post form, not as `mixed`: #79 did not widen
    // what the client may register for, only what one request may repeat.
    const { line } = await waitForLogLine(/client_auth="client_secret_post"/, from);
    expect(line).toMatch(REJECTION);
  });

  test("(d) header-only is accepted, exactly as before", async () => {
    const { code, verifier } = await mintCode();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.access_token).toBeTruthy();
  });

  test("a wrong secret in both places is still a wrong secret", async () => {
    // The strip must not be a way past the credential check: identical
    // credentials are accepted as *one* presentation, and one wrong
    // presentation is refused.
    const { code, verifier } = await mintCode();
    const from = await logLength();

    const token = await postToken(
      [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", REDIRECT_URI],
        ["code_verifier", verifier],
        ["client_id", clientId],
        ["client_secret", "not-the-secret"],
      ],
      { authorization: basicAuth(clientId, "not-the-secret") },
    );

    expect(token.status).toBe(401);
    expect(token.error).toBe("invalid_client");
    expect(token.access_token).toBeUndefined();

    // Logged as what the plugin was asked, which after the strip is Basic —
    // the caller's problem is the secret, and saying `mixed` here would send
    // a reader after a method problem that does not exist.
    const { line } = await waitForLogLine(/client_auth="client_secret_basic"/, from);
    expect(line).toContain('error_description="invalid client_secret"');
  });
});

describe("refresh_token: the same four, because Arcade's Refresh Token Settings carry the same rows", () => {
  test("(e-a) Basic and a matching body pair is accepted", async () => {
    const refreshToken = await mintRefreshToken();

    const token = await postToken(
      [
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
        ["client_id", clientId],
        ["client_secret", clientSecret],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.access_token).toBeTruthy();
  });

  test("(e-b) Basic and a mismatched body pair is refused and logged as mixed", async () => {
    const refreshToken = await mintRefreshToken();
    const from = await logLength();

    const token = await postToken(
      [
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
        ["client_id", clientId],
        ["client_secret", "a-different-secret-entirely"],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_request");
    expect(token.access_token).toBeUndefined();

    const { line, tail } = await waitForLogLine(/client_auth="mixed"/, from);
    expect(line).toMatch(REJECTION);
    expect(tail).not.toContain(clientSecret);

    // Refused before the grant was dispatched, so the refresh token was not
    // spent: it still works on the next, honest attempt.
    const retry = await postToken(
      [
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );
    expect(retry.status).toBe(200);
  });

  test("(e-c) body-only credentials are still refused", async () => {
    const refreshToken = await mintRefreshToken();

    const token = await postToken([
      ["grant_type", "refresh_token"],
      ["refresh_token", refreshToken],
      ["client_id", clientId],
      ["client_secret", clientSecret],
    ]);

    expect(token.status).toBe(400);
    expect(token.error).toBe("invalid_client");
    expect(token.error_description).toBe(
      "client registered for client_secret_basic cannot use client_secret_post",
    );
  });

  test("(e-d) header-only is accepted", async () => {
    const refreshToken = await mintRefreshToken();

    const token = await postToken(
      [
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.access_token).toBeTruthy();
  });
});

/**
 * (f) The request Arcade actually sends, replayed field for field.
 *
 * From the provider configuration read back in
 * `docs/spikes/evidence/05-custom-verifier-transcript.md` §11.8, recreated
 * 2026-09-11T16:55:22Z:
 *
 * ```json
 * "token_request": {
 *   "method": "POST",
 *   "auth_method": "client_secret_basic",
 *   "params": { "client_id": "{{client_id}}", "client_secret": "<redacted>",
 *               "grant_type": "authorization_code", "redirect_uri": "{{redirect_uri}}" },
 *   "request_content_type": "application/x-www-form-urlencoded"
 * }
 * ```
 *
 * So: those four parameters, in that order, form-encoded, with the Basic header
 * `auth_method` produces — plus the `code` and `code_verifier` Arcade adds per
 * flow, PKCE being S256 on both sides. The parameter order is kept because the
 * point of this test is that nothing about the request had to change.
 */
describe("(f) Arcade's provider token request, replayed", () => {
  test("the authorization_code request is accepted and returns a usable token", async () => {
    const { code, verifier } = await mintCode();
    const from = await logLength();

    const token = await postToken(
      [
        ["client_id", clientId],
        ["client_secret", clientSecret],
        ["grant_type", "authorization_code"],
        ["redirect_uri", REDIRECT_URI],
        ["code", code],
        ["code_verifier", verifier],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.error).toBeUndefined();
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeTruthy();

    // And nothing was rejected on the way: the 17:38Z line is the thing this
    // slice exists to stop producing.
    await Bun.sleep(250);
    const tail = (await Bun.file(logPath).text()).slice(from);
    expect(tail).not.toMatch(REJECTION);
    expect(tail).not.toContain("A request must use only one client authentication method");

    const who = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(((await who.json()) as { email: string }).email).toBe(dana.email);
  });

  test("the refresh_token request, same rows, is accepted too", async () => {
    const refreshToken = await mintRefreshToken();
    const from = await logLength();

    const token = await postToken(
      [
        ["client_id", clientId],
        ["client_secret", clientSecret],
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
      ],
      { authorization: basicAuth(clientId, clientSecret) },
    );

    expect(token.status).toBe(200);
    expect(token.access_token).toBeTruthy();

    await Bun.sleep(250);
    expect((await Bun.file(logPath).text()).slice(from)).not.toMatch(REJECTION);
  });
});

describe("the log, over the whole run", () => {
  test("never carries the client secret", async () => {
    expect(await Bun.file(logPath).text()).not.toContain(clientSecret);
  });

  test("/health states what the token endpoint tolerates", async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      oauth: { duplicate_client_credentials: string };
    };
    expect(health.oauth.duplicate_client_credentials).toContain("identical");
    expect(health.oauth.duplicate_client_credentials).toContain("invalid_request");
  });
});

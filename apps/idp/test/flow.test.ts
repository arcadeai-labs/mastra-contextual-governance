/**
 * The authorization-code flow Arcade will drive, exercised over real HTTP
 * against the service booted the way Render boots it: `bun src/index.ts`, env
 * only. Authorize → login page → consent page → code → token → userinfo. No
 * handler is called in-process; the thing that has to work is the wire.
 *
 * Since #70 it also holds the key set: `/.well-known/openid-configuration`
 * carries a `jwks_uri`, and the ID token the flow returns is verified against
 * a key fetched from it — with WebCrypto, not a JWT library, so the assertion
 * is that the signature checks out rather than that a dependency said so.
 *
 * Also the two operational scripts, run as subprocesses against the same
 * database: `oauth-client` prints the secret exactly once and rotates it under
 * the same client id, and `reset` must leave the credentials Arcade holds
 * working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadPeople } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const dbPath = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
// Everything the service prints, from boot to the end of the run. A file
// rather than a pipe so "never logs the secret" can read all of it, not
// whichever chunk happens to be first.
const logPath = join(dirname(dbPath), "stdout.log");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const SECRET = "test-secret-".padEnd(48, "x");

// The fixture's own addresses: any persona email variable in the developer's shell is
// deliberately not passed to the child, so the test is about the fixture.
const people = loadPeople({});
const dana = people.find((p) => p.persona === "dana")!;
const riley = people.find((p) => p.persona === "riley")!;
// Used only by the rotation test. Consent is recorded per person, per client,
// and outlives a cookie jar — so a test that walks the flow as someone else's
// persona silently changes whether *their* test sees the consent page.
const morgan = people.find((p) => p.persona === "morgan")!;
// Only the revocation test signs in as Bob, which keeps that test's consent
// screen predictable: consent is recorded per person per client and outlives a
// cookie jar, so sharing a persona would make one test depend on another.
const sam = people.find((p) => p.persona === "sam")!;

let child: Subprocess;
let baseUrl: string;
let env: Record<string, string>;

interface Credentials {
  client_id: string;
  /** `null` on every run that did not itself produce the secret — see #70. */
  client_secret: string | null;
  client_secret_state: "unchanged" | "created" | "migrated" | "rotated";
  client_secret_note: string;
  created: boolean;
  rotated: boolean;
  issuer: string;
  jwks_url: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  pkce: string;
  userinfo_email_jsonpath: string;
}

/**
 * The credentials the flow tests drive with.
 *
 * The service creates the client when it boots, so no later `oauth-client` run
 * can print that secret — storage is hashed since #70. `beforeAll` therefore
 * rotates once to obtain a readable one, which is exactly the operational path
 * a human takes on a fresh deploy. Any test that rotates again goes through
 * `rotateCredentials` so this stays the live secret.
 */
let creds: Credentials;

async function runScript(name: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts", name), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/**
 * Waits for a line matching `match` to appear in the service's stdout, and
 * returns it.
 *
 * The log is a file the child writes to, so a line the server printed while
 * answering the request we just made may not have reached the disk by the time
 * the response did. Polling is what makes that a wait rather than a race; the
 * deadline is what makes its absence a failure with the whole log attached
 * rather than an `undefined` three assertions later.
 */
async function waitForLogLine(match: RegExp, from = 0, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let tail = "";
  for (;;) {
    tail = (await Bun.file(logPath).text()).slice(from);
    const line = tail.split("\n").find((candidate) => match.test(candidate));
    if (line) return line;
    if (Date.now() > deadline) {
      throw new Error(`no log line matched ${match} within ${timeoutMs}ms. Tail was:\n${tail}`);
    }
    await Bun.sleep(25);
  }
}

/**
 * How much of the log has already been written. Passed to `waitForLogLine` as
 * its starting offset, so a test reads the line *its own* request produced
 * rather than an identically-shaped one from a test that ran earlier — which
 * is a green assertion about somebody else's behaviour.
 */
async function logLength(): Promise<number> {
  return (await Bun.file(logPath).text()).length;
}

/**
 * A port the OS says is free, rather than a guess.
 *
 * This used to be `8000 + Math.floor(Math.random() * 1000)`. With one test run
 * that collides rarely; with several worktrees running `bun test` at once it is
 * a birthday problem, and it surfaces as an intermittent failure in a slice
 * that changed nothing — the worst thing to hand a reviewer, because it makes
 * them distrust their own verification. Bind :0, read the port back, release
 * it. `tools/loan/tests/conftest.py::_free_port` does the same thing.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  // `Server.port` is `number | undefined` in bun-types 1.4: a server listening
  // on a unix socket has no port. This one asked for TCP `:0`, so the branch
  // should be unreachable — but `port!` would hand `PORT=undefined` to the
  // child and surface twenty seconds later as "idp did not come up", which
  // says nothing about the cause. Fail here, where the cause is.
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

/** `oauth-client --json`, with the exit status asserted rather than assumed. */
async function runCredentialsScript(...args: string[]): Promise<Credentials> {
  const { code, out, err } = await runScript("oauth-client.ts", "--json", ...args);
  expect(err).toBe("");
  expect(code).toBe(0);
  return JSON.parse(out) as Credentials;
}

/** Mints a new secret under the same client id and makes it the live one. */
async function rotateCredentials(): Promise<Credentials> {
  const rotated = await runCredentialsScript("--rotate");
  expect(rotated.client_secret).toBeTruthy();
  creds = rotated;
  return rotated;
}

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
      throw new Error(`idp did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`);
    }
    await Bun.sleep(50);
  }

  // The service created the client on the line above, so its secret is gone —
  // hashed storage, #70. Rotate once to get one the flow can use.
  await rotateCredentials();
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

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

function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const hash = new Bun.CryptoHasher("sha256").update(verifier).digest();
  const challenge = Buffer.from(hash).toString("base64url");
  return { verifier, challenge };
}

/**
 * `Authorization: Basic base64(client_id:client_secret)` — the header Arcade
 * sends, built the way RFC 6749 §2.3.1 says to: each half
 * `application/x-www-form-urlencoded` before the base64.
 *
 * Hand-rolled rather than imported from `@better-auth/core`, because the thing
 * under test is that a relying party which only read the RFC can authenticate
 * here. A helper shared with the server would agree with the server by
 * construction.
 */
function basicAuth(clientId: string, clientSecret: string): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${half(clientId)}:${half(clientSecret)}`).toString("base64")}`;
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: "state-" + crypto.randomUUID(),
    ...extra,
  });
  return `${baseUrl}/oauth2/authorize?${params}`;
}

/** Extracts the raw query string of the page the plugin redirected to. */
function queryOf(location: string): string {
  return new URL(location, baseUrl).search.slice(1);
}

/**
 * Walks one persona through the entire flow and returns the access token,
 * asserting every hop on the way. Used by several tests, so the assertions
 * that make it up are here rather than duplicated.
 */
async function authorizeAs(
  browser: Browser,
  creds: Credentials,
  persona: { email: string; password: string; name: string },
  { expectConsent }: { expectConsent: boolean },
): Promise<{ accessToken: string; refreshToken: string | undefined; idToken: string | undefined }> {
  const { verifier, challenge } = pkce();
  const state = "state-" + crypto.randomUUID();

  // 1. Authorize. No session: the plugin sends the browser to the login page
  //    with the whole request signed into the query.
  const authorize = await browser.fetch(
    authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256", state }),
  );
  let location = authorize.headers.get("location") ?? "";

  if (location.startsWith("/login") || location.startsWith(`${baseUrl}/login`)) {
    // 2. The login page renders and names the client.
    const loginPage = await browser.fetch(new URL(location, baseUrl).toString());
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("Sign in");
    expect(loginHtml).toContain("Arcade");
    expect(loginHtml).toContain('name="oauth_query"');

    // 3. Submit the form. The session cookie is set and the plugin resumes
    //    the authorize flow — on to consent, or back to the client.
    const login = await browser.submit(`${baseUrl}/login`, {
      email: persona.email,
      password: persona.password,
      oauth_query: queryOf(location),
    });
    expect(login.status).toBe(303);
    location = login.headers.get("location") ?? "";
  }

  if (expectConsent) {
    expect(location).toMatch(/^(\S*\/)?consent\?/);

    // 4. The consent page shows who is signing in and what is asked for.
    const consentPage = await browser.fetch(new URL(location, baseUrl).toString());
    expect(consentPage.status).toBe(200);
    const consentHtml = await consentPage.text();
    expect(consentHtml).toContain(persona.name);
    expect(consentHtml).toContain(persona.email);
    expect(consentHtml).toContain("Arcade");
    for (const scope of ["openid", "profile", "email", "offline_access"]) {
      expect(consentHtml).toContain(`<code>${scope}</code>`);
    }

    // 5. Allow.
    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "allow",
      oauth_query: queryOf(location),
    });
    expect(consent.status).toBe(303);
    location = consent.headers.get("location") ?? "";
  }

  // 6. Back at the client with a code.
  const callback = new URL(location);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(baseUrl);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  // 7. Exchange it, the way Arcade does: HTTP Basic, form-encoded body. Since
  //    #61 this is the only form the client is registered for — the post form
  //    is refused before the secret is looked at.
  const token = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(creds.client_id, creds.client_secret!),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as {
    access_token: string;
    token_type: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };
  expect(tokens.token_type.toLowerCase()).toBe("bearer");
  expect(tokens.access_token).toBeTruthy();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
  };
}

/**
 * Walks a persona to a **real, unused authorization code** and returns it with
 * its verifier, stopping short of the token endpoint.
 *
 * Needed because the `authorization_code` grant validates in this order,
 * measured in `introspect-C6P1zrTr.mjs:1975..1982`: the code is looked up and
 * **consumed** first, the client is authenticated second. So a token request
 * carrying a made-up code never reaches the client checks at all — it comes
 * back `invalid_grant: invalid code`, whatever the credentials were. Any test
 * about *who the client is* has to spend a genuine code to get there, and one
 * code per attempt, since the failing attempt burns it.
 *
 * That ordering is also why a wrong auth method is so quiet in production:
 * Arcade sends a real code, so it does reach the check — but anyone
 * reproducing the failure by hand with a placeholder code sees a different
 * error and concludes something else is wrong.
 */
async function mintCode(persona: { email: string; password: string }): Promise<{
  code: string;
  verifier: string;
}> {
  const browser = new Browser();
  const { verifier, challenge } = pkce();

  const authorize = await browser.fetch(
    authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
  );
  let location = authorize.headers.get("location") ?? "";

  if (/\/login(\?|$)/.test(location)) {
    const login = await browser.submit(`${baseUrl}/login`, {
      email: persona.email,
      password: persona.password,
      oauth_query: queryOf(location),
    });
    expect(login.status).toBe(303);
    location = login.headers.get("location") ?? "";
  }
  if (/\/consent\?/.test(location)) {
    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "allow",
      oauth_query: queryOf(location),
    });
    expect(consent.status).toBe(303);
    location = consent.headers.get("location") ?? "";
  }

  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

/** One entry of the published key set. RSA public halves only — see the test. */
interface PublicJwk {
  kty: string;
  alg: string;
  kid: string;
  n: string;
  e: string;
  [member: string]: unknown;
}

/** The published key set, as an Arcade User Source would fetch it (#65). */
async function jwksKeys(): Promise<PublicJwk[]> {
  const discovery = (await (await fetch(`${baseUrl}/.well-known/openid-configuration`)).json()) as {
    jwks_uri?: string;
  };
  expect(discovery.jwks_uri).toBeTruthy();

  const response = await fetch(discovery.jwks_uri!);
  expect(response.status).toBe(200);
  return ((await response.json()) as { keys: PublicJwk[] }).keys;
}

/**
 * Verifies an ID token against the published key set and returns its claims.
 *
 * Hand-rolled on WebCrypto rather than handed to a JWT library, because the
 * thing under test is exactly "a relying party that only has `jwks_uri` can
 * check this signature". A library that fetched, selected and verified for us
 * would pass on an IdP that published the wrong key just as happily, so long
 * as the library also signed it.
 */
async function verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
  const [rawHeader, rawPayload, rawSignature] = idToken.split(".");
  expect(rawSignature).toBeTruthy();

  const header = JSON.parse(Buffer.from(rawHeader!, "base64url").toString()) as {
    alg: string;
    kid: string;
  };
  expect(header.alg).toBe("RS256");

  const jwk = (await jwksKeys()).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error(`no key in the JWKS with kid ${header.kid}`);

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(rawSignature!, "base64url"),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  expect(verified).toBe(true);

  return JSON.parse(Buffer.from(rawPayload!, "base64url").toString()) as Record<string, unknown>;
}

async function userinfo(accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("the fixture's port probe", () => {
  // The whole fixture rests on this: `beforeAll` takes a port from `freePort`
  // and hands it to a child process. A probe that returned a port nobody can
  // bind would fail as a twenty-second boot timeout in every test below, so
  // assert the property here, where it names itself.
  test("hands back a port the OS will actually let us bind", () => {
    const port = freePort();

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1024);

    // Free means free: the probe released it, so this can take it.
    const claim = Bun.serve({ port, fetch: () => new Response("ok") });
    try {
      expect(claim.port).toBe(port);
    } finally {
      claim.stop(true);
    }
  });
});

describe("health", () => {
  test("answers for Render's health check and names the endpoints", async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, any>;

    expect(body).toMatchObject({ status: "ok", service: "idp", people: 4, issuer: baseUrl });
    expect(body.oauth.authorize).toBe(`${baseUrl}/oauth2/authorize`);
    expect(body.oauth.token).toBe(`${baseUrl}/oauth2/token`);
    expect(body.oauth.userinfo).toBe(`${baseUrl}/oauth2/userinfo`);
    expect(body.oauth.jwks).toBe(`${baseUrl}/jwks`);
    expect(body.oauth.id_token_signing_alg).toBe("RS256");
  });

  test("says what happened to the client secret, so a rotation is not invisible", async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, any>;

    // This database was created by this test run, so the client was born here.
    expect(body.oauth.client_secret_state).toBe("created");
    expect(body.oauth.client_secret_note).toContain("--rotate");
    // Whatever the state, /health is not a place a secret may appear.
    expect(JSON.stringify(body)).not.toContain(creds.client_secret);
  });

  test("serves discovery at the root, which an Arcade User Source does read", async () => {
    const body = (await (await fetch(`${baseUrl}/.well-known/openid-configuration`)).json()) as Record<string, any>;

    expect(body).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth2/authorize`,
      token_endpoint: `${baseUrl}/oauth2/token`,
      userinfo_endpoint: `${baseUrl}/oauth2/userinfo`,
    });
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.token_endpoint_auth_methods_supported).toContain("client_secret_post");
  });

  test("the discovery document carries a jwks_uri, which is what #65 was refused for", async () => {
    const body = (await (await fetch(`${baseUrl}/.well-known/openid-configuration`)).json()) as Record<string, any>;

    // The exact sentence the Arcade User Source form answered with on #65:
    // "OIDC discovery document does not include a jwks_uri".
    expect(body.jwks_uri).toBe(`${baseUrl}/jwks`);
    expect(body.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(body.id_token_signing_alg_values_supported).not.toContain("HS256");
  });
});

describe("the key set", () => {
  test("jwks_uri returns at least one RS256 key with a kid", async () => {
    const keys = await jwksKeys();

    expect(keys.length).toBeGreaterThanOrEqual(1);
    const key = keys[0]!;
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.kid).toBeTruthy();
    expect(key.n).toBeTruthy();
    expect(key.e).toBe("AQAB");
  });

  test("publishes only public halves — the private key stays in idp.db", async () => {
    for (const key of await jwksKeys()) {
      // `d` is the RSA private exponent; `p`, `q` and `dp` are its factors.
      for (const secretMember of ["d", "p", "q", "dp", "dq", "qi"] as const) {
        expect(key[secretMember]).toBeUndefined();
      }
    }
  });
});

describe("the OAuth client", () => {
  test("the script prints the same client id every time, and never the same secret twice", async () => {
    const first = await runCredentialsScript();
    const second = await runCredentialsScript();

    expect(first.client_id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(second.client_id).toBe(first.client_id);
    expect(first.created).toBe(false);

    // The property #70 exists for: a later run cannot show the secret, and
    // says so rather than printing something that looks like one.
    expect(first.client_secret).toBeNull();
    expect(second.client_secret).toBeNull();
    expect(first.client_secret_state).toBe("unchanged");
    expect(first.client_secret_note).toContain("cannot be printed again");
    expect(first.client_secret_note).toContain("--rotate");
  });

  test("--rotate mints a new secret under the same client id", async () => {
    const before = creds;
    const rotated = await rotateCredentials();

    expect(rotated.client_id).toBe(before.client_id);
    expect(rotated.client_secret).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(rotated.client_secret).not.toBe(before.client_secret);
    expect(rotated.client_secret_state).toBe("rotated");
    expect(rotated.rotated).toBe(true);
    // A rotation must not cost the registration its other half.
    expect(rotated.redirect_uris ?? [REDIRECT_URI]).toEqual([REDIRECT_URI]);
  });

  test("the rotated secret works and the one it replaced does not", async () => {
    const stale = creds.client_secret;
    const rotated = await rotateCredentials();
    expect(rotated.client_secret).not.toBe(stale);

    // The new one completes a whole flow.
    const { accessToken } = await authorizeAs(new Browser(), rotated, morgan, { expectConsent: true });
    expect((await userinfo(accessToken)).email).toBe(morgan.email);

    // The old one is refused at the token endpoint. A rotation that left the
    // previous secret working would be a rotation in name only.
    //
    // A real code, because the grant consumes the code before it authenticates
    // the client (see `mintCode`): with a placeholder this would come back
    // `invalid_grant` without the stale secret ever being looked at, and pass.
    const { code, verifier } = await mintCode(morgan);
    const refused = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(rotated.client_id, stale!),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(refused.status).toBe(401);
    const body = (await refused.json()) as {
      error: string;
      error_description?: string;
      access_token?: string;
    };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toBe("invalid client_secret");
    expect(body.access_token).toBeUndefined();
  });

  test("states the posture #13 has to match", async () => {
    expect(creds.pkce).toBe("S256");
    expect(creds.userinfo_email_jsonpath).toBe("$.email");
    expect(creds.jwks_url).toBe(`${baseUrl}/jwks`);
    // #61: the value a human types into the Arcade dashboard's "client
    // authentication" field, which is also that field's default.
    expect(creds.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  test("the script and the running service name the same auth method", async () => {
    // Two places a human reads it — `oauth-client` on a shell, `/health` over
    // the wire — and they are only useful if they cannot disagree.
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      oauth: { token_endpoint_auth_method: string };
    };
    expect(health.oauth.token_endpoint_auth_method).toBe(creds.token_endpoint_auth_method);
  });
});

describe("authorization-code flow", () => {
  test("authorize → login → consent → code → token → userinfo, as Alice", async () => {
    const browser = new Browser();

    const { accessToken, refreshToken } = await authorizeAs(browser, creds, dana, { expectConsent: true });
    expect(refreshToken).toBeTruthy();

    // The claim Arcade is configured to extract with `$.email`.
    const claims = await userinfo(accessToken);
    expect(claims.email).toBe(dana.email);
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe(dana.name);
    expect(typeof claims.sub).toBe("string");
  });

  test("a second authorize in the same session skips login and consent", async () => {
    const browser = new Browser();

    await authorizeAs(browser, creds, riley, { expectConsent: true });
    const { accessToken } = await authorizeAs(browser, creds, riley, { expectConsent: false });

    expect((await userinfo(accessToken)).email).toBe(riley.email);
  });

  test("each persona is their own subject", async () => {

    const danaToken = await authorizeAs(new Browser(), creds, dana, { expectConsent: false });
    const rileyToken = await authorizeAs(new Browser(), creds, riley, { expectConsent: false });

    const [a, b] = await Promise.all([userinfo(danaToken.accessToken), userinfo(rileyToken.accessToken)]);
    expect(a.email).toBe(dana.email);
    expect(b.email).toBe(riley.email);
    expect(a.sub).not.toBe(b.sub);
  });

  test("a wrong password stays on the login page with an error", async () => {
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: "not-it",
      oauth_query: queryOf(authorize.headers.get("location")!),
    });

    expect(login.status).toBe(401);
    const html = await login.text();
    expect(html).toContain("did not match");
    expect(html).toContain(dana.email);
  });

  test("a tampered or expired sign-in request is not reported as a wrong password", async () => {
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
    );
    // A query older than ten minutes fails the same signature check as one
    // with a flipped character; the latter is the one a test can produce.
    const stale = queryOf(authorize.headers.get("location")!).replace(/sig=./, (m) =>
      m.endsWith("A") ? "sig=B" : "sig=A",
    );
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: stale,
    });

    expect(login.status).toBe(401);
    const html = await login.text();
    expect(html).toContain("expired");
    expect(html).toContain("start again");
    expect(html).not.toContain("did not match");
  });

  test("denying consent sends the client an access_denied error, not a code", async () => {
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, {
        code_challenge: challenge,
        code_challenge_method: "S256",
        // Force the consent screen even though the session may have consented.
        prompt: "consent",
      }),
    );
    let location = authorize.headers.get("location")!;
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: queryOf(location),
    });
    location = login.headers.get("location")!;
    expect(location).toMatch(/consent\?/);

    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "deny",
      oauth_query: queryOf(location),
    });
    const callback = new URL(consent.headers.get("location")!);

    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  test("the consent page without a session goes to login", async () => {
    const response = await new Browser().fetch(`${baseUrl}/consent?client_id=x&scope=openid`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login?client_id=x");
  });
});

describe("the ID token", () => {
  test("verifies against a key fetched from jwks_uri, as Arcade will verify it", async () => {
    const { idToken } = await authorizeAs(new Browser(), creds, dana, { expectConsent: false });
    expect(idToken).toBeTruthy();

    // Throws or fails inside if the signature does not check out.
    const claims = await verifyIdToken(idToken!);

    // Arcade requires the issuer to match the one configured on the User
    // Source exactly, and identifies the person by a subject claim (#65).
    expect(claims.iss).toBe(baseUrl);
    expect(claims.aud).toBe(creds.client_id);
    expect(claims.email).toBe(dana.email);
    expect(typeof claims.sub).toBe("string");
  });

  test("carries the email claim, byte-equal to what userinfo returns", async () => {
    // The claim an Arcade User Source is configured to read as the subject
    // (#65 step 2). Without it the subject is `sub`, an opaque uuid, and the
    // Arcade user_id stops being the string `governance.db` and `loans.db`
    // hold — DESIGN.md's identity rule 3, open risk 4.
    const { accessToken, idToken } = await authorizeAs(new Browser(), creds, riley, {
      expectConsent: false,
    });

    const claims = await verifyIdToken(idToken!);
    const fromUserinfo = await userinfo(accessToken);

    expect(claims.email).toBe(riley.email);
    expect(claims.email).toBe(fromUserinfo.email);
    expect(claims.email_verified).toBe(true);
    // Lowercase, in both places, whatever case the persona was configured
    // under (#58). The join key is compared byte-for-byte in three services.
    expect(claims.email).toBe(String(claims.email).toLowerCase());
  });

  test("the email scope is what puts the claim there", async () => {
    const supported = (await (await fetch(`${baseUrl}/.well-known/openid-configuration`)).json()) as {
      claims_supported?: string[];
      scopes_supported?: string[];
    };

    expect(supported.scopes_supported).toContain("email");
    expect(supported.claims_supported).toContain("email");
  });

  test("a tampered payload fails the same check", async () => {
    const { idToken } = await authorizeAs(new Browser(), creds, riley, { expectConsent: false });
    const [header, payload, signature] = idToken!.split(".");

    // Re-encode the claims with someone else's address. This is the whole
    // reason Arcade wants a JWKS: without a signature check, `email` is just
    // a string anybody in the path could have written.
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    claims.email = dana.email;
    const forged = [
      header,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      signature,
    ].join(".");

    await expect(verifyIdToken(forged)).rejects.toThrow();
  });
});

/**
 * `apps/loan-app` derives the actor from the bearer token by presenting it to
 * `/oauth2/userinfo` (`apps/loan-app/src/actor.ts`) — it never parses the
 * token. Enabling the JWT plugin could have changed the access token's form
 * under it, so the contract is asserted here, on the service that changed,
 * over the wire. `apps/loan-app` itself is untouched by #70.
 */
describe("what apps/loan-app depends on", () => {
  test("userinfo accepts the access token the token endpoint issued", async () => {
    const { accessToken } = await authorizeAs(new Browser(), creds, dana, { expectConsent: false });

    // Exactly what `actorFromRequest` does: bearer header, read `email`.
    const response = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { email: string }).email).toBe(dana.email);
  });

  test("access tokens are still opaque, so nothing downstream started reading claims", async () => {
    const { accessToken } = await authorizeAs(new Browser(), creds, riley, { expectConsent: false });

    // Access tokens become JWTs only for a registered `oauthResource`, and
    // this service registers none. Recorded as an assertion rather than a
    // comment: if a later change makes them JWTs, whoever makes it should
    // find out here and not from a resource server that started trusting a
    // claim it used to look up.
    expect(accessToken.split(".")).toHaveLength(1);

    // Basic here too: the registered auth method governs every endpoint that
    // authenticates the client, not just `/oauth2/token` (#61).
    const introspect = await fetch(`${baseUrl}/oauth2/introspect`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    expect(introspect.status).toBe(200);
    expect(((await introspect.json()) as { active: boolean }).active).toBe(true);
  });
});

describe("PKCE is required", () => {
  test("authorize without a code_challenge does not issue a code", async () => {
    const response = await new Browser().fetch(authorizeUrl(creds.client_id));

    // Either an error redirect back to the client or a 4xx; never a login page
    // that would end in a code.
    const location = response.headers.get("location") ?? "";
    expect(location).not.toMatch(/\/login/);
    if (location) {
      const url = new URL(location, baseUrl);
      expect(url.searchParams.get("code")).toBeNull();
      expect(url.searchParams.get("error")).toBeTruthy();
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("the token endpoint refuses a code without its verifier", async () => {
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
    );
    let location = authorize.headers.get("location")!;
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: queryOf(location),
    });
    location = login.headers.get("location")!;
    if (/consent\?/.test(location)) {
      location = (
        await browser.submit(`${baseUrl}/consent`, { decision: "allow", oauth_query: queryOf(location) })
      ).headers.get("location")!;
    }
    const code = new URL(location).searchParams.get("code")!;

    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    expect(token.status).toBe(400);
  });

  test("a wrong client secret is refused", async () => {
    // Real code, wrong secret. With a placeholder code the grant fails at the
    // code and returns before the secret is ever checked — the assertion would
    // hold and mean nothing.
    const { code, verifier } = await mintCode(dana);

    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, "wrong"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    expect(token.status).toBe(401);
    const body = (await token.json()) as {
      error: string;
      error_description?: string;
      access_token?: string;
    };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toBe("invalid client_secret");
    expect(body.access_token).toBeUndefined();
  });
});

/**
 * #61. Better Auth registers **one** token-endpoint auth method per client and
 * checks it before it checks the secret, so "which one" is not a preference —
 * the other form is refused outright, and refused in a way that says nothing
 * about the credentials.
 */
describe("client authentication at the token endpoint", () => {
  test("Authorization: Basic completes a whole flow", async () => {
    // `authorizeAs` exchanges the code with `Authorization: Basic` and nothing
    // else, so a flow that reaches userinfo is the measurement. Charlie consented
    // to this client in an earlier test and the record outlives a cookie jar,
    // so this browser logs in and goes straight back with a code.
    const { accessToken } = await authorizeAs(new Browser(), creds, riley, { expectConsent: false });
    expect((await userinfo(accessToken)).email).toBe(riley.email);
  });

  test("the post form is refused, and the refusal names the mismatch", async () => {
    // Credentials in the body: correct id, correct secret, correct code,
    // correct verifier — only the method is wrong. This is the shape #61
    // believes the live cg-demo-us failure had, inverted.
    const { code, verifier } = await mintCode(dana);

    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: creds.client_id,
        client_secret: creds.client_secret!,
        code_verifier: verifier,
      }),
    });

    expect(token.status).toBe(400);
    const body = (await token.json()) as {
      error: string;
      error_description?: string;
      access_token?: string;
    };
    expect(body.error).toBe("invalid_client");
    // The measurement that settles "one method or both": the plugin rejects on
    // the registered method alone, with a correct secret in hand.
    expect(body.error_description).toBe(
      "client registered for client_secret_basic cannot use client_secret_post",
    );
    expect(body.access_token).toBeUndefined();
  });

  test("so does a bare client_id with no credentials at all", async () => {
    const { code, verifier } = await mintCode(dana);

    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: creds.client_id,
        code_verifier: verifier,
      }),
    });

    expect(token.status).toBe(400);
    const body = (await token.json()) as { error: string; error_description?: string };
    expect(body.error).toBe("invalid_client");
    // Classified `none` — a public client — which this one is not.
    expect(body.error_description).toBe(
      "client registered for client_secret_basic cannot use none",
    );
  });
});

/**
 * #61, and the reason #75 could not answer its own question: a wrong secret and
 * a client registered for the other auth method both come back
 * `invalid_client`, and this service used to log only its boot lines. So the
 * distinguishing fact is written down, once per rejection.
 */
describe("the token endpoint says why it refused", () => {
  const rejection = /POST \/oauth2\/token rejected:/;

  test("a wrong secret over Basic leaves a line naming the method and the reason", async () => {
    const { code, verifier } = await mintCode(dana);
    const from = await logLength();

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, "definitely-not-the-secret"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(response.status).toBe(401);

    const line = await waitForLogLine(/client_auth="client_secret_basic"/, from);
    expect(line).toMatch(rejection);
    expect(line).toContain("status=401");
    expect(line).toContain("error=invalid_client");
    expect(line).toContain('error_description="invalid client_secret"');
    // It was our client, with the wrong secret — not a different registration.
    expect(line).toContain(`client_id=${creds.client_id}`);
  });

  test("a wrong auth method leaves a different line, which is the whole point", async () => {
    const { code, verifier } = await mintCode(dana);
    const from = await logLength();

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: creds.client_id,
        client_secret: creds.client_secret!,
        code_verifier: verifier,
      }),
    });
    expect(response.status).toBe(400);

    const line = await waitForLogLine(/client_auth="client_secret_post"/, from);
    expect(line).toMatch(rejection);
    expect(line).toContain("status=400");
    expect(line).toContain("error=invalid_client");
    expect(line).toContain(
      'error_description="client registered for client_secret_basic cannot use client_secret_post"',
    );
    expect(line).toContain(`client_id=${creds.client_id}`);

    // The two cases are distinguishable from the log alone. That sentence is
    // the acceptance criterion; this is it as an assertion.
    expect(line).not.toContain("client_auth=\"client_secret_basic\"");
  });

  test("an unknown client is reported as unknown, not echoed back", async () => {
    // The id is attacker-controlled and, under Basic, shares a base64 blob
    // with the secret. So it is compared, never printed.
    const { code, verifier } = await mintCode(dana);
    const from = await logLength();

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth("someone-elses-client-id", "someone-elses-secret"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    const line = await waitForLogLine(/rejected:.*client_id=\(not the registered client\)/, from);
    expect(line).toMatch(rejection);

    // Not just the rejection line: since #100 every token request also leaves a
    // census line carrying a client id, and "never echoed" has to hold for the
    // whole log or it does not hold at all.
    const written = (await Bun.file(logPath).text()).slice(from);
    expect(written).toContain("client_id=(not the registered client)");
    expect(written).not.toContain("someone-elses-client-id");
    expect(written).not.toContain("someone-elses-secret");
  });

  test("a token request that succeeds is never reported as a rejection", async () => {
    const before = (await Bun.file(logPath).text()).split("\n").filter((l) => rejection.test(l)).length;

    const { accessToken } = await authorizeAs(new Browser(), creds, dana, { expectConsent: false });
    expect(accessToken).toBeTruthy();

    // Round 2 of #100 added a census line to every token request, successes
    // included, so this is no longer "logs nothing" — it is that the *rejection*
    // vocabulary stays reserved for rejections. A success that tripped this
    // counter would put a `rejected:` line under a working demo and send the
    // next reader of this log somewhere there is no bug.
    await Bun.sleep(250);
    const after = (await Bun.file(logPath).text()).split("\n").filter((l) => rejection.test(l)).length;
    expect(after).toBe(before);
  });
});

/**
 * #100 — the replayed code, which is the expensive rejection.
 *
 * Better Auth answers a code it has never seen and a code it redeemed a moment
 * ago with the same `invalid_grant "invalid code"`. The second one is not just a
 * refusal: `checkVerificationValue` calls
 * `revokeTokensIssuedForAuthorizationCode` on the way out, so the replay deletes
 * the tokens the *first*, successful exchange minted. The relying party keeps a
 * grant that has been emptied, and the failure resurfaces somewhere else — here,
 * `apps/loan-app` getting a 401 from `/oauth2/userinfo`.
 *
 * Two rejections 216 ms apart in this log are what #100 actually looked like,
 * and neither said which kind it was. These tests are about the field that now
 * does.
 */
describe("a replayed authorization code is named as one", () => {
  const rejection = /POST \/oauth2\/token rejected:/;

  /** The exchange Arcade makes, byte for byte: Basic, form body, PKCE verifier. */
  async function exchange(code: string, verifier: string): Promise<Response> {
    return fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  }

  test("the second exchange of a real code is logged as already_consumed", async () => {
    const { code, verifier } = await mintCode(riley);

    const first = await exchange(code, verifier);
    expect(first.status).toBe(200);

    const from = await logLength();
    const second = await exchange(code, verifier);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "invalid code",
    });

    const line = await waitForLogLine(/code=already_consumed/, from);
    expect(line).toMatch(rejection);
    expect(line).toContain("error=invalid_grant");
    expect(line).toContain('error_description="invalid code"');
    expect(line).toContain(`client_id=${creds.client_id}`);
    // The code itself is never printed: it is a credential until it is spent,
    // and this line is written the moment somebody else may be holding it.
    expect(line).not.toContain(code);

    // And the consequence, on its own line. Before round 2 of #100 this said
    // the tokens had just been revoked; it now says they were kept, which is
    // the behaviour change this slice is.
    const consequence = await waitForLogLine(/had already been exchanged/, from);
    expect(consequence).toContain("were kept");
    expect(consequence).toContain("still works");
  });

  test("a code this service never issued is logged as unknown, not as a replay", async () => {
    const from = await logLength();

    const response = await exchange(`not-a-code-${crypto.randomUUID()}`, pkce().verifier);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "invalid code",
    });

    const line = await waitForLogLine(/code=unknown/, from);
    expect(line).toMatch(rejection);
    expect(line).toContain('error_description="invalid code"');
    // The distinction is the deliverable. Same four words on the wire, two
    // different lines here.
    expect(line).not.toContain("already_consumed");
  });

  test("the replay refuses, and the first exchange's tokens survive it", async () => {
    // The slice, as one assertion. Until round 2 of #100 the last hop of this
    // test was a 401: `checkVerificationValue` called
    // `revokeTokensIssuedForAuthorizationCode` on the way to its refusal and
    // deleted the tokens the *first* exchange minted, so a duplicate nobody
    // asked for killed a working grant. The refusal below is unchanged; the
    // collateral is gone.
    const { code, verifier } = await mintCode(morgan);

    const first = await exchange(code, verifier);
    expect(first.status).toBe(200);
    const { access_token, refresh_token } = (await first.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(refresh_token).toBeTruthy();

    const working = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(working.status).toBe(200);
    const identity = (await working.json()) as { email: string };
    expect(identity.email).toBe(morgan.email.toLowerCase());

    // Still `invalid_grant`. A replayed code is still refused — this slice does
    // not make the second exchange succeed, which would be a far worse bug than
    // the one it fixes.
    const replay = await exchange(code, verifier);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "invalid code",
    });

    // The same token, the same endpoint, one replay later. This is the 401 that
    // `apps/loan-app` turned into "The identity provider rejected the token."
    // on 2026-09-14, and it must not happen again.
    const alive = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(alive.status).toBe(200);
    expect(((await alive.json()) as { email: string }).email).toBe(morgan.email.toLowerCase());

    // The refresh token the same exchange minted is a separate row, deleted by
    // the same revocation, and the one Arcade actually leans on when the access
    // token ages out. Asserted by using it, not by reading the table.
    const refreshed = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh_token! }),
    });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()) as { access_token: string }).toHaveProperty("access_token");
  });

  test("a revocation somebody actually asked for still deletes tokens", async () => {
    // The dangerous way to fix #100 is a guard that is too wide. "Never delete
    // an `oauthAccessToken` row" would stop the replay *and* disarm every real
    // revocation, and a token that cannot be revoked is a worse bug than the one
    // being fixed. So the guard keys on the one `deleteMany` shape the replay
    // path uses — a lone `authorizationCodeId` equality — and this test stands
    // on the other side of that line.
    //
    // Revoking the **refresh** token is what exercises it: `revokeRefreshToken`
    // marks the refresh row revoked and then issues
    // `deleteMany({ model: "oauthAccessToken", where: [{ field: "refreshId" }] })`
    // (`authorize-BmTe2VYG.mjs:3539`) — the same guarded model, a different
    // where-shape, which must pass straight through. Revoking the access token
    // instead would not reach `deleteMany` at all, and the test would pass
    // whatever the guard did.
    const { accessToken, refreshToken } = await authorizeAs(new Browser(), creds, sam, {
      expectConsent: true,
    });
    expect(refreshToken).toBeTruthy();

    const before = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.status).toBe(200);

    const revoke = await fetch(`${baseUrl}/oauth2/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
      },
      body: new URLSearchParams({
        token: refreshToken!,
        token_type_hint: "refresh_token",
      }),
    });
    expect(revoke.status).toBe(200);

    // The access token the same exchange minted is gone with it. If this is a
    // 200, the guard is swallowing a revocation a client asked for.
    const after = await fetch(`${baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.status).toBe(401);
  });

  test("the guard says so, rather than silently matching nothing", async () => {
    // A control that does nothing looks exactly like a control that permits.
    // The refused revocation is a database call that did not happen, so the
    // only evidence it was ever reached is the line it writes.
    const { code, verifier } = await mintCode(riley);
    expect((await exchange(code, verifier)).status).toBe(200);

    const from = await logLength();
    expect((await exchange(code, verifier)).status).toBe(400);

    const blocked = await waitForLogLine(/replay revocation refused/, from);
    expect(blocked).toContain("oauthAccessToken");
    // The line names how many rows it kept, and the count is what makes it a
    // claim about this request rather than a slogan printed on every match.
    expect(blocked).toMatch(/kept [1-9]\d* oauthAccessToken row/);
    // Both models the plugin tries to sweep, not just the first.
    await waitForLogLine(/replay revocation refused.*oauthRefreshToken/, from);
  });

  test("an unknown code is not reported as a kept replay", async () => {
    // Review round 1 on PR #127. `checkVerificationValue` reaches
    // `revokeTokensIssuedForAuthorizationCode` for *any* code it cannot consume,
    // so a code this service never issued took the same path and the guard
    // announced that it had kept "the rows the first exchange of that code
    // minted" — for a code that never had a first exchange and has no rows at
    // all. The census said `code_state=unknown` two lines later, so the log
    // contradicted itself about the same request.
    const from = await logLength();

    const response = await exchange(`not-a-code-${crypto.randomUUID()}`, pkce().verifier);
    expect(response.status).toBe(400);

    // Waiting for the census line is what makes the absence below a fact rather
    // than a race: the guard runs inside the handler and the census is written
    // after it returns, so if a `replay revocation refused` line were coming for
    // this request, it would already be on disk by now.
    const line = await waitForLogLine(/POST \/oauth2\/token at=.*code_state=unknown/, from);
    expect(line).toContain("outcome=invalid_grant");

    const written = (await Bun.file(logPath).text()).slice(from);
    expect(written).not.toContain("replay revocation refused");
    expect(written).not.toContain("had already been exchanged");
  });

  test("a rejection that is not about the code carries no code field", async () => {
    // `code=` would be noise on every wrong-secret line and would send a reader
    // looking at the authorization leg for a problem that is in the credential.
    const { code, verifier } = await mintCode(dana);
    const from = await logLength();

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, "definitely-not-the-secret"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(response.status).toBe(401);

    const line = await waitForLogLine(/error=invalid_client/, from);
    expect(line).not.toContain("code=");
  });
});

/**
 * #100 round 2 — the census line, which is what makes a double exchange
 * countable instead of inferable.
 *
 * The first round could only say "something is fetching the authorization
 * callback twice", because this service logged rejections and nothing else: the
 * successful first exchange left no trace, so two hits looked like one rejection
 * with no partner, and the caller behind either was never named. On Render at
 * 21:05:28Z the missing half was the whole answer — cg-web's single `next_uri`
 * fetch was already in *its* log, and the 290 ms gap to cg-idp's rejection could
 * not be attributed to anyone.
 *
 * So every request leaves one line carrying when, which grant, which code, what
 * happened, who asked and from where.
 */
describe("every token request leaves a line, successes included", () => {
  const census = /POST \/oauth2\/token at=/;

  /** The census line a single request produced, found by its unique code prefix. */
  async function lineFor(prefix: string, from: number): Promise<string> {
    return waitForLogLine(new RegExp(`POST /oauth2/token at=.*code=${prefix}\\b`), from);
  }

  async function exchange(
    code: string,
    verifier: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
        ...headers,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  }

  test("a successful exchange is logged, with the caller attributed", async () => {
    const { code, verifier } = await mintCode(dana);
    const from = await logLength();

    const response = await exchange(code, verifier, {
      "user-agent": "arcade-engine/test",
      // Render's proxy appends, so the caller is the left-most entry and the
      // hops after it are infrastructure.
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    });
    expect(response.status).toBe(200);

    const line = await lineFor(code.slice(0, 8), from);
    expect(line).toContain("grant=authorization_code");
    expect(line).toContain("outcome=success");
    expect(line).toContain('ua="arcade-engine/test"');
    expect(line).toContain("ip=203.0.113.7");
    // The hop Render added is not the caller, and printing it would put the
    // same value on every line and attribute nothing.
    expect(line).not.toContain("10.0.0.1");
    expect(line).toContain(`client_id=${creds.client_id}`);
  });

  test("the timestamp is millisecond UTC, so it lines up with cg-web's log", async () => {
    const { code, verifier } = await mintCode(riley);
    const from = await logLength();

    const before = Date.now();
    expect((await exchange(code, verifier)).status).toBe(200);
    const after = Date.now();

    const line = await lineFor(code.slice(0, 8), from);
    const at = /at=(\S+)/.exec(line)?.[1];
    // The exact shape cg-web prints, because the two logs are read side by side
    // and a reader should not be converting formats in their head.
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const parsed = Date.parse(at!);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  test("the code is identified by a prefix, never printed in full", async () => {
    const { code, verifier } = await mintCode(morgan);
    const from = await logLength();

    // Both hits of the same code, which is the pair #100 needed to count.
    expect((await exchange(code, verifier)).status).toBe(200);
    expect((await exchange(code, verifier)).status).toBe(400);

    await waitForLogLine(/outcome=invalid_grant/, from);
    await Bun.sleep(100);
    const written = (await Bun.file(logPath).text()).slice(from);
    const lines = written.split("\n").filter((l) => census.test(l));

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain(`code=${code.slice(0, 8)}`);
    expect(lines[0]).toContain("outcome=success");
    // The second hit is named as the replay it is, on the census line itself,
    // so counting and classifying do not need two different greps.
    expect(lines[1]).toContain("outcome=invalid_grant");
    expect(lines[1]).toContain("code_state=already_consumed");

    // A prefix is enough to pair two requests and not enough to spend a code.
    expect(written).not.toContain(code);
  });

  test("a refresh exchange is logged without leaking the refresh token", async () => {
    const { refreshToken } = await authorizeAs(new Browser(), creds, riley, {
      expectConsent: false,
    });
    expect(refreshToken).toBeTruthy();
    const from = await logLength();

    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(creds.client_id, creds.client_secret!),
        "user-agent": "arcade-engine/refresh",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken! }),
    });
    expect(response.status).toBe(200);

    const line = await waitForLogLine(/POST \/oauth2\/token at=.*grant=refresh_token/, from);
    expect(line).toContain("outcome=success");
    expect(line).toContain('ua="arcade-engine/refresh"');
    // No `code` parameter on this grant, and the refresh token is a long-lived
    // credential — eight characters of it would be eight more than belong in a
    // log file, so the field says so rather than improvising.
    expect(line).toContain("code=(none)");
    expect(line).not.toContain(refreshToken!.slice(0, 8));
  });

  test("a request with no proxy header and no user agent still leaves a line", async () => {
    // A local dev server and this test suite are both direct connections. The
    // fields are absent, so they read `(none)` — a line that silently dropped
    // them would be a different shape to parse on the one deployment where
    // somebody is debugging by eye.
    const from = await logLength();

    const response = await exchange(`not-a-code-${crypto.randomUUID()}`, pkce().verifier, {
      "user-agent": "",
    });
    expect(response.status).toBe(400);

    const line = await waitForLogLine(/POST \/oauth2\/token at=.*outcome=invalid_grant/, from);
    expect(line).toContain('ua="(none)"');
    expect(line).toContain("ip=(none)");
    expect(line).toContain("code_state=unknown");
  });
});

describe("reset does not rotate the OAuth client", () => {
  test("the credentials Arcade holds still complete a flow after scripts/reset", async () => {
    const before = creds;
    const keyBefore = await jwksKeys();

    // A session and a consent exist from the tests above. Reset wipes them.
    const reset = await runScript("reset.ts");
    expect(reset.err).toBe("");
    expect(reset.code).toBe(0);
    expect(reset.out).toContain(`OAuth client ${before.client_id} unchanged`);

    const after = await runCredentialsScript();
    expect(after.client_id).toBe(before.client_id);
    expect(after.created).toBe(false);
    // Nothing rotated: the stored hash still matches the secret Arcade holds,
    // which the flow at the end of this test proves by using it.
    expect(after.client_secret_state).toBe("unchanged");

    // The signing keys survive too. Clearing `jwks` would mint a new key pair
    // and an Arcade User Source holding the old key set would start rejecting
    // ID tokens — the same silent break as a rotated client, one layer down.
    expect(await jwksKeys()).toEqual(keyBefore);

    // The people are back to the fixture, and every earlier session is gone:
    // Alice has to log in and consent again, with the very same client.
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { people: number };
    expect(health.people).toBe(4);

    const { accessToken } = await authorizeAs(new Browser(), before, dana, { expectConsent: true });
    expect((await userinfo(accessToken)).email).toBe(dana.email);
  });
});

describe("the log", () => {
  // Last on purpose: by now the service has booted, served every flow above,
  // survived a reset and been asked for its credentials several times. If any
  // of that printed the secret, a `render logs` would have shown it.
  test("never carries the client secret, over the whole run", async () => {
    const logged = await Bun.file(logPath).text();

    expect(logged).toContain(creds.client_id);
    expect(logged).not.toContain(creds.client_secret);
  });

  test("the credentials script does not warn when the public URL is set", async () => {
    const { err } = await runScript("oauth-client.ts", "--json");
    expect(err).toBe("");
  });

  test("the credentials script warns when it would print localhost URLs", async () => {
    const { IDP_PUBLIC_URL: _dropped, ...withoutUrl } = env;
    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "oauth-client.ts"), "--json"], {
      env: withoutUrl,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Credentials still right, URLs flagged.
    expect((JSON.parse(out) as Credentials).client_id).toBe(creds.client_id);
    expect(err).toContain("warning");
    expect(err).toContain("IDP_PUBLIC_URL");
  });
});

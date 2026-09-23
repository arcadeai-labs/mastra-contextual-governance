#!/usr/bin/env bun
/**
 * Spike 05 — what `apps/idp` says at the token endpoint, per way of authenticating
 * the client, so a one-line failure in a Render log maps to a cause.
 *
 * Arcade's User Source exchanges the authorization code at our token endpoint and
 * reports only *"Token exchange with identity provider failed"* to the browser.
 * Two very different causes produce that: a **wrong client secret**, and a client
 * sending **`client_secret_basic`** to a client registered `client_secret_post`.
 * The first is fixed by re-entering a secret; the second is fixed by changing how
 * the client is registered (#61) and re-entering the secret will not help at all.
 *
 *   bun docs/spikes/evidence/05-token-auth-methods.ts
 *
 * **No credential, no environment, no network.** Round 1's reviewer could not run
 * this because it asked for `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET`, which nobody
 * outside the human has. So it now provides its own: it boots a throwaway
 * `apps/idp` on a port it binds as `:0` and reads back, over a scratch database in
 * a temp directory, mints that instance's OAuth client and keeps the secret the
 * creation prints, signs in as a **fixture** persona from the checked-in
 * `apps/idp/src/fixtures/people.json`, and deletes all of it afterwards. Nothing
 * it touches is live and nothing it needs is secret.
 *
 * The one prerequisite is `apps/idp`'s dependencies, which the root
 * `bun install` provides since #187. This script says so rather than failing
 * with a module-resolution error.
 *
 * Why a live IdP cannot answer this: it validates the authorization code **before**
 * the client, so a probe with a junk code returns `invalid_grant / invalid code`
 * whether it carries no secret, a wrong secret or Basic auth. Four real
 * single-use codes are the only way to see the difference.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jar, Transcript, driveAuthorize, b64url, pkce } from "./05-drive.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const IDP_DIR = join(REPO_ROOT, "apps", "idp");

/** A port this machine is not using, the way `tools/loan/tests/conftest.py::_free_port` does it. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function main() {
  if (!(await Bun.file(join(IDP_DIR, "node_modules", "better-auth", "package.json")).exists())) {
    console.error(
      "apps/idp's dependencies are not installed.\n" +
        "  Run `bun install` at the repo root; it covers apps/idp.",
    );
    process.exit(2);
  }

  const fixtures = (await Bun.file(join(IDP_DIR, "src", "fixtures", "people.json")).json()) as {
    people: { persona: string; email: string; password: string }[];
  };
  // Any seeded fixture persona will do; this one never touches a live service.
  const persona = fixtures.people[0];

  const idpPort = freePort();
  const issuer = `http://localhost:${idpPort}`;
  // Never fetched — `driveAuthorize` stops *on* the redirect URI and hands back the
  // query — but it has to be on the client's allowlist, so it has to be a real port
  // this machine could have bound.
  const redirectUri = `http://localhost:${freePort()}/callback`;
  const dbPath = join(tmpdir(), `cg-spike75-token-auth-${process.pid}-${Date.now()}.db`);

  const env = {
    ...process.env,
    PORT: String(idpPort),
    IDP_PUBLIC_URL: issuer,
    IDP_DB_PATH: dbPath,
    IDP_OAUTH_REDIRECT_URIS: redirectUri,
    NODE_ENV: "development",
  };

  console.log(`spike 05 — apps/idp token-endpoint client authentication`);
  console.log(`  throwaway IdP  ${issuer}   (port bound as :0 and read back)`);
  console.log(`  scratch db     ${dbPath}`);
  console.log(`  persona        ${persona.email}   (checked-in fixture, not a live address)\n`);

  // Creating the client is also the only moment its secret is legible: since #70
  // `apps/idp` stores it hashed. On a database that did not exist a second ago
  // this always creates, so it always prints.
  const mint = Bun.spawnSync(["bun", "scripts/oauth-client.ts", "--json"], { cwd: IDP_DIR, env });
  if (mint.exitCode !== 0) {
    console.error(`minting the OAuth client failed:\n${mint.stderr.toString()}`);
    process.exit(1);
  }
  const client = JSON.parse(mint.stdout.toString()) as {
    client_id: string;
    client_secret: string | null;
    created: boolean;
    token_endpoint_auth_method: string;
  };
  if (!client.client_secret) {
    console.error("the client already existed, so its secret is hashed and unreadable — scratch db collision?");
    process.exit(1);
  }
  console.log(
    `  client ${client.client_id}, registered ${client.token_endpoint_auth_method}, secret minted on creation\n`,
  );

  const idp = Bun.spawn(["bun", "src/index.ts"], { cwd: IDP_DIR, env, stdout: "pipe", stderr: "pipe" });
  try {
    await waitForHealth(issuer);
    const t = new Transcript();

    /** One complete login, for one single-use authorization code. */
    const freshCode = async () => {
      const { verifier, challenge } = await pkce();
      const authorizeUrl = `${issuer}/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: "openid email",
        state: b64url(crypto.getRandomValues(new Uint8Array(12))),
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`;
      const result = await driveAuthorize(authorizeUrl, redirectUri, persona, t, {
        trustedPageHosts: [new URL(issuer).host],
        jar: new Jar(),
      });
      if (!result.landedOn) throw new Error(`the login did not reach ${redirectUri}: ${result.stoppedBecause}`);
      const code = new URL(result.landedOn).searchParams.get("code");
      if (!code) throw new Error(`no code on the redirect: ${result.landedOn}`);
      return { code, verifier };
    };

    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const results: { label: string; status: number; body: string }[] = [];

    const attempt = async (label: string, build: (code: string, verifier: string) => RequestInit) => {
      const { code, verifier } = await freshCode();
      const res = await fetch(`${issuer}/oauth2/token`, build(code, verifier));
      const body = res.ok ? "(a token was issued)" : await res.text();
      results.push({ label, status: res.status, body });
    };

    await attempt("client_secret_post, correct secret — the configuration we have", (code, verifier) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret!,
        code_verifier: verifier,
      }),
    }));

    await attempt("client_secret_post, WRONG secret — a stale secret in the dashboard", (code, verifier) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: "not-the-secret-this-client-has",
        code_verifier: verifier,
      }),
    }));

    await attempt("client_secret_basic, correct secret — a relying party that prefers the header", (code, verifier) => ({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
      },
      body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
    }));

    await attempt("no client authentication at all — PKCE only, as a public client would", (code, verifier) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    }));

    console.log("\n══ four real single-use codes, four ways of authenticating the client ══\n");
    for (const r of results) console.log(`${r.label}\n  -> HTTP ${r.status} ${r.body}`);

    // The point of the whole script, asserted rather than left to the reader: if a
    // future Better Auth collapses these onto one status, the discriminator this
    // spike hands the human is wrong and they should find out here, not in a log.
    const [ok, wrongSecret, basic, none] = results;
    const expectations = [
      [ok.status === 200, `correct secret should issue a token, got ${ok.status}`],
      [wrongSecret.status === 400, `a wrong secret should be 400, got ${wrongSecret.status}`],
      [basic.status === 401, `client_secret_basic should be 401, got ${basic.status}`],
      [none.status === 400, `no authentication should be 400, got ${none.status}`],
      [
        wrongSecret.status !== basic.status,
        "a wrong secret and an auth-method mismatch must not share a status, or the Render log cannot tell them apart",
      ],
    ] as const;
    const broken = expectations.filter(([held]) => !held).map(([, why]) => why);
    if (broken.length) {
      console.error(`\n✗ the discriminator does not hold:\n${broken.map((b) => `  - ${b}`).join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "\n✓ the status code alone separates the two causes: 401 is an auth-method mismatch (#61 item 1)," +
        "\n  400 with a client_secret is a wrong secret, 200 means the exchange worked.",
    );
  } finally {
    idp.kill();
    await idp.exited;
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-journal`, { force: true });
  }
}

async function waitForHealth(issuer: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${issuer}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error(`the throwaway IdP never became healthy at ${issuer}/health`);
}

await main();

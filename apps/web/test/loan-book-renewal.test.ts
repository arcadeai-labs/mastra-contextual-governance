/**
 * The failure round 1 of #160's review found: a server render that spends a
 * rotating refresh token and has nowhere to put the replacement.
 *
 * `apps/idp` rotates, and the rotation is destructive to what the cookie still
 * holds. Measured here, in this order, because the order is the whole point:
 *
 *   1. a clean rotation leaves **both** access tokens working — the one in the
 *      cookie and the one just minted;
 *   2. replaying a refresh token that has already been redeemed answers
 *      `400 invalid_grant` **and revokes the grant family**, so the access
 *      token from step 1 stops working too.
 *
 * So a renewal whose result is dropped is not a wasted round trip. It arms the
 * next caller: the cookie still carries the spent refresh token, the next poll
 * presents it, and that replay kills a session that was working — first load
 * fine, second load reads as expired. `app/page.tsx` and `app/loans/page.tsx`
 * are server components and cannot set a cookie, so they are exactly the
 * callers that must not renew.
 *
 * Everything here is real: a real `apps/idp` subprocess, a real
 * authorization-code + PKCE flow asking for `offline_access`, a real
 * `apps/loan-app` with a real `loans.db`, and the real `readLoanBook`. A
 * counting proxy sits in front of the IdP so "the refresh token was not spent"
 * is a number this file reads back rather than a claim it makes.
 *
 * Every port is `:0` or taken from the OS.
 */
import { spawn, type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nonce, pkce } from "../lib/identity/oidc.ts";
import { readLoanBook } from "../lib/loan-context/read.ts";
import type { IdpToken, Session } from "../lib/identity/session.ts";
import { Browser, PEOPLE, startIdentityHarness, type IdentityHarness } from "./identity-harness.ts";
import { readPort } from "./harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

let identity: IdentityHarness;
let loanApp: Subprocess<"ignore", "pipe", "pipe">;
let loanAppHost: string;
let workspace: string;
/** Every `grant_type` the IdP's token endpoint was asked for, through the proxy. */
let grants: string[] = [];
let idpProxy: ReturnType<typeof Bun.serve>;
/** What `readLoanBook` is told the IdP is: the proxy, so its token calls are counted. */
let idpConfig: { issuer: string; clientId: string; clientSecret: string };

beforeAll(async () => {
  identity = await startIdentityHarness();
  workspace = join(tmpdir(), `cg-renewal-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });

  loanApp = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "loan-app", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      LOANS_DB_PATH: join(workspace, "loans.db"),
      // The loan book validates bearers against the IdP itself, not the proxy:
      // the proxy exists to count what `readLoanBook` asks for, and putting it
      // on this leg too would blur the two.
      IDP_PUBLIC_HOST: new URL(identity.idpUrl).host,
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"ignore", "pipe", "pipe">;
  const { port } = await readPort(loanApp);
  loanAppHost = `localhost:${port}`;

  idpProxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      if (url.pathname === "/oauth2/token" && body !== undefined) {
        grants.push(new URLSearchParams(body).get("grant_type") ?? "unknown");
      }
      return fetch(`${identity.idpUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      });
    },
  });

  idpConfig = {
    issuer: `http://localhost:${idpProxy.port}`,
    clientId: identity.config.identity.idpClientId,
    clientSecret: identity.config.identity.idpClientSecret,
  };
}, 90_000);

afterAll(async () => {
  idpProxy?.stop(true);
  loanApp?.kill();
  await loanApp?.exited;
  await identity?.stop();
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * A real grant that carries a refresh token.
 *
 * The ordinary sign-in cannot produce one: `IDP_SCOPES` defaults to
 * `openid email` and `apps/idp` issues no refresh token for it (measured
 * 2026-09-18). So this drives the same authorization-code + PKCE flow against
 * the same real IdP with `offline_access` added — which is exactly what a
 * deployment that sets `IDP_SCOPES=openid email offline_access` gets, and the
 * only configuration in which the renewal path exists at all.
 */
async function grantWithRefreshToken(persona: keyof typeof PEOPLE): Promise<IdpToken> {
  const person = PEOPLE[persona];
  const redirectUri = `${identity.webUrl}/api/auth/callback`;
  const { verifier, challenge } = await pkce();
  const state = nonce();
  const browser = new Browser();
  const landed = await browser.follow(
    `${identity.idpUrl}/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: identity.config.identity.idpClientId,
        redirect_uri: redirectUri,
        scope: "openid email offline_access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "login",
      }),
    (fields) => ({
      ...fields,
      ...(fields.email !== undefined ? { email: person.email, password: person.password } : {}),
      ...(fields.decision !== undefined ? { decision: "allow" } : {}),
    }),
    { stopAt: "/api/auth/callback" },
  );
  const code = new URL(landed.url).searchParams.get("code");
  if (code === null) throw new Error(`no authorization code for ${persona}; landed at ${landed.url}`);

  const response = await fetch(`${identity.idpUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(
        `${identity.config.identity.idpClientId}:${identity.config.identity.idpClientSecret}`,
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: identity.config.identity.idpClientId,
      code_verifier: verifier,
    }).toString(),
  });
  const token = (await response.json()) as { access_token: string; refresh_token?: string };
  if (token.refresh_token === undefined) {
    throw new Error("apps/idp issued no refresh token for `openid email offline_access`");
  }
  return { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: 0 };
}

/**
 * A session whose bearer is past the renewal margin.
 *
 * `expires_at: 0` rather than a real expiry: the access token itself is live —
 * the IdP minted it seconds ago — and what is stale is *this service's note
 * about it*. That is the condition the bug needs, and it is also the honest
 * one, because `expires_at` is the only thing `readLoanBook` can look at
 * without asking somebody.
 */
function sessionWith(token: IdpToken, email: string): Session {
  return { email, signed_in_at: Date.now() - 3_600_000, idp: token };
}

function read(session: Session, options: { onRenewed?: (next: Session) => void } = {}) {
  return readLoanBook(session, { host: loanAppHost, idp: idpConfig, ...options });
}

describe("a server render, which cannot store a renewed token", () => {
  /**
   * The reviewer's reproduction, as a test.
   *
   * Before the fix: the first read renewed, spending the cookie's refresh
   * token and dropping the replacement; the second presented the spent one,
   * the IdP answered `invalid_grant`, and the read came back `expired` —
   * "first load works, second load reads as expired". After it, neither read
   * touches the token endpoint at all.
   */
  test("two loads in a row both work, and neither spends the refresh token", async () => {
    const token = await grantWithRefreshToken("dana");
    const session = sessionWith(token, PEOPLE.dana.email);
    grants = [];

    const first = await read(session);
    const second = await read(session);

    expect(first.status).toBe("loaded");
    expect(second.status).toBe("loaded");
    // The number, not the narrative: the token endpoint was never asked.
    expect(grants).toEqual([]);
  }, 60_000);

  /**
   * And the token in the cookie is still spendable afterwards.
   *
   * The sharpest form of the claim: a route handler renewing *after* two server
   * renders has to succeed. Before the fix this is where the damage surfaced —
   * the refresh token had already been redeemed, so this call was a replay, it
   * answered `400 invalid_grant`, and it revoked the grant family on its way
   * out.
   */
  test("a route can still renew afterwards, and hands back a session to reseal", async () => {
    const token = await grantWithRefreshToken("dana");
    const session = sessionWith(token, PEOPLE.dana.email);
    await read(session);
    await read(session);

    grants = [];
    const resealed: Session[] = [];
    const routed = await read(session, { onRenewed: (next) => resealed.push(next) });

    expect(routed.status).toBe("loaded");
    expect(grants).toEqual(["refresh_token"]);
    const stored = resealed[0]?.idp;
    expect(stored).toBeDefined();
    expect(stored?.access_token).not.toBe(token.access_token);
    // Rotated: the session that gets sealed carries the new one, which is the
    // half that was being thrown away.
    expect(stored?.refresh_token).not.toBe(token.refresh_token);
    expect(stored?.expires_at).toBeGreaterThan(Date.now());
  }, 60_000);

  /**
   * A bearer the loan book refuses is still a re-sign-in, not a silent empty
   * screen — the server-render path must not become a way to skip that.
   */
  test("a bearer the loan book refuses still reads as expired", async () => {
    const session = sessionWith(
      { access_token: "not-a-token-this-idp-ever-issued", expires_at: 0 },
      PEOPLE.dana.email,
    );

    const state = await read(session);

    expect(state.status).toBe("expired");
    if (state.status !== "expired") throw new Error("unreachable");
    expect(state.message).toContain("sign in again");
  }, 30_000);
});

describe("a route handler, which can", () => {
  test("renews once and the resealed session then reads without renewing again", async () => {
    const token = await grantWithRefreshToken("riley");
    const session = sessionWith(token, PEOPLE.riley.email);

    grants = [];
    const resealed: Session[] = [];
    const first = await read(session, { onRenewed: (next) => resealed.push(next) });
    expect(first.status).toBe("loaded");
    expect(grants).toEqual(["refresh_token"]);

    const next = resealed[0];
    if (next === undefined) throw new Error("the renewal handed back no session");
    const second = await read(next, { onRenewed: (later) => resealed.push(later) });

    expect(second.status).toBe("loaded");
    // Still one: the resealed session's expiry is in the future, so the second
    // read spends nothing. A renewal per poll would be a refresh token spent
    // every two seconds.
    expect(grants).toEqual(["refresh_token"]);
    expect(resealed).toHaveLength(1);
  }, 60_000);

  /**
   * The measurement this whole file rests on, made against the real IdP so it
   * cannot rot quietly: a redeemed refresh token is refused **and** takes the
   * access token minted alongside it down with it.
   *
   * If `apps/idp` ever stops behaving this way the tests above would still
   * pass while no longer proving anything, and this is the one that would fail
   * and say so.
   */
  test("apps/idp rotates destructively: a replayed refresh token revokes the family", async () => {
    const token = await grantWithRefreshToken("morgan");
    const resealed: Session[] = [];
    await read(sessionWith(token, PEOPLE.morgan.email), { onRenewed: (next) => resealed.push(next) });
    const rotated = resealed[0]?.idp;
    if (rotated === undefined) throw new Error("no rotation happened");

    // A clean rotation leaves both access tokens working.
    expect((await userinfo(token.access_token)).status).toBe(200);
    expect((await userinfo(rotated.access_token)).status).toBe(200);

    // Replaying the spent one is refused…
    const replay = await refresh(token.refresh_token as string);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("invalid_grant");

    // …and takes the rotated access token with it.
    expect((await userinfo(rotated.access_token)).status).toBe(401);
  }, 60_000);
});

function userinfo(accessToken: string): Promise<Response> {
  return fetch(`${identity.idpUrl}/oauth2/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
}

function refresh(refreshToken: string): Promise<Response> {
  return fetch(`${identity.idpUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(
        `${identity.config.identity.idpClientId}:${identity.config.identity.idpClientSecret}`,
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: identity.config.identity.idpClientId,
    }).toString(),
  });
}

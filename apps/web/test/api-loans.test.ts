/**
 * `GET /api/loans` — what the bank's own screens are served, and who they are
 * served as.
 *
 * Nothing is mocked. `apps/idp` is a real subprocess and the sign-in is a real
 * authorization-code + PKCE flow with a real password typed into a real login
 * form; `apps/loan-app` is a real subprocess owning a real `loans.db`; and the
 * route under test is the deployed handler, reached over real HTTP behind a
 * real `Bun.serve`, with the sealed cookie a browser would actually be holding.
 *
 * Between the route and the loan book sits one addition: a recording proxy that
 * writes down the `Authorization` header on every request and forwards it
 * unchanged. That is how the claim **"the read is made with the persona's
 * bearer, not a shared secret"** is measured rather than asserted — the
 * recorded bearer is presented to `apps/idp`'s `/oauth2/userinfo`, which is the
 * same endpoint `apps/loan-app/src/actor.ts` uses to decide who a caller is, and
 * it has to name the person who signed in.
 *
 * Every port is `:0` or taken from the OS. This worktree owns a block of ten
 * and the reviewer's owns a different block, so nothing here may pick a number.
 */
import { spawn, type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET } from "../app/api/loans/route.ts";
import { chunk, chunkName, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { DEMO_LOAN_IDS } from "../lib/loan-context/loans.ts";
import { SESSION_COOKIE, type Session } from "../lib/identity/session.ts";
import {
  Browser,
  PEOPLE,
  SESSION_SECRET,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
} from "./identity-harness.ts";
import { readPort } from "./harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The $88,000 control application, pending in the fixture. Charlie decides it below. */
const CONTROL_LOAN = "LN-2299";

let identity: IdentityHarness;
let loanApp: Subprocess<"ignore", "pipe", "pipe">;
let loanAppHost: string;
let workspace: string;
/** Every request the loan book received through the proxy, with its bearer. */
let seen: Array<{ method: string; path: string; authorization: string | null }> = [];
let proxy: ReturnType<typeof Bun.serve>;
let route: ReturnType<typeof Bun.serve>;
let routeUrl: string;
let restoreEnv: Array<[string, string | undefined]> = [];

beforeAll(async () => {
  identity = await startIdentityHarness();
  workspace = join(tmpdir(), `cg-api-loans-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });

  loanApp = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "loan-app", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      LOANS_DB_PATH: join(workspace, "loans.db"),
      IDP_PUBLIC_HOST: new URL(identity.idpUrl).host,
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"ignore", "pipe", "pipe">;
  const { port } = await readPort(loanApp);
  loanAppHost = `localhost:${port}`;

  // Transparent, and the only reason it exists is to write down what the route
  // sent. It changes nothing about the request: same method, same path, same
  // headers, same body.
  proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
      });
      try {
        return await fetch(`http://${loanAppHost}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
        });
      } catch {
        // A proxy whose upstream is gone answers; it does not throw. The last
        // test in this file kills the loan book on purpose.
        return new Response("the loan book is not listening", { status: 502 });
      }
    },
  });

  // The route reads its environment the way the deployed service does, so the
  // test configures the environment rather than reaching past the route.
  // Restored afterwards: `bun test` shares one process across files.
  set("SESSION_SECRET", SESSION_SECRET);
  set("IDP_ISSUER", identity.idpUrl);
  set("IDP_CLIENT_ID", identity.config.identity.idpClientId);
  set("IDP_CLIENT_SECRET", identity.config.identity.idpClientSecret);
  set("LOAN_APP_PUBLIC_HOST", `localhost:${proxy.port}`);
  // So `decided_by_name` can resolve an address to the name a room reads.
  set("PERSONA_LOAN_OFFICER_EMAIL", PEOPLE.dana.email);
  set("PERSONA_CREDIT_ANALYST_EMAIL", PEOPLE.sam.email);
  set("PERSONA_VP_CREDIT_EMAIL", PEOPLE.riley.email);
  set("PERSONA_CHIEF_CREDIT_OFFICER_EMAIL", PEOPLE.morgan.email);

  route = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: (request) => GET(request),
  });
  routeUrl = `http://localhost:${route.port}/api/loans`;
}, 90_000);

afterAll(async () => {
  route?.stop(true);
  proxy?.stop(true);
  loanApp?.kill();
  await loanApp?.exited;
  await identity?.stop();
  for (const [key, value] of restoreEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
});

function set(key: string, value: string): void {
  restoreEnv.push([key, process.env[key]]);
  process.env[key] = value;
}

/**
 * A real sign-in, and the cookie header a browser would carry afterwards.
 *
 * `stopAt` is hop 1's start: the session exists by then and nothing about the
 * loan book depends on the gateway, which is the point of #157.
 */
async function signedInCookie(persona: keyof typeof PEOPLE): Promise<string> {
  const browser = new Browser();
  await signInAs(browser, identity, persona, { stopAt: "/api/arcade/start" });
  const jar = [...browser.cookies].filter(([name]) => name.startsWith(SESSION_COOKIE));
  if (jar.length === 0) throw new Error(`signing in as ${persona} left no session cookie`);
  return jar.map(([name, value]) => `${name}=${value}`).join("; ");
}

/** The cookie header for a session this test made up, for the states a sign-in cannot produce. */
async function cookieFor(session: Session): Promise<string> {
  const pieces = chunk(await seal(session, SESSION_SECRET));
  return pieces.map((piece, index) => `${chunkName(SESSION_COOKIE, index)}=${piece}`).join("; ");
}

async function ask(cookie?: string): Promise<{ status: number; text: string; body: any }> {
  const response = await fetch(routeUrl, {
    headers: { accept: "application/json", ...(cookie === undefined ? {} : { cookie }) },
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

describe("the loan book a signed-in persona is served", () => {
  test("every application comes back, including both the demo is about", async () => {
    const { status, body } = await ask(await signedInCookie("dana"));

    expect(status).toBe(200);
    expect(body.status).toBe("loaded");
    expect(body.actor).toBe(PEOPLE.dana.email);
    const ids = body.loans.map((loan: { loan_id: string }) => loan.loan_id);
    for (const id of DEMO_LOAN_IDS) expect(ids).toContain(id);
    // The whole book, because `/loans` shows the whole book off the same route.
    expect(body.loans.length).toBeGreaterThanOrEqual(DEMO_LOAN_IDS.length);
  }, 30_000);

  test("a card carries the fields the screen draws and nothing it does not", async () => {
    const { body } = await ask(await signedInCookie("dana"));
    const northwind = body.loans.find((loan: { loan_id: string }) => loan.loan_id === "LN-2291");

    expect(Object.keys(northwind).sort()).toEqual([
      "amount",
      "annual_revenue",
      "borrower_name",
      "credit_score",
      "decided_at",
      "decided_by",
      "decided_by_name",
      "loan_id",
      "purpose",
      "status",
      "submitted_at",
      "years_in_business",
    ]);
    expect(northwind.borrower_name).toBe("Northwind Bakery LLC");
    expect(northwind.amount).toBe(95000);
  }, 30_000);

  /**
   * Act 3's and act 4's subjects, never on this route.
   *
   * `apps/loan-app` returns all three on its detail route — it is the bank's
   * system of record and it holds them — so this is asserted against the raw
   * response text rather than against parsed fields: a value that reaches the
   * browser is a value in the page source whatever a component draws. The
   * account number is compared to what the loan book actually holds, not to a
   * constant, so the test cannot pass by the fixture having changed.
   */
  test("the borrower's account number, tax id and underwriter notes never leave the server", async () => {
    const cookie = await signedInCookie("dana");
    const held = (await (
      await fetch(`http://${loanAppHost}/loans/LN-2291`, {
        headers: { authorization: `Bearer ${await bearerFor("dana")}` },
      })
    ).json()) as Record<string, string>;
    const { text } = await ask(cookie);

    for (const field of ["bank_account_number", "tax_id", "underwriter_notes"]) {
      expect(text).not.toContain(field);
    }
    expect(text).not.toContain(held.bank_account_number);
    expect(text).not.toContain(held.tax_id);
    // The injected instruction act 4 is about, which lives in the notes.
    expect(text).not.toContain(held.underwriter_notes);
  }, 30_000);

  /**
   * The decision the demo is about to make, as the card will show it.
   *
   * Approved through `apps/loan-app`'s own API as Charlie — the same call the
   * approval page makes — so `decided_by` is whatever the loan book derived
   * from *that* caller's token, not something this test handed it.
   */
  test("an approval made by another person shows up on the next read, named", async () => {
    const before = await ask(await signedInCookie("dana"));
    expect(
      before.body.loans.find((loan: { loan_id: string }) => loan.loan_id === CONTROL_LOAN).status,
    ).toBe("pending");

    const approved = await fetch(`http://${loanAppHost}/loans/${CONTROL_LOAN}/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await bearerFor("riley")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 88000 }),
    });
    expect(approved.status).toBe(200);

    const after = await ask(await signedInCookie("dana"));
    const card = after.body.loans.find((loan: { loan_id: string }) => loan.loan_id === CONTROL_LOAN);
    expect(card.status).toBe("approved");
    // The address is the join key; the name is what a room reads.
    expect(card.decided_by).toBe(PEOPLE.riley.email);
    expect(card.decided_by_name).toBe("Charlie");
    expect(Date.parse(card.decided_at)).toBeGreaterThan(0);
  }, 45_000);
});

describe("who the read is made as", () => {
  /**
   * `DESIGN.md` → Business system: *no service credential — the read is
   * attributable to a person or it does not happen.*
   *
   * Measured three ways, because this is the rule the whole slice rests on:
   * the bearer on the wire is the one in this browser's session, presenting it
   * to the IdP names the person who signed in, and the loan book refuses a
   * request that does not carry it.
   */
  test("the bearer on the wire is the persona's own IdP token", async () => {
    seen = [];
    const cookie = await signedInCookie("riley");
    const { status } = await ask(cookie);
    expect(status).toBe(200);

    expect(seen.length).toBeGreaterThan(0);
    const bearers = new Set(seen.map((request) => request.authorization));
    expect(bearers.size).toBe(1);
    const authorization = [...bearers][0] as string;
    expect(authorization.startsWith("Bearer ")).toBe(true);

    // `apps/loan-app/src/actor.ts` decides who a caller is by asking exactly
    // this. Asking it the same way is what turns "the persona's bearer" from a
    // claim about our code into a measurement of the IdP's answer.
    const userinfo = await fetch(`${identity.idpUrl}/oauth2/userinfo`, {
      headers: { authorization },
    });
    expect(userinfo.status).toBe(200);
    expect(((await userinfo.json()) as { email: string }).email.toLowerCase()).toBe(PEOPLE.riley.email);
  }, 45_000);

  test("the loan book refuses the same requests without it", async () => {
    const naked = await fetch(`http://${loanAppHost}/loans`);
    expect(naked.status).toBe(401);
  }, 30_000);

  test("no request to the loan book carries anything but that person's bearer", async () => {
    seen = [];
    await ask(await signedInCookie("riley"));

    const secrets = [
      process.env.ARCADE_API_KEY,
      process.env.APPROVALS_STORE_TOKEN,
      process.env.RESET_TOKEN,
      process.env.ARCADE_HOOK_SIGNING_SECRET,
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
    for (const request of seen) {
      for (const secret of secrets) {
        expect({ path: request.path, leaks: request.authorization?.includes(secret) ?? false }).toEqual({
          path: request.path,
          leaks: false,
        });
      }
    }
  }, 45_000);
});

describe("when there is nobody to read as", () => {
  test("no cookie is signed-out, and says where to go", async () => {
    const { status, body } = await ask();

    expect(status).toBe(401);
    expect(body.status).toBe("signed-out");
    expect(body.message).toContain("signed in");
  });

  /**
   * The state #157 has to name correctly.
   *
   * An expired bearer is a sign-in to do again. It is **not** a governance
   * decision: no hook ran on this path and nothing was refused by policy, and a
   * body that said otherwise would be this route asserting a control-plane
   * action that never happened.
   */
  test("an expired token with no way to renew it is a re-sign-in, not a refusal", async () => {
    const cookie = await cookieFor({
      email: PEOPLE.dana.email,
      signed_in_at: Date.now() - 7_200_000,
      idp: { access_token: "expired-and-unrenewable", expires_at: Date.now() - 60_000 },
    });
    const { status, body, text } = await ask(cookie);

    expect(status).toBe(401);
    expect(body.status).toBe("expired");
    expect(body.message).toContain("sign in again");
    // It says the opposite of a refusal, in as many words, and carries none of
    // the vocabulary the control plane owns.
    expect(body.message).toContain("Nothing was refused by policy");
    expect(text).not.toMatch(/\bdenied\b|CHECK_FAILED|\[ref evt_|not allowed/i);
  });

  /**
   * The other half: a token that has not expired by our clock and that the IdP
   * refuses anyway. `expires_at` is this service's note to itself; only the IdP
   * decides.
   */
  test("a token the identity provider refuses is the same re-sign-in", async () => {
    const cookie = await cookieFor({
      email: PEOPLE.dana.email,
      signed_in_at: Date.now(),
      idp: { access_token: "not-a-token-this-idp-ever-issued", expires_at: Date.now() + 3_600_000 },
    });
    const { status, body } = await ask(cookie);

    expect(status).toBe(401);
    expect(body.status).toBe("expired");
    expect(body.message).toContain("sign in again");
  }, 30_000);

  /**
   * A session sealed before #157 shipped, which is a real state on a browser
   * that stayed signed in across the deploy: the cookie unseals, the persona is
   * still named, and there is no bearer to read the book with.
   */
  test("a session from before this slice asks for a fresh sign-in rather than reading as nobody", async () => {
    const cookie = await cookieFor({ email: PEOPLE.dana.email, signed_in_at: Date.now() });
    const { status, body } = await ask(cookie);

    expect(status).toBe(401);
    expect(body.status).toBe("expired");
  });
});

/**
 * Last, because it is terminal: the loan book does not answer.
 *
 * The one mislabelling this project is organised against. A screen that said
 * "you are not allowed to see this" when the truth is that a process died would
 * be asserting a control-plane action that never happened — and unlike the
 * reverse mistake, nobody ever finds out.
 */
describe("when the loan book does not answer", () => {
  test("an unreachable loan book is an outage, never a refusal", async () => {
    const cookie = await signedInCookie("dana");
    loanApp.kill();
    await loanApp.exited;

    const { status, body, text } = await ask(cookie);

    expect(status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(text).not.toMatch(/denied|refused|expired|sign in/i);
  }, 45_000);
});

/**
 * One IdP access token for a persona, obtained the way `apps/web` obtains one.
 *
 * A real sign-in through the real handlers, with the token read back out of the
 * sealed session — so the bearer this test writes with is the same kind of
 * bearer the route reads with, and nothing here mints a credential of its own.
 */
async function bearerFor(persona: keyof typeof PEOPLE): Promise<string> {
  const cookie = await signedInCookie(persona);
  const jar = new Map(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)] as [string, string];
    }),
  );
  const session = await openSealed<Session>(joinChunks(SESSION_COOKIE, jar), SESSION_SECRET);
  const token = session?.idp?.access_token;
  if (token === undefined) throw new Error(`the session for ${persona} carries no IdP token`);
  return token;
}

/**
 * The HTTP surface, exercised over the wire against the service booted the
 * way Render boots it — `bun src/index.ts`, env only — not by calling handlers
 * in-process.
 *
 * Tokens are validated against a stand-in identity provider that this file
 * runs itself: it serves `/oauth2/userinfo` and knows two tokens. The real one
 * is `apps/idp` (#36); the API only ever sees that endpoint, so a fake that
 * speaks it is a complete test double.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LoanRecord, LoanSummary } from "../src/db.ts";

/**
 * `Response.json()` is `Promise<unknown>`, so every read off a body below has
 * to say what it expects. Naming the route's documented shape here is the
 * point: it is an assertion, not a validation, and the runtime `expect`s in
 * each test remain the thing that proves the service really sends it. A wire
 * shape that drifts from these types fails as a test, not as a silent `any`.
 */
type SearchBody = { count: number; loans: LoanSummary[] };
type ErrorBody = { error: string; issues?: unknown };
type HealthBody = { status: string; service: string; loans: number };

const dbPath = join(tmpdir(), `cg-loan-app-${crypto.randomUUID()}`, "loans.db");

const DANA = "alice@example.test";
const RILEY = "charlie@example.test";
/**
 * A provider that hands back a capitalised address. Real ones do: the value
 * is whatever the account was created under, and #58 found a deployment where
 * every persona was `Alice@Example.Test`. The actor recorded here has
 * to be the same string the control plane governs, and neither end gets to
 * assume the other's case.
 */
const MORGAN_AS_ISSUED = "Michael@Example.Test";
const MORGAN = MORGAN_AS_ISSUED.toLowerCase();
const TOKENS: Record<string, string> = {
  "tok-dana": DANA,
  "tok-riley": RILEY,
  "tok-morgan": MORGAN_AS_ISSUED,
};

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
  // child and surface twenty seconds later as "loan-app did not come up",
  // which says nothing about the cause. Fail here, where the cause is.
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

let idp: Server<unknown>;
let child: Subprocess;
let baseUrl: string;

beforeAll(async () => {
  idp = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const email = token === undefined ? undefined : TOKENS[token];

      if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });
      if (email === undefined) return new Response("invalid_token", { status: 401 });

      return Response.json({ sub: email, email, email_verified: true });
    },
  });

  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOANS_DB_PATH: dbPath,
      IDP_PUBLIC_HOST: `localhost:${idp.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("loan-app did not come up");
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  idp?.stop(true);
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

function as(token: string | null, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function post(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(
    `${baseUrl}${path}`,
    as(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("health", () => {
  test("answers for Render's health check, without a token", async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as HealthBody;

    expect(body).toMatchObject({ status: "ok", service: "loan-app" });
    expect(body.loans).toBeGreaterThan(1);
  });
});

describe("identity", () => {
  test("every loan route needs a bearer token", async () => {
    for (const path of ["/loans", "/loans/LN-2291"]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    }
    expect((await fetch(`${baseUrl}/loans/LN-2291/approve`, { method: "POST" })).status).toBe(401);
  });

  test("a wrong verb is a 405 before anyone asks for a token", async () => {
    expect((await fetch(`${baseUrl}/loans/LN-2291`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/loans`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/loans/LN-2291/approve`)).status).toBe(405);
  });

  test("a token the identity provider does not recognise is refused", async () => {
    const response = await fetch(`${baseUrl}/loans`, as("tok-forged"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("rejected") });
  });

  test("the actor comes from the token — a body that names one is refused", async () => {
    const response = await post("tok-dana", "/loans/LN-2292/approve", {
      amount: 1_000,
      actor: RILEY,
    });

    expect(response.status).toBe(400);
    const loan = (await (
      await fetch(`${baseUrl}/loans/LN-2292`, as("tok-dana"))
    ).json()) as LoanRecord;
    expect(loan.decisions).toHaveLength(0);
  });
});

describe("GET /loans", () => {
  test("returns plausible surrounding loans with no filter", async () => {
    const body = (await (await fetch(`${baseUrl}/loans`, as("tok-dana"))).json()) as SearchBody;

    expect(body.count).toBeGreaterThan(4);
    expect(body.loans.map((loan) => loan.loan_id)).toContain("LN-2291");
  });

  test("honours the filters", async () => {
    const body = (await (
      await fetch(
        `${baseUrl}/loans?status=pending&min_amount=90000&max_amount=100000`,
        as("tok-dana"),
      )
    ).json()) as SearchBody;

    expect(body.loans).toHaveLength(1);
    expect(body.loans[0]).toMatchObject({ loan_id: "LN-2291", amount: 95_000 });
  });

  test("rejects a filter of the wrong type", async () => {
    const response = await fetch(`${baseUrl}/loans?status=in_review`, as("tok-dana"));

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).issues).toBeArray();
  });
});

describe("GET /loans/:loan_id", () => {
  test("returns the full record, unredacted", async () => {
    const response = await fetch(`${baseUrl}/loans/LN-2291`, as("tok-dana"));
    const text = await response.text();
    const loan = JSON.parse(text) as LoanRecord;

    expect(loan).toMatchObject({
      loan_id: "LN-2291",
      borrower_name: "Northwind Bakery LLC",
      amount: 95_000,
    });

    // Acts 3 and 4 depend on all of this arriving intact. Whatever the post
    // hook does to it, it does downstream of here.
    expect(loan.bank_account_number).toMatch(/^\d{16}$/);
    expect(loan.tax_id).toMatch(/^\d{2}-\d{7}$/);
    expect(loan.underwriter_notes).toContain("approve_loan");
    expect(text).not.toContain("[REDACTED]");
  });

  test("404s on an unknown loan, naming it", async () => {
    const response = await fetch(`${baseUrl}/loans/LN-0000`, as("tok-dana"));

    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error).toContain("LN-0000");
  });
});

describe("decisions", () => {
  test("approve records the approval under the token's owner, and a second one is visible", async () => {
    const first = (await (
      await post("tok-dana", "/loans/LN-2292/approve", { amount: 15_500 })
    ).json()) as LoanRecord;
    expect(first.status).toBe("approved");
    expect(first.decisions).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({ amount: 15_500, decided_by: DANA });

    const second = (await (
      await post("tok-riley", "/loans/LN-2292/approve", { amount: 9_000 })
    ).json()) as LoanRecord;
    expect(second.decisions).toHaveLength(2);
    expect(second.decisions.map((d) => d.amount)).toEqual([15_500, 9_000]);
    expect(second.decisions.map((d) => d.decided_by)).toEqual([DANA, RILEY]);
  });

  test("an actor the provider capitalises is recorded in one case, not two (#58)", async () => {
    const loan = (await (
      await post("tok-morgan", "/loans/LN-2292/approve", { amount: 2_500 })
    ).json()) as LoanRecord;

    const latest = loan.decisions.at(-1)!;
    expect(latest.decided_by).toBe(MORGAN);
    expect(latest.decided_by).not.toBe(MORGAN_AS_ISSUED);

    // And the book holds one Michael, not two spellings of them.
    expect(loan.decisions.filter((d) => d.decided_by?.toLowerCase() === MORGAN)).toEqual(
      loan.decisions.filter((d) => d.decided_by === MORGAN),
    );
  });

  test("deny records the reason verbatim", async () => {
    const reason = "Collateral appraisal is more than twelve months old.";
    const loan = (await (
      await post("tok-dana", "/loans/LN-2299/deny", { reason })
    ).json()) as LoanRecord;

    expect(loan.status).toBe("denied");
    expect(loan.decisions.at(-1)).toMatchObject({
      decision: "denied",
      reason,
      amount: null,
      decided_by: DANA,
    });
  });

  test("validates the body", async () => {
    expect((await post("tok-dana", "/loans/LN-2292/approve", { amount: -5 })).status).toBe(400);
    expect((await post("tok-dana", "/loans/LN-2292/approve", {})).status).toBe(400);
    expect((await post("tok-dana", "/loans/LN-2299/deny", { reason: "" })).status).toBe(400);
  });

  test("404s on an unknown loan and writes nothing", async () => {
    const response = await post("tok-dana", "/loans/LN-0000/approve", { amount: 1 });

    expect(response.status).toBe(404);
  });

  test("survives across requests — the loan book is the only state", async () => {
    const loan = (await (
      await fetch(`${baseUrl}/loans/LN-2299`, as("tok-riley"))
    ).json()) as LoanRecord;

    expect(loan.status).toBe("denied");
  });
});

describe("surface", () => {
  test("there is no MCP endpoint here", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(404);
  });

  test("an unknown path is a 404", async () => {
    expect((await fetch(`${baseUrl}/nothing`)).status).toBe(404);
  });
});

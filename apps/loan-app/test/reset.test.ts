/**
 * `POST /admin/reset`, over the wire, against the service booted the way
 * Render boots it — `bun src/index.ts`, env only.
 *
 * The claim under test is the one #23 needs: after a take of the demo has
 * approved `LN-2291`, one call puts the book back to the rows the fixture
 * ships, and calling it again changes nothing. Everything is read through the
 * service's own HTTP surface; nothing here opens `loans.db`, because a test
 * that reads the file could pass against a service that never noticed the
 * rows moved.
 *
 * The 404-when-unset case boots a **second** instance with no `RESET_TOKEN`,
 * because that is a property of the process and not of a request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LoanRecord } from "../src/db.ts";

const RESET_TOKEN = "loan-app-reset-token-for-tests";
const DANA = "alice@example.test";
const TOKENS: Record<string, string> = { "tok-dana": DANA };

type HealthBody = { status: string; service: string; loans: number; reset: string };
type ResetBody = {
  service: string;
  reset: string;
  counts: {
    before: { loans: number; decisions: number };
    after: { loans: number; decisions: number };
  };
  not_reset: Record<string, string>;
};

/** A port the OS says is free, rather than a guess. `conftest.py::_free_port`. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

interface Instance {
  child: Subprocess;
  baseUrl: string;
  dbPath: string;
}

let idp: Server<unknown>;
const started: Instance[] = [];

async function boot(env: Record<string, string>): Promise<Instance> {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(tmpdir(), `cg-loan-app-${crypto.randomUUID()}`, "loans.db");

  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOANS_DB_PATH: dbPath,
      IDP_PUBLIC_HOST: `localhost:${idp.port}`,
      ...env,
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
    if (Date.now() > deadline) {
      throw new Error(
        `loan-app did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`,
      );
    }
    await Bun.sleep(50);
  }

  const instance = { child, baseUrl, dbPath };
  started.push(instance);
  return instance;
}

let live: Instance;

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function loan(base: string, id: string): Promise<LoanRecord> {
  const response = await fetch(`${base}/loans/${id}`, as("tok-dana"));
  expect(response.status).toBe(200);
  return (await response.json()) as LoanRecord;
}

async function reset(base: string, token: string | null = RESET_TOKEN): Promise<Response> {
  return fetch(`${base}/admin/reset`, {
    method: "POST",
    ...(token === null ? {} : as(token)),
  });
}

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

  live = await boot({ RESET_TOKEN });
});

afterAll(() => {
  for (const instance of started) {
    instance.child.kill();
    rmSync(dirname(instance.dbPath), { recursive: true, force: true });
  }
  idp?.stop(true);
});

describe("the seeded book comes back", () => {
  test("a take that approved LN-2291 is undone by one call", async () => {
    const seeded = await loan(live.baseUrl, "LN-2291");
    expect(seeded.status).toBe("pending");

    const approved = await fetch(`${live.baseUrl}/loans/LN-2291/approve`, {
      method: "POST",
      headers: { ...as("tok-dana").headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 95_000 }),
    });
    expect(approved.status).toBe(200);
    expect((await loan(live.baseUrl, "LN-2291")).status).toBe("approved");

    const response = await reset(live.baseUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResetBody;

    // The decision this test made is in the before-count and gone from the
    // after-count, so the numbers the root script prints are the service's own
    // observation rather than a constant.
    expect(body.counts.before.decisions).toBe(body.counts.after.decisions + 1);
    expect(body.counts.after.loans).toBe(body.counts.before.loans);

    const after = await loan(live.baseUrl, "LN-2291");
    expect(after.status).toBe("pending");
    // Not just the status: a decision row left behind and ignored would still
    // be a $95K approval in the bank's system of record.
    expect(after.decisions).toEqual(seeded.decisions);
    expect(after).toEqual(seeded);
  });

  test("running it twice leaves exactly the same book", async () => {
    await reset(live.baseUrl);
    const once = await Promise.all([loan(live.baseUrl, "LN-2291"), loan(live.baseUrl, "LN-2299")]);

    const second = await reset(live.baseUrl);
    expect(second.status).toBe(200);
    const twice = await Promise.all([loan(live.baseUrl, "LN-2291"), loan(live.baseUrl, "LN-2299")]);

    expect(twice).toEqual(once);
    const body = (await second.json()) as ResetBody;
    expect(body.counts.before).toEqual(body.counts.after);
  });

  test("every seeded loan comes back, not only the two the demo names", async () => {
    await reset(live.baseUrl);
    const listed = (await (
      await fetch(`${live.baseUrl}/loans`, as("tok-dana"))
    ).json()) as { count: number };

    const body = (await (await reset(live.baseUrl)).json()) as ResetBody;
    expect(body.counts.after.loans).toBe(listed.count);
    expect(listed.count).toBeGreaterThan(1);
  });

  test("the response names the two databases it did not touch", async () => {
    const body = (await (await reset(live.baseUrl)).json()) as ResetBody;
    expect(body.reset).toBe("loans.db");
    expect(Object.keys(body.not_reset).sort()).toEqual(["governance.db", "idp.db"]);
  });
});

describe("the bearer", () => {
  test("no token is 401, and the book is untouched", async () => {
    const before = await loan(live.baseUrl, "LN-2291");
    expect((await reset(live.baseUrl, null)).status).toBe(401);
    expect(await loan(live.baseUrl, "LN-2291")).toEqual(before);
  });

  test("the wrong token is 401", async () => {
    expect((await reset(live.baseUrl, "not-the-token")).status).toBe(401);
  });

  test("neither a GET nor a DELETE resets anything", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${live.baseUrl}/admin/reset`, { method, ...as(RESET_TOKEN) });
      expect(response.status).toBe(405);
    }
  });

  test("/health says the route is there", async () => {
    const health = (await (await fetch(`${live.baseUrl}/health`)).json()) as HealthBody;
    expect(health.reset).toBe("enabled");
  });
});

describe("unset RESET_TOKEN takes the route away", () => {
  let bare: Instance;

  beforeAll(async () => {
    bare = await boot({ RESET_TOKEN: "" });
  });

  test("the route answers 404, exactly as an unknown path does", async () => {
    expect((await reset(bare.baseUrl)).status).toBe(404);
    // The same answer as a path that was never routed, so an unconfigured
    // deployment is indistinguishable from one that never had the endpoint.
    expect((await fetch(`${bare.baseUrl}/admin/nothing`, as(RESET_TOKEN))).status).toBe(404);
  });

  test("/health explains the 404", async () => {
    const health = (await (await fetch(`${bare.baseUrl}/health`)).json()) as HealthBody;
    expect(health.status).toBe("ok");
    expect(health.reset).toBe("disabled");
  });
});

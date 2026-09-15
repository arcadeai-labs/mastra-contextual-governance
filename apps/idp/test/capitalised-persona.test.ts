/**
 * The test #58 says would have caught it: seed with a capitalised
 * role-based persona email configuration and assert `/sign-in/email` answers 200.
 *
 * Every other fixture in this directory is lowercase, which is why a persona
 * configured as `Alice@Example.Test` reached a live sitting before
 * anyone noticed they could not log in. Better Auth lowercases the address
 * before it looks the row up and SQLite compares text case-sensitively, so
 * the row was unreachable — and `handleLogin` reports that as "That email and
 * password did not match", the same sentence it gives a wrong password.
 *
 * Booted as a subprocess, env only, the way Render boots it, so what is under
 * test is the seed that really ran and the schema that really applied.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const dbPath = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
const SECRET = "test-secret-".padEnd(48, "x");

/** As a human types it into Render's dashboard, copying the Arcade invite. */
const CONFIGURED = "Alice@Bank.Example";
const STORED = CONFIGURED.toLowerCase();
/** The fixture's password for Alice, which the override does not change. */
const PASSWORD = "dana-demo-2026";

let child: Subprocess;
let baseUrl: string;

/** Bind :0 and read the port back — see the note in `flow.test.ts`. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

/** Better Auth's own endpoint, called the way its client calls it. */
async function signIn(email: string, password = PASSWORD): Promise<Response> {
  return fetch(`${baseUrl}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(async () => {
  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      ...inherited,
      PORT: String(port),
      IDP_DB_PATH: dbPath,
      IDP_PUBLIC_URL: baseUrl,
      IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
      BETTER_AUTH_SECRET: SECRET,
      PERSONA_LOAN_OFFICER_EMAIL: CONFIGURED,
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
      throw new Error(`idp did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`);
    }
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

describe("a persona configured with a capitalised address", () => {
  test("can sign in with the address exactly as it was configured", async () => {
    const response = await signIn(CONFIGURED);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe(STORED);
  });

  test("can sign in with the lowercase form too — the same person, either way", async () => {
    expect((await signIn(STORED)).status).toBe(200);
  });

  test("a wrong password is still refused, so the 200 above is not a blanket pass", async () => {
    expect((await signIn(CONFIGURED, "not-it")).status).toBe(401);
  });

  test("the row that was written is lowercase, so the join key is byte-equal downstream", async () => {
    // A second connection to the same file: the service is still holding it,
    // and this is only a read.
    const db = new Database(dbPath, { readonly: true });
    try {
      const emails = db.query<{ email: string }, []>('SELECT "email" FROM "user"').all();
      expect(emails.map((row) => row.email)).toContain(STORED);
      expect(emails.some((row) => /[A-Z]/.test(row.email))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("the login page a browser posts to accepts it as well", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: CONFIGURED, password: PASSWORD }).toString(),
      redirect: "manual",
    });

    // 303 back to `/` — signed in, with no OAuth flow to continue. A 401 here
    // is the bug: the page cannot tell an unreachable row from a bad password.
    expect(response.status).toBe(303);
  });
});

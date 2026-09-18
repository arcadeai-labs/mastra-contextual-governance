/**
 * What the login form does with an answer that is not a sign-in (#170).
 *
 * `handleLogin` names the credential failures — wrong password, expired
 * signed query — and until this file existed it named nothing else. The guard
 * that was meant to catch the rest read `!response.ok && response.status < 300`,
 * and `Response.ok` is true only for 200–299, so the two halves intersect at
 * **1xx**: a branch that could not fire for any failure this service produces.
 * Everything else fell through to the `303 Location: /` that a *successful*
 * sign-in with no OAuth flow returns. A refusal that renders as a success is
 * the failure mode this repo exists to remove, and it was sitting in the
 * demo's own front door.
 *
 * So these drive the real login form over HTTP and assert both sides of the
 * boundary: the statuses that must be named, and the ones that must keep
 * behaving exactly as they did.
 *
 * The 5xx case is not simulated. The provider's own database is broken
 * underneath a running service — the `user` table renamed out from under it —
 * which is a fair model of the struggling IdP a rehearsal actually meets, and
 * it produces a real 5xx from the real auth handler rather than a status this
 * test invented. It runs last, because the service does not recover from it.
 *
 * The fourth class #170 names, a 404, has no test here and the reason is on
 * the PR: this service's auth handler cannot answer 404 for a POST to
 * `/sign-in/email` — the route always exists — so a 404 could only be
 * manufactured, and a manufactured status would prove the assertion rather
 * than the guard. The guard is one comparison over the whole space
 * (`status >= 400`), and the two classes below stand on either side of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPeople } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "cg-idp-login-failure-"));
const dbPath = join(dir, "idp.db");
// A file rather than a pipe, so the failure line the service logs can be read
// after the request that produced it — the page shows 200 characters of the
// provider's message and the log is where the rest is supposed to be.
const logPath = join(dir, "stdout.log");

const people = loadPeople({});
const dana = people.find((person) => person.persona === "dana")!;

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

/** The login form, posted the way a browser posts it. */
function submitLogin(email: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
    redirect: "manual",
  });
}

beforeAll(async () => {
  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
        ),
      ) as Record<string, string>),
      PORT: String(port),
      IDP_DB_PATH: dbPath,
      IDP_PUBLIC_URL: baseUrl,
      IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
      BETTER_AUTH_SECRET: "test-secret-".padEnd(48, "x"),
    },
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
});

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the answers that already worked, which must not move", () => {
  test("a wrong password stays on the login page and says so", async () => {
    const response = await submitLogin(dana.email, "not-the-password");
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("did not match");
  });

  test("a real sign-in with no OAuth flow to continue still 303s to / with its cookies", async () => {
    const response = await submitLogin(dana.email, dana.password);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    // The session is the whole point of the redirect: a 303 carrying no
    // cookie is the silent success this file exists to keep out.
    expect(response.headers.getSetCookie().join("; ")).toContain("session_token");
  });
});

describe("an answer that is not a sign-in and not a credential failure", () => {
  test(
    "a 5xx from the provider is named on the page, not redirected past",
    async () => {
      // Break the table the sign-in reads, underneath the running service.
      // Nothing is mocked: the real auth handler meets a real broken database
      // and answers what it answers.
      const db = new Database(dbPath);
      db.run('ALTER TABLE "user" RENAME TO "user_moved_by_test"');
      db.close();

      const response = await submitLogin(dana.email, dana.password);

      // The bug, stated as an assertion: this used to be `303` to `/` with no
      // session, which is byte-for-byte what a successful sign-in returns.
      expect(response.status).not.toBe(303);
      expect(response.headers.get("location")).toBeNull();

      const body = await response.text();
      expect(body).toContain("Sign-in failed");
      // The provider's own status, so the page is about what happened rather
      // than about signing in.
      expect(body).toMatch(/identity provider answered 5\d\d/);

      // And the service said so where an operator would look. The body of
      // this particular 500 is empty — measured, not assumed — so the line
      // reports that rather than implying it had something to say.
      const log = await Bun.file(logPath).text();
      expect(log).toMatch(/\[idp\] POST \/login failed: status=5\d\d body="\(empty\)"/);
    },
    30_000,
  );
});

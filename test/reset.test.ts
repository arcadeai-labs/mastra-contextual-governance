/**
 * `bun run reset` — the single command, end to end against all three real
 * services.
 *
 * Each service booted the way Render boots it (`bun src/index.ts`, env only),
 * each on a port the OS handed out, each with its own database in a temporary
 * directory. The command runs as a **subprocess**, exactly as a presenter runs
 * it between takes, and everything is then read back over the services' own
 * HTTP surfaces. Nothing here opens a `.db` file: a test that read the disk
 * could pass against a service that never noticed the rows moved.
 *
 * The three claims #23 is about, in the order they would go wrong:
 *
 *   1. one command, seconds, and afterwards LN-2291 is unapproved, the grants
 *      and approval requests and the audit log are empty, and the four policy
 *      tables are the fixture's;
 *   2. it is safe to run repeatedly — run it twice, assert identical state;
 *   3. the OAuth client Arcade holds does not move, and a run that could not
 *      prove that is a failure rather than a green tick.
 *
 * `apps/loan-app` validates bearer tokens against an identity provider, and
 * the one it is pointed at here is a stand-in serving `/oauth2/userinfo` and
 * nothing else. The real `apps/idp` boots too — it has its own reset to run —
 * but joining the two would mean walking a whole authorize flow to read one
 * loan, which is `apps/idp/test/flow.test.ts`'s job and not this file's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "root-reset-token-for-tests";
const HOOK_SECRET = "root-reset-hook-secret-for-tests";
const DANA = "alice@example.test";
const OVER_LIMIT_LOAN = "LN-2291";

interface Instance {
  child: Subprocess;
  host: string;
  baseUrl: string;
  dir: string;
}

interface LoanBody {
  loan_id: string;
  status: string;
  decisions: unknown[];
}

interface HooksHealth {
  reset: string;
  counts: Record<string, number>;
  audit_rows: number;
  fixture_drift: unknown;
}

interface IdpHealth {
  reset: string;
  people: number;
  oauth: { client_id: string; clients: { key: string; client_id: string }[] };
}

interface LoanHealth {
  reset: string;
  loans: number;
}

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

const started: Instance[] = [];

async function boot(name: string, entry: string, env: Record<string, string>): Promise<Instance> {
  const port = freePort();
  const host = `127.0.0.1:${port}`;
  const baseUrl = `http://${host}`;
  const dir = join(tmpdir(), `cg-reset-${name}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  // Anything the developer's own shell carries for these services is
  // deliberately dropped: a PERSONA_* or an IDP_* from a local run would make
  // this test about their environment.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("PERSONA_") &&
        !key.startsWith("IDP_") &&
        !key.endsWith("_PUBLIC_HOST") &&
        key !== "RESET_TOKEN",
    ),
  ) as Record<string, string>;

  const child = Bun.spawn(["bun", join(ROOT, entry)], {
    env: { ...inherited, PORT: String(port), ...env },
    stdout: Bun.file(join(dir, "stdout.log")),
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${name} did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`,
      );
    }
    await Bun.sleep(50);
  }

  const instance = { child, host, baseUrl, dir };
  started.push(instance);
  return instance;
}

let idp: Instance;
let hooks: Instance;
let loanApp: Instance;
let userinfo: Server<unknown>;

/** The command, run the way a presenter runs it. */
async function runResetCommand(
  overrides: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESET_TOKEN,
      IDP_PUBLIC_HOST: idp.host,
      HOOKS_PUBLIC_HOST: hooks.host,
      LOAN_APP_PUBLIC_HOST: loanApp.host,
      ...overrides,
    },
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

const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
  (await (await fetch(url, init)).json()) as T;

const hooksHealth = () => json<HooksHealth>(`${hooks.baseUrl}/health`);
const idpHealth = () => json<IdpHealth>(`${idp.baseUrl}/health`);
const loanHealth = () => json<LoanHealth>(`${loanApp.baseUrl}/health`);
const loan = (id: string) =>
  json<LoanBody>(`${loanApp.baseUrl}/loans/${id}`, {
    headers: { authorization: "Bearer tok-dana" },
  });

/** One `/pre` call, which is the cheapest honest way to put a row in the audit log. */
async function governedCall(executionId: string): Promise<Response> {
  return fetch(`${hooks.baseUrl}/pre`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      execution_id: executionId,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: OVER_LIMIT_LOAN, amount: 95_000 },
      context: { authorization: [{}], user_id: DANA },
    }),
  });
}

/** Everything the reset is supposed to put back, read through HTTP. */
async function snapshot() {
  const [hooksBody, idpBody, loanBody, record, control] = await Promise.all([
    hooksHealth(),
    idpHealth(),
    loanHealth(),
    loan(OVER_LIMIT_LOAN),
    loan("LN-2299"),
  ]);
  return {
    counts: hooksBody.counts,
    audit_rows: hooksBody.audit_rows,
    fixture_drift: hooksBody.fixture_drift,
    people: idpBody.people,
    client_id: idpBody.oauth.client_id,
    loans: loanBody.loans,
    record,
    control,
  };
}

beforeAll(async () => {
  // The token endpoint `apps/loan-app` reads the actor off. A complete double:
  // that one route is the whole of its view of identity.
  userinfo = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });
      if (token !== "tok-dana") return new Response("invalid_token", { status: 401 });
      return Response.json({ sub: DANA, email: DANA, email_verified: true });
    },
  });

  [idp, hooks, loanApp] = await Promise.all([
    boot("idp", "apps/idp/src/index.ts", {
      RESET_TOKEN,
      IDP_DB_PATH: join(tmpdir(), `cg-reset-idp-${crypto.randomUUID()}`, "idp.db"),
      BETTER_AUTH_SECRET: "root-reset-test-secret-".padEnd(48, "x"),
      IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
    }),
    boot("hooks", "apps/hooks/src/index.ts", {
      RESET_TOKEN,
      ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
      GOVERNANCE_DB_PATH: join(tmpdir(), `cg-reset-hooks-${crypto.randomUUID()}`, "governance.db"),
      PERSONA_LOAN_OFFICER_EMAIL: DANA,
    }),
    boot("loan-app", "apps/loan-app/src/index.ts", {
      RESET_TOKEN,
      LOANS_DB_PATH: join(tmpdir(), `cg-reset-loan-${crypto.randomUUID()}`, "loans.db"),
      IDP_PUBLIC_HOST: `127.0.0.1:${userinfo.port}`,
    }),
  ]);
});

afterAll(() => {
  for (const instance of started) {
    instance.child.kill();
    rmSync(instance.dir, { recursive: true, force: true });
  }
  userinfo?.stop(true);
});

describe("one command, three databases", () => {
  let seeded: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    // A clean baseline first, so "back to the seeded state" is compared
    // against a reading rather than against a constant this file made up.
    expect((await runResetCommand()).code).toBe(0);
    seeded = await snapshot();
  });

  test("a take of the demo is undone", async () => {
    // Dirty all three: an approved loan, audit rows, and a session in the IdP.
    const approved = await fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer tok-dana", "content-type": "application/json" },
      body: JSON.stringify({ amount: 95_000 }),
    });
    expect(approved.status).toBe(200);
    for (const n of [1, 2, 3]) expect((await governedCall(`tc_reset_${n}`)).status).toBe(200);

    const dirty = await snapshot();
    expect(dirty.record.status).toBe("approved");
    expect(dirty.audit_rows).toBeGreaterThan(seeded.audit_rows);

    const { code, out, err } = await runResetCommand();
    expect(err).toBe("");
    expect(code).toBe(0);

    // One line per service, each naming what moved.
    expect(out).toMatch(/\[reset\] idp\s+OK\s+people \d+→\d+, OAuth client \S+ unchanged/);
    expect(out).toMatch(/\[reset\] hooks\s+OK\s+demo at revision \d+ .*audit_log \d+→0/);
    expect(out).toMatch(/\[reset\] loan-app\s+OK\s+loans \d+→\d+, decisions \d+→\d+/);

    const after = await snapshot();
    expect(after.record.status).toBe("pending");
    expect(after.record).toEqual(seeded.record);
    expect(after.audit_rows).toBe(0);
    expect(after.counts.grants).toBe(0);
    expect(after.counts.approval_requests).toBe(0);
    expect(after.counts.audit_log).toBe(0);
    // The policy is the fixture's, said by the service rather than counted here.
    expect(after.fixture_drift).toBeNull();
  });

  test("it is safe to run repeatedly — twice leaves identical state", async () => {
    expect((await runResetCommand()).code).toBe(0);
    const once = await snapshot();

    expect((await runResetCommand()).code).toBe(0);
    const twice = await snapshot();

    expect(twice).toEqual(once);
  });

  test("no orphaned grants or approval requests are left behind", async () => {
    await runResetCommand();
    const { counts } = await hooksHealth();
    expect(counts.grants).toBe(0);
    expect(counts.approval_requests).toBe(0);
    // And the four tables the demo runs on are populated, not merely empty —
    // a reset that truncated everything would satisfy the two lines above.
    expect(counts.subjects).toBeGreaterThan(0);
    expect(counts.policy_rules).toBeGreaterThan(0);
    expect(counts.output_rules).toBe(2);
  });

  test("the OAuth client Arcade is registered against never moves", async () => {
    const before = await idpHealth();
    await runResetCommand();
    const after = await idpHealth();
    expect(after.oauth.client_id).toBe(before.oauth.client_id);
    expect(after.people).toBe(before.people);
  });

  test("it finishes in seconds, not minutes", async () => {
    const started = performance.now();
    expect((await runResetCommand()).code).toBe(0);
    // Generous on purpose: the claim is "between takes", not a benchmark, and
    // a threshold tight enough to be interesting would be a flake on a loaded
    // CI box. What this catches is a reset that went back to waiting on a
    // deploy.
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("every service reports that its reset route exists", async () => {
    const [hooksBody, idpBody, loanBody] = await Promise.all([
      hooksHealth(),
      idpHealth(),
      loanHealth(),
    ]);
    expect([hooksBody.reset, idpBody.reset, loanBody.reset]).toEqual([
      "enabled",
      "enabled",
      "enabled",
    ]);
  });
});

describe("when it cannot do its job it says so and exits non-zero", () => {
  test("a wrong RESET_TOKEN is a failure, not a quiet no-op", async () => {
    const { code, out } = await runResetCommand({ RESET_TOKEN: "not-the-token" });
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSED");
    expect(out).toContain("different RESET_TOKEN");
    expect(out).toContain("The demo is NOT in a known state");
  });

  test("an unset RESET_TOKEN names the variable and exits EX_CONFIG", async () => {
    const { code, err } = await runResetCommand({ RESET_TOKEN: "" });
    expect(code).toBe(78);
    expect(err).toContain("RESET_TOKEN is unset");
  });

  test("a bare service name is refused before anything is reset", async () => {
    const { code, err } = await runResetCommand({ HOOKS_PUBLIC_HOST: "cg-hooks" });
    expect(code).toBe(78);
    expect(err).toContain("HOOKS_PUBLIC_HOST=cg-hooks");
    expect(err).toContain("onrender.com");
  });

  test("an unreachable service is reported, and the others still run", async () => {
    const dead = `127.0.0.1:${freePort()}`;
    const { code, out } = await runResetCommand({ LOAN_APP_PUBLIC_HOST: dead });
    expect(code).not.toBe(0);
    expect(out).toContain("UNREACHABLE");
    // The two upstream of it were still put back: a presenter wants every
    // problem in one run, not one per run.
    expect(out).toMatch(/\[reset\] idp\s+OK/);
    expect(out).toMatch(/\[reset\] hooks\s+OK/);
  });

  test("--target render reads the RENDER_-prefixed addresses, and says which are missing", async () => {
    const { code, err } = await runResetCommand({}, ["--target", "render"]);
    expect(code).toBe(78);
    // Not the local variable: pointing `--target render` at a localhost value
    // would be the command silently resetting the wrong environment.
    expect(err).toContain("RENDER_IDP_PUBLIC_HOST is unset");
    expect(err).toContain("cg-idp");
  });

  test("an unknown --target is refused", async () => {
    const { code, err } = await runResetCommand({}, ["--target", "staging"]);
    expect(code).toBe(78);
    expect(err).toContain("--target must be one of local, render");
  });
});

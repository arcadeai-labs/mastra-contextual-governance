/**
 * The day the control plane went down, as tests (#106, #112).
 *
 * 2026-09-14, in order: #16 and #17 changed the fixture and the change never
 * reached the live disk, so the service ran one output rule and one injection
 * pattern for a fortnight while `/health` reported `armed`. Then #89 added a
 * compile guard, the disk still held the text it refuses, cg-hooks came up
 * fail-closed, `/health` answered 503, and Render turned that into a 502 over
 * the whole control plane. Recovery took three manual reseeds — two of them
 * against a rolled-back image, so they wrote the old text back — and a
 * hand-written `UPDATE`.
 *
 * Four claims, and each one is a different failure from that sequence:
 *
 * 1. `/health` is 200 whatever it finds, and the refusal stays on the hooks.
 * 2. Policy on disk that differs from the shipped fixture is named, not
 *    silent.
 * 3. Stale rows that cannot compile reseed themselves from the fixture in the
 *    *booting* image; rows that compile are left alone, whatever they say.
 * 4. There is a reset that is not a shell, and it cannot be pressed by a
 *    stranger.
 *
 * Everything here boots a whole service the way `src/index.ts` does — over a
 * real file, because two of these claims are about what a *second* boot over
 * the same disk does, which an in-memory database cannot express.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccessHookResult, PreHookResult } from "@cg/policy-schema";

import type { HooksConfig } from "../src/config.ts";
import { fixtureDigest } from "../src/fixture-drift.ts";
import { createPolicyCache } from "../src/policy-cache.ts";
import { recoverStalePolicy } from "../src/policy-recovery.ts";
import { loadSeed, openGovernance, seed as seedInto, type Seed } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";
import rawFixture from "../src/fixtures/governance.json" with { type: "json" };

const SECRET = "test-secret";
const RESET_TOKEN = "test-reset-token";
const DANA = "alice@bank.example";
const POLL_MS = 10;

const baseConfig: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  approvalsStoreToken: "test-store-token",
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: POLL_MS,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: RESET_TOKEN,
};

/**
 * The fixture as it read before #89: the remediation sentence naming its tools
 * the way a hook payload spells them rather than the way the model's own tool
 * list does. Byte for byte the difference a789e63 landed, and byte for byte
 * what the Render disk still held when that commit deployed.
 *
 * Derived from the shipped fixture rather than checked in as a copy, so it
 * cannot rot into a file nobody edits: if the rule is reworded, this reproduces
 * the same *kind* of staleness against the new wording.
 */
function pre89Fixture(): unknown {
  const text = JSON.stringify(rawFixture)
    .split("$APPROVALS_RequestApproval")
    .join("$APPROVALS.RequestApproval")
    .split("$LOAN_ApproveLoan")
    .join("$LOAN.ApproveLoan");
  return JSON.parse(text) as unknown;
}

/** A fixture whose `/post` rules were never updated by #17 — one pattern, not six. */
function pre17Fixture(): unknown {
  const parsed = JSON.parse(JSON.stringify(rawFixture)) as {
    output_rules: Array<{ id: string; patterns: unknown[] }>;
  };
  const strip = parsed.output_rules.find((r) => r.id === "post.strip-injected-instructions");
  if (strip === undefined) throw new Error("fixture no longer carries the strip rule");
  strip.patterns = strip.patterns.slice(0, 1);
  return parsed;
}

interface Running {
  base: string;
  logs: string[];
  db: Database;
  recovery: { reseeded: boolean; detail: string };
  stop(): void;
}

const running: Running[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const instance of running.splice(0)) instance.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory that lives for one test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-106-"));
  dirs.push(dir);
  return dir;
}

/**
 * Writes a `governance.db` seeded from `raw` and returns its path — the disk a
 * later boot finds. `seed()` is the same function bootstrapping uses, so this
 * produces exactly the rows that version of the fixture would have left.
 */
function diskSeededFrom(raw: unknown, config: HooksConfig = baseConfig): string {
  const path = join(scratch(), "governance.db");
  const db = new Database(path, { create: true });
  try {
    seedInto(db, loadSeed(config, raw));
  } finally {
    db.close();
  }
  return path;
}

/**
 * A whole control plane over `dbPath`, booted the way `src/index.ts` boots one
 * — cache warm before the port opens, then the stale-row recovery, then the
 * server. `imageFixture` is what this *image* ships, which is the whole point:
 * the disk and the image are allowed to disagree, and every claim below is
 * about what happens when they do.
 */
function boot(
  dbPath: string,
  options: { imageFixture?: unknown; config?: Partial<HooksConfig> } = {},
): Running {
  const config = { ...baseConfig, ...options.config, dbPath };
  const db = openGovernance(dbPath, config);
  const image: Seed = loadSeed(config, options.imageFixture ?? rawFixture);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const cache = createPolicyCache(db, {
    log,
    pollMs: POLL_MS,
    scanners: config.injectionDetection,
    fixture: fixtureDigest(config, image),
  });
  cache.start();
  const recovery = recoverStalePolicy({ db, cache, seed: image, log });
  const server = createServer({ config, db, cache, log, seed: image });
  const instance: Running = {
    base: `http://localhost:${server.port}`,
    logs,
    db,
    recovery,
    stop() {
      cache.stop();
      server.stop(true);
      db.close();
    },
  };
  running.push(instance);
  return instance;
}

interface Health {
  status: string;
  warnings: string[];
  reset: string;
  policy: { status: string; error: string | null; revision: number | null };
  counts: Record<string, number>;
  fixture_drift: { ids: string[]; changed: string[]; missing: string[]; unexpected: string[] } | null;
}

const health = async (base: string): Promise<Health> =>
  (await (await fetch(`${base}/health`)).json()) as Health;

const pre = (base: string, tool: string, inputs: Record<string, unknown>) =>
  fetch(`${base}/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      execution_id: `tc_${Math.random().toString(36).slice(2)}`,
      tool: { name: tool, toolkit: "Loan", version: "1.0.0" },
      inputs,
      context: { authorization: [{}], user_id: DANA },
    }),
  });

const reset = (base: string, body: unknown, token: string | null = RESET_TOKEN) =>
  fetch(`${base}/admin/reset`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe("/health is 200 even when the policy will not compile (#112)", () => {
  /**
   * The image's own fixture is the broken one here, which is the only way to
   * reach this state: a *disk* that will not compile is reseeded by the
   * recovery below. So this is the genuinely unrecoverable case — a build
   * shipping a policy it cannot compile — and it is the one where a 503 used to
   * take the service off the internet.
   */
  test("boots degraded, keeps answering, and says why in the body", async () => {
    const broken = pre89Fixture();
    const instance = boot(diskSeededFrom(broken), { imageFixture: broken });

    const response = await fetch(`${instance.base}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Health;
    expect(body.status).toBe("degraded");
    expect(body.policy.status).toBe("failed");
    // The compile error, in the body, in words a human can act on.
    expect(body.policy.error).toMatch(/Approvals\.RequestApproval/);
    expect(body.warnings.join(" ")).toMatch(/Approvals_RequestApproval/);
  });

  test("and the hooks it fronts still fail closed", async () => {
    const broken = pre89Fixture();
    const instance = boot(diskSeededFrom(broken), { imageFixture: broken });

    const denied = await pre(instance.base, "GetLoan", { loan_id: "LN-2291" });
    expect(denied.status).toBe(200);
    expect(PreHookResult.parse(await denied.json()).code).toBe("CHECK_FAILED");

    const access = await fetch(`${instance.base}/access`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        user_id: DANA,
        toolkits: { Loan: { tools: { GetLoan: [{ version: "1.0.0" }] } } },
      }),
    });
    expect(AccessHookResult.parse(await access.json())).toEqual({
      deny: { Loan: { tools: { GetLoan: [{ version: "1.0.0" }] } } },
    });
  });

  test("a build that cannot compile its own fixture says so rather than promising a reset", async () => {
    const broken = pre89Fixture();
    const instance = boot(diskSeededFrom(broken), { imageFixture: broken });

    expect(instance.recovery.reseeded).toBe(false);
    expect(instance.recovery.detail).toMatch(/byte for byte the fixture/);
    expect(instance.logs.join("\n")).toContain("POLICY RECOVERY IMPOSSIBLE");
    // No drift: the rows on disk *are* the image's, which is exactly why
    // reseeding cannot help and why the message has to be a different one.
    expect((await health(instance.base)).fixture_drift).toBeNull();
  });
});

describe("fixture drift is loud (#106)", () => {
  test("a boot whose disk matches the shipped fixture reports no drift and is healthy", async () => {
    const instance = boot(diskSeededFrom(rawFixture));

    const body = await health(instance.base);
    expect(body.status).toBe("healthy");
    expect(body.fixture_drift).toBeNull();
    expect(body.warnings).toEqual([]);
  });

  /**
   * The original #106: the fixture gained a rule, the disk never did, and every
   * surface read healthy. The disk here is the pre-#17 one — the injection
   * strip with one pattern instead of six, which is what cg-hooks actually
   * served while `/health` said `armed`.
   */
  test("a disk carrying a rule the fixture has moved past is named on /health", async () => {
    const instance = boot(diskSeededFrom(pre17Fixture()));

    const body = await health(instance.base);
    expect(body.status).toBe("degraded");
    expect(body.fixture_drift?.changed).toEqual(["output_rules:post.strip-injected-instructions"]);
    expect(body.fixture_drift?.ids).toEqual(["output_rules:post.strip-injected-instructions"]);
    // Still serving policy — drift is a warning, not a refusal. Route A: a
    // stage edit survives, it just stops being invisible.
    expect(body.policy.status).toBe("ready");
    expect(body.warnings.join(" ")).toMatch(/differs from the fixture shipped in this image/);
  });

  test("the boot log names it too, so a deploy that drifts leaves a line behind", () => {
    const instance = boot(diskSeededFrom(pre17Fixture()));

    const drift = instance.logs.filter((line) => line.startsWith("FIXTURE DRIFT:"));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("output_rules:post.strip-injected-instructions");
  });

  test("a row edited live drifts within one poll, and a row deleted or added is named too", async () => {
    const instance = boot(diskSeededFrom(rawFixture));
    expect((await health(instance.base)).fixture_drift).toBeNull();

    instance.db.run("UPDATE subjects SET clearance = 250000 WHERE user_id = ?", [DANA]);
    instance.db.run("DELETE FROM policy_rules WHERE id = 'pre.decide-only-while-pending'");
    await Bun.sleep(POLL_MS * 8);

    const drift = (await health(instance.base)).fixture_drift;
    expect(drift?.changed).toEqual([`subjects:${DANA}`]);
    expect(drift?.missing).toEqual(["policy_rules:pre.decide-only-while-pending"]);
    // The clearance edit is exactly the stage edit #29 protects, and it is
    // still in force — being named is not being reverted.
    const allowed = await pre(instance.base, "ApproveLoan", {
      loan_id: "LN-2291",
      amount: 95_000,
    });
    expect(await allowed.json()).toEqual({ code: "OK" });
  });
});

describe("stale rows that cannot compile reseed themselves (#106, route A)", () => {
  /**
   * The headline: a `governance.db` seeded from the pre-#89 fixture, booted on
   * today's code. On 2026-09-14 this was a 502 and three manual reseeds.
   */
  test("a pre-#89 disk boots to a healthy service on today's image, with the fixture's rules", async () => {
    const path = diskSeededFrom(pre89Fixture());
    const instance = boot(path);

    expect(instance.recovery.reseeded).toBe(true);

    const body = await health(instance.base);
    expect(body.status).toBe("healthy");
    expect(body.policy.status).toBe("ready");
    expect(body.fixture_drift).toBeNull();

    // The rule that could not compile is now the fixture's, spelled the way the
    // model reads it — which is the whole of #89 and the reason the guard
    // refused the old row.
    const denied = await pre(instance.base, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 });
    const result = PreHookResult.parse(await denied.json());
    expect(result.code).toBe("CHECK_FAILED");
    expect(result.error_message).toContain("Approvals_RequestApproval");
    expect(result.error_message).not.toContain("Approvals.RequestApproval");
  });

  test("it is one loud line, naming what it replaced and what it left alone", () => {
    const instance = boot(diskSeededFrom(pre89Fixture()));

    const loud = instance.logs.filter((line) => line.startsWith("POLICY RECOVERY:"));
    expect(loud).toHaveLength(2);
    expect(loud[0]).toContain("does not compile");
    expect(loud[0]).toContain("policy_rules:pre.approve-within-clearance");
    expect(loud[0]).toContain("grants, approval requests and the audit log are untouched");
    expect(loud[1]).toMatch(/policy reseeded from the fixture and loaded at revision \d+/);
  });

  test("a stage edit that still compiles is preserved, however far it drifts", async () => {
    const path = diskSeededFrom(rawFixture);
    // The act 1 edit, made on stage and meant to outlive a deploy.
    const staged = new Database(path);
    staged.run("UPDATE subjects SET clearance = 1000000 WHERE user_id = ?", [DANA]);
    staged.close();

    const instance = boot(path);

    expect(instance.recovery.reseeded).toBe(false);
    expect(instance.recovery.detail).toBe("policy compiles; nothing to recover");

    const row = instance.db
      .query<{ clearance: number }, [string]>("SELECT clearance FROM subjects WHERE user_id = ?")
      .get(DANA);
    expect(row?.clearance).toBe(1_000_000);

    // Named as drift, and in force.
    const body = await health(instance.base);
    expect(body.status).toBe("degraded");
    expect(body.fixture_drift?.changed).toEqual([`subjects:${DANA}`]);
    const allowed = await pre(instance.base, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 });
    expect(await allowed.json()).toEqual({ code: "OK" });
  });

  test("a stage edit that does NOT compile is replaced, because it can never be served", async () => {
    const path = diskSeededFrom(rawFixture);
    const staged = new Database(path);
    // Somebody reworded a denial on stage and broke it: the remediation
    // sentence now names a tool the catalogue does not serve.
    staged.run(
      "UPDATE policy_rules SET reason = ? WHERE id = 'pre.approve-within-clearance'",
      ["DENIED: over your limit. Call Approvals_EscalateIt with reason=<why>."],
    );
    staged.close();

    const instance = boot(path);

    expect(instance.recovery.reseeded).toBe(true);
    expect(instance.logs.join("\n")).toContain(
      "a stage edit among them is being discarded on purpose",
    );
    expect((await health(instance.base)).status).toBe("healthy");
  });
});

describe("POST /admin/reset (#106)", () => {
  test("does not exist when RESET_TOKEN is unset, and /health says so", async () => {
    const instance = boot(diskSeededFrom(rawFixture), { config: { resetToken: "" } });

    expect((await reset(instance.base, { mode: "policy" }, null)).status).toBe(404);
    expect((await reset(instance.base, { mode: "policy" })).status).toBe(404);
    expect((await health(instance.base)).reset).toBe("disabled");
  });

  test("refuses a missing or wrong bearer, and never the hook secret", async () => {
    const instance = boot(diskSeededFrom(rawFixture));

    expect((await health(instance.base)).reset).toBe("enabled");
    expect((await reset(instance.base, { mode: "policy" }, null)).status).toBe(401);
    expect((await reset(instance.base, { mode: "policy" }, "wrong")).status).toBe(401);
    // A leaked hook signing secret cannot press this button.
    expect((await reset(instance.base, { mode: "policy" }, SECRET)).status).toBe(401);
  });

  test("policy mode replaces the four tables and leaves everything the demo did", async () => {
    const path = diskSeededFrom(pre17Fixture());
    const instance = boot(path);
    // Something happened before the reset: a decision, and a grant.
    await pre(instance.base, "GetLoan", { loan_id: "LN-2291" });
    instance.db.run(
      `INSERT INTO grants (id, subject_id, granted_by, request_id, toolkit, tool, issued_at, expires_at)
       VALUES ('g1', ?, 'riley@x', 'r1', 'Loan', 'ApproveLoan', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
      [DANA],
    );
    const before = (await health(instance.base)).counts;
    expect(before.audit_log).toBeGreaterThan(0);

    const response = await reset(instance.base, { mode: "policy" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string; revision: number };
    expect(body.mode).toBe("policy");

    const after = await health(instance.base);
    expect(after.status).toBe("healthy");
    expect(after.fixture_drift).toBeNull();
    // Untouched, by name.
    expect(after.counts.grants).toBe(1);
    expect(after.counts.audit_log).toBe(before.audit_log);
    // And the revision moved, so a cache on another connection would reload.
    expect(after.policy.revision).toBe(body.revision);
  });

  test("demo mode also clears grants, approval requests and the audit log", async () => {
    const instance = boot(diskSeededFrom(rawFixture));
    await pre(instance.base, "GetLoan", { loan_id: "LN-2291" });
    instance.db.run(
      `INSERT INTO grants (id, subject_id, granted_by, request_id, toolkit, tool, issued_at, expires_at)
       VALUES ('g1', ?, 'riley@x', 'r1', 'Loan', 'ApproveLoan', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
      [DANA],
    );
    expect((await health(instance.base)).counts.audit_log).toBeGreaterThan(0);

    const response = await reset(instance.base, { mode: "demo" });
    expect(response.status).toBe(200);

    const after = await health(instance.base);
    expect(after.counts.grants).toBe(0);
    expect(after.counts.approval_requests).toBe(0);
    expect(after.counts.audit_log).toBe(0);
    // The policy is still there — a reset seeds it, it does not empty it.
    expect(after.counts.policy_rules).toBeGreaterThan(0);
    expect(after.status).toBe("healthy");
  });

  /**
   * Emptying `audit_log` means dropping the trigger that makes it append-only
   * and putting it back. This is the test that the second half happens: a
   * compliance log that stops being enforced after the first reset is one
   * somebody can quietly shorten, which is the property the trigger exists for.
   */
  test("the audit log is append-only again afterwards, and still writable", async () => {
    const instance = boot(diskSeededFrom(rawFixture));
    await reset(instance.base, { mode: "demo" });

    // Writable: the hooks still append.
    await pre(instance.base, "GetLoan", { loan_id: "LN-2291" });
    expect((await health(instance.base)).counts.audit_log).toBe(1);

    // And that row cannot be deleted or edited by anything but another reset.
    expect(() => instance.db.run("DELETE FROM audit_log")).toThrow(/append-only/);
    expect(() => instance.db.run("UPDATE audit_log SET reason = 'x'")).toThrow(/append-only/);
    expect((await health(instance.base)).counts.audit_log).toBe(1);
  });

  test("names the two databases it deliberately does not touch", async () => {
    const instance = boot(diskSeededFrom(rawFixture));

    const body = (await (await reset(instance.base, { mode: "demo" })).json()) as {
      not_reset: Record<string, string>;
    };
    expect(Object.keys(body.not_reset).sort()).toEqual(["idp.db", "loans.db"]);
  });

  test("defaults to the narrow mode and refuses one it does not know", async () => {
    const instance = boot(diskSeededFrom(rawFixture));
    await pre(instance.base, "GetLoan", { loan_id: "LN-2291" });

    const bare = await fetch(`${instance.base}/admin/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${RESET_TOKEN}` },
    });
    expect(((await bare.json()) as { mode: string }).mode).toBe("policy");
    expect((await health(instance.base)).counts.audit_log).toBeGreaterThan(0);

    const wrong = await reset(instance.base, { mode: "everything" });
    expect(wrong.status).toBe(400);
    expect((await reset(instance.base, { mode: "policy" }, RESET_TOKEN)).status).toBe(200);
  });

  test("a reset from the running image is what fixes a stale disk, without a restart", async () => {
    // The pre-#17 disk on today's image: serving, drifted, act 4 running one
    // pattern instead of six — the state the live service was in for a
    // fortnight.
    const instance = boot(diskSeededFrom(pre17Fixture()));
    const before = await health(instance.base);
    expect(before.status).toBe("degraded");

    expect((await reset(instance.base, { mode: "policy" })).status).toBe(200);

    const after = await health(instance.base);
    expect(after.status).toBe("healthy");
    expect(after.fixture_drift).toBeNull();
    const patterns = (await (await fetch(`${instance.base}/health`)).json()) as {
      injection_detection: { patterns: number };
    };
    expect(patterns.injection_detection.patterns).toBe(6);
  });
});

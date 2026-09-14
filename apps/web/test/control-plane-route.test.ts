/**
 * The panel's window onto `cg-hooks`, against a real `cg-hooks` (#106).
 *
 * The control plane here is the actual service as a subprocess, with a
 * `governance.db` on disk this test can edit behind its back — which is the
 * only way to produce the two states that matter: a policy that drifted from
 * the shipped fixture, and one that no longer compiles. Nothing about the unit
 * under test is stubbed; what is substituted is `HOOKS_PUBLIC_HOST`, because
 * the port the OS handed the subprocess is not knowable until it has booted.
 *
 * `RESET_TOKEN` is the one credential in this system with no development
 * fallback, so the negative case — the route with no token — is a test rather
 * than an argument.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readControlPlane,
  runReset,
  type ControlPlaneReport,
  type ControlPlaneStatus,
} from "../lib/governance/control-plane.ts";
import { startHooks, type Hooks } from "./harness.ts";

const RESET_TOKEN = "reset-token-for-web-tests";
const DANA = "dana.okafor@bank.example";

let dir: string;
let dbPath: string;
let hooks: Hooks;
let config: { hooksHost: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cg-web-106-"));
  dbPath = join(dir, "governance.db");
  hooks = await startHooks({ GOVERNANCE_DB_PATH: dbPath, RESET_TOKEN });
  config = { hooksHost: hooks.host };
});

afterAll(async () => {
  hooks.process.kill();
  await hooks.process.exited;
  rmSync(dir, { recursive: true, force: true });
});

/** Every edit this file makes to the live disk is undone, so order cannot matter. */
afterEach(async () => {
  await runReset(config, "policy", RESET_TOKEN);
  await settled();
});

/** One edit on the disk, from another connection, as a stage edit is made. */
function edit(sql: string, params: unknown[] = []): void {
  const db = new Database(dbPath);
  try {
    db.run(sql, params as never);
  } finally {
    db.close();
  }
}

/** Long enough for the control plane's 250 ms revision poll to notice. */
const settled = () => Bun.sleep(400);

function reachable(report: ControlPlaneReport): ControlPlaneStatus {
  if (!report.reachable) throw new Error(`expected a reachable control plane: ${report.problem}`);
  return report;
}

describe("reading the control plane", () => {
  test("a healthy one reports no drift and an enabled reset", async () => {
    const report = reachable(await readControlPlane(config, { token: RESET_TOKEN }));

    expect(report.status).toBe("healthy");
    expect(report.fixture_drift).toBeNull();
    expect(report.policy.status).toBe("ready");
    expect(report.reset).toBe("enabled");
    expect(report.injection_detection).toEqual({ state: "armed", patterns: 6 });
  });

  test("a row edited on the disk comes back as named drift, and the policy still serves", async () => {
    edit("UPDATE subjects SET clearance = 900000 WHERE user_id = ?", [DANA]);
    await settled();

    const report = reachable(await readControlPlane(config, { token: RESET_TOKEN }));
    expect(report.status).toBe("degraded");
    expect(report.fixture_drift?.ids).toEqual([`subjects:${DANA}`]);
    // Route A: named, not reverted.
    expect(report.policy.status).toBe("ready");
  });

  test("a policy that no longer compiles comes back with the compiler's own words", async () => {
    edit("UPDATE policy_rules SET tool = 'approve_loan' WHERE id = 'pre.approve-within-clearance'");
    await settled();

    const report = reachable(await readControlPlane(config, { token: RESET_TOKEN }));
    expect(report.status).toBe("degraded");
    expect(report.policy.status).toBe("failed");
    expect(report.policy.error).toMatch(/approve_loan/);
  });

  /**
   * The state the panel could not previously distinguish from a quiet minute.
   * It has to be a rendered answer, not a thrown one — see the header of
   * `lib/governance/control-plane.ts`.
   */
  test("a control plane that cannot be reached is an answer, not an exception", async () => {
    const report = await readControlPlane(
      // A port nothing is listening on: reserved by binding :0 and released.
      { hooksHost: `localhost:${deadPort()}` },
      { token: RESET_TOKEN, timeoutMs: 1000 },
    );

    expect(report.reachable).toBe(false);
    if (report.reachable) throw new Error("unreachable");
    expect(report.problem).toMatch(/did not answer GET \/health/);
    // And it still knows whether the button should be drawn.
    expect(report.reset).toBe("enabled");
  });

  test("no RESET_TOKEN on this service means no button, whatever cg-hooks says", async () => {
    const report = reachable(await readControlPlane(config));
    expect(report.reset).toBe("no-token");
  });

  test("a token here and none on cg-hooks is called out rather than left to 404 on the press", async () => {
    const bare = await startHooks({ GOVERNANCE_DB_PATH: ":memory:" });
    try {
      const report = reachable(
        await readControlPlane({ hooksHost: bare.host }, { token: RESET_TOKEN }),
      );
      expect(report.reset).toBe("upstream-disabled");
    } finally {
      bare.process.kill();
      await bare.process.exited;
    }
  });
});

describe("running a reset through it", () => {
  test("policy mode clears drift and leaves the audit log alone", async () => {
    edit("DELETE FROM policy_rules WHERE id = 'pre.decide-only-while-pending'");
    await settled();
    expect(reachable(await readControlPlane(config, { token: RESET_TOKEN })).fixture_drift?.missing)
      .toEqual(["policy_rules:pre.decide-only-while-pending"]);

    const before = await auditRows();
    const outcome = await runReset(config, "policy", RESET_TOKEN);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/left alone/);

    const after = reachable(await readControlPlane(config, { token: RESET_TOKEN }));
    expect(after.status).toBe("healthy");
    expect(after.fixture_drift).toBeNull();
    expect(await auditRows()).toBe(before);
  });

  test("demo mode says what it cleared and what it could not", async () => {
    const outcome = await runReset(config, "demo", RESET_TOKEN);

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/audit log cleared/);
    // The one a presenter would otherwise assume moved.
    expect(outcome.detail).toMatch(/loans\.db/);
    expect(await auditRows()).toBe(0);
  });

  test("a wrong token is refused by cg-hooks, and the sentence says so", async () => {
    const outcome = await runReset(config, "policy", "not-the-token");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/HTTP 401/);
  });

  test("cg-hooks without the endpoint is named as the misconfiguration it is", async () => {
    const bare = await startHooks({ GOVERNANCE_DB_PATH: ":memory:" });
    try {
      const outcome = await runReset({ hooksHost: bare.host }, "policy", RESET_TOKEN);
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toMatch(/RESET_TOKEN is unset on cg-hooks/);
    } finally {
      bare.process.kill();
      await bare.process.exited;
    }
  });
});

async function auditRows(): Promise<number> {
  const body = (await (await fetch(`http://${hooks.host}/health`)).json()) as {
    audit_rows: number;
  };
  return body.audit_rows;
}

/**
 * A port nothing is listening on, obtained the way `tools/loan`'s
 * `conftest._free_port` does: bind `:0`, read back what the OS gave, release
 * it. This worktree owns a block of ten ports and the reviewer's owns another,
 * so no number here may be written down.
 */
function deadPort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port ?? 0;
  server.stop(true);
  if (port === 0) throw new Error("Bun.serve reported no port");
  return port;
}

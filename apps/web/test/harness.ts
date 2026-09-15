/**
 * What the approval page's tests run against: the real control plane, and a
 * stand-in for Arcade that behaves the way Arcade behaves.
 *
 * **The control plane is real.** `apps/hooks` is booted as a subprocess on an
 * OS-assigned port, the same way `tools/loan`'s suite boots `apps/loan-app`.
 * `apps/web` does not depend on it in the package graph and should not start
 * to, so a subprocess is how the two are exercised together without inventing
 * an edge between them. Its port is read off its own boot line rather than
 * chosen: this worktree owns a block of ten ports and the reviewer's owns a
 * different one, so nothing here may pick a number.
 *
 * **Arcade is a stand-in, and a faithful one.** It does what the real engine
 * does for a tool with no auth requirement: call `/pre`, and run the tool only
 * if the answer is `OK`. A `CHECK_FAILED` comes back as a failed execution
 * carrying the hook's own message. So the refusal these tests see is produced
 * by the actual pre-hook against the actual policy — the only fiction is the
 * transport.
 *
 * That stand-in lives in `scripts/arcade-stand-in.ts` and is imported here
 * rather than duplicated, because it is also the thing a person runs to drive
 * the two beats by hand (see `apps/web/README.md`). One implementation means
 * the demo a human sees and the behaviour this suite pins cannot diverge.
 *
 * What that leaves unverified is stated plainly and is not pretended away:
 * nothing here has spoken to `api.arcade.dev`. #13 registers the gateway and
 * the provider; until then the live round trip has no test in this repo.
 */
import { spawn, type Subprocess } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWebConfig, type WebConfig } from "../lib/config.ts";
import { createArcadeStandIn } from "../scripts/arcade-stand-in.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

export const REPO = REPO_ROOT;
export const HOOK_SECRET = "hook-secret-for-web-tests";
export const STORE_TOKEN = "store-token-for-web-tests";

export const DANA = "alice@bank.example";
export const SAM = "bob@bank.example";
export const RILEY = "charlie@bank.example";
export const MORGAN = "michael@bank.example";

export interface Harness {
  config: WebConfig;
  hooksHost: string;
  /** Write an escalation straight to the store, as the toolkit would. */
  escalate(overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;
  read(id: string): Promise<Record<string, unknown> | null>;
  /** Every `/pre` call the stand-in Arcade made, in order. */
  preCalls: Array<{ user_id: string; tool: string }>;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const hooks = await startHooks();
  const preCalls: Harness["preCalls"] = [];
  // The same stand-in a person runs from `bun run --cwd apps/web arcade-stand-in`,
  // in process. One implementation, so what the suite proves and what the
  // README tells someone to do cannot drift apart.
  const arcade = createArcadeStandIn({
    hooksHost: hooks.host,
    hookSigningSecret: HOOK_SECRET,
    approvalsStoreToken: STORE_TOKEN,
    onExecute: (call) => preCalls.push(call),
  });

  const config: WebConfig = {
    hooksHost: hooks.host,
    approvalsStoreToken: STORE_TOKEN,
    arcadeApiUrl: `http://localhost:${arcade.port}`,
    arcadeApiKey: "arcade-key-for-web-tests",
    approvalsToolkit: "Approvals",
    // Nothing in these suites signs anyone in or runs the agent;
    // `identity-flow.test.ts` and `tracer-bullet.test.ts` build their own
    // configurations for those. Read from an empty environment rather than
    // written out, so a new field cannot be forgotten here.
    identity: readWebConfig({}).identity,
    agent: readWebConfig({}).agent,
  };

  const store = (method: string, path: string, body?: unknown) =>
    fetch(`http://${hooks.host}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  return {
    config,
    hooksHost: hooks.host,
    preCalls,
    async escalate(overrides = {}) {
      const response = await store("POST", "/approvals", { ...ESCALATION, ...overrides });
      if (response.status !== 201) throw new Error(`escalate: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { request: Record<string, unknown> }).request;
    },
    async read(id) {
      const response = await store("GET", `/approvals/${id}`);
      if (response.status === 404) return null;
      return ((await response.json()) as { request: Record<string, unknown> }).request;
    },
    async stop() {
      arcade.stop(true);
      hooks.process.kill();
      await hooks.process.exited;
    },
  };
}

/** Act 2's escalation, as `tools/approvals` sends it. */
export const ESCALATION = {
  requester_id: DANA,
  action: "approve_loan",
  resource_id: "LN-2291",
  amount: 95_000,
  justification: "Eleven years in business, 742 credit score, $1.4M annual revenue.",
  approver_id: RILEY,
  candidate_approver_ids: [RILEY, MORGAN],
  required_clearance: 95_000,
};

// ---------------------------------------------------------------------------
// The real control plane, as a subprocess
// ---------------------------------------------------------------------------

export interface Hooks {
  host: string;
  process: Subprocess<"ignore", "pipe", "pipe">;
}

/**
 * `env` is merged over the defaults, so a caller can hand the control plane a
 * `RESET_TOKEN` or a database on disk without this function growing a
 * parameter per variable. Everything a test overrides that way is a thing
 * `render.yaml` also sets, which keeps the subprocess a deployment rather than
 * a fixture.
 */
export async function startHooks(
  env: Record<string, string> = {},
): Promise<Hooks> {
  const child = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "hooks", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // 0, so the OS picks. The service prints what it got, and that line is
      // how the port is learned — never a literal and never a guess.
      PORT: "0",
      GOVERNANCE_DB_PATH: ":memory:",
      ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
      APPROVALS_STORE_TOKEN: STORE_TOKEN,
      ARCADE_LOAN_TOOLKIT: "Loan",
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      NODE_ENV: "test",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const { port } = await readPort(child);
  return { host: `localhost:${port}`, process: child };
}

/**
 * Reads `listening on :<port>` off a service's own boot line.
 *
 * Every process this suite starts binds `:0` and prints what the OS gave it,
 * so nothing here picks a number — this worktree owns a block of ten ports and
 * another worktree owns a different block.
 */
export async function readPort(
  child: Subprocess<"ignore", "pipe", "pipe">,
): Promise<{ port: number; banner: string }> {
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let buffered = "";
  const deadline = setTimeout(() => child.kill(), 20_000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /listening on :(\d+)/.exec(buffered);
      // The banner comes back with the port so a caller can assert on what the
      // process said about itself, without racing the same stream twice.
      if (match) return { port: Number(match[1]), banner: buffered };
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  throw new Error(`apps/hooks did not report a port. Output so far:\n${buffered}`);
}

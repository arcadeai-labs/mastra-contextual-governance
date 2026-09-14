/**
 * What the tracer bullet runs against.
 *
 * The line between real and stand-in is drawn once, and it is drawn at Arcade:
 *
 * - **`apps/hooks` is real.** A subprocess, seeded from its own fixture, with
 *   the real policy compiled and the real `/pre` answering. Every denial in this
 *   suite is the actual rule refusing the actual call.
 * - **`apps/loan-app` is real.** A subprocess owning a real `loans.db`, so "the
 *   $95K prompt produces a denial, not an approval, in the loan database" is a
 *   claim about a row that either exists or does not.
 * - **The identity provider is the repo's own dev stub**, a subprocess of
 *   `apps/loan-app/scripts/dev-idp.ts`. It answers `/oauth2/userinfo` for
 *   `dev:<email>` tokens, which is how the loan API derives the actor from a
 *   bearer rather than from a parameter — the real code path, with a fixture
 *   issuer behind it.
 * - **The gateway is a stand-in**, `scripts/gateway-stand-in.ts`, and it is the
 *   only fiction. It speaks MCP, calls the real `/pre`, and runs nothing when
 *   the answer is not `OK`.
 * - **The model is a seam.** Scripted by default, real Claude when
 *   `ANTHROPIC_API_KEY` is set. See `model.ts` in this directory.
 *
 * Every port is `:0` and read back off the service's own boot line. This
 * worktree owns a block of ten and the reviewer's owns a different block, so
 * nothing here may pick a number.
 */
import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGatewayStandIn, type GatewayStandIn } from "../scripts/gateway-stand-in.ts";
import { readIdentitySurface, type IdentitySurface } from "../lib/config.ts";
import { freePort } from "./identity-harness.ts";
import { readPort } from "./harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export const HOOK_SECRET = "hook-secret-for-agent-tests";
export const STORE_TOKEN = "store-token-for-agent-tests";
export const SESSION_SECRET = "agent-suite-session-secret-0123456789";
export const GATEWAY_ID = "cg-demo-us";
export const LOAN_TOOLKIT = "Loan";

/** The four, as both fixtures seed them. Lower case — the join key (#58). */
export const DANA = "dana.okafor@bank.example";
export const SAM = "sam.reyes@bank.example";
export const RILEY = "riley.chen@bank.example";
/** Chief Credit Officer, clearance $5,000,000 — above act 3's redaction bar (#16). */
export const MORGAN = "morgan.ellis@bank.example";

/** The $95K application. Dana's authority is $50,000. */
export const OVER_LIMIT_LOAN = "LN-2291";
/** $15,500 and pending — inside Dana's authority. */
export const WITHIN_LIMIT_LOAN = "LN-2292";
/**
 * $88,000 and pending — also over Dana's authority, and **without act 4's
 * seeded prompt injection**, which only `LN-2291` carries.
 *
 * The control. `LN-2291`'s `underwriter_notes` ends in an instruction aimed at
 * whatever model reads the record. Before #16's `/post` rule stripped it the
 * model saw it: it correctly refused the injected instruction, flagged it, and
 * then about half the time ended the turn asking the officer whether to go
 * ahead — so `ApproveLoan` was never called and `/pre` never fired. Measured
 * live on #88 round 2: 4 of 9 runs reached the hook on `LN-2291`, and 6 of 6
 * on this one, with an identical prompt and an identical system prompt. With
 * `/post` live (#16) both are 5 of 5.
 *
 * Both loans are exercised. `LN-2291` is #14's beat as written and stays; this
 * one is what isolates the cause, so a future failure can be read as "the
 * injection interfered again" (#91) rather than as "the agent broke".
 */
export const CONTROL_OVER_LIMIT_LOAN = "LN-2299";

export interface AgentHarness {
  config: IdentitySurface;
  gateway: GatewayStandIn;
  hooksHost: string;
  loanAppHost: string;
  /** Every `tools/call` the gateway saw, in order, with what happened to it. */
  calls: Array<{ user_id: string; tool: string; inputs: Record<string, unknown>; outcome: string }>;
  /**
   * Every `tools/list` the gateway answered, with what `/access` took away.
   *
   * Act 1 is an absence, and an absence leaves no `calls` entry: "Sam never
   * tried to approve" and "Sam tried and nobody wrote it down" are the same
   * empty list. This is the record that tells them apart.
   */
  lists: Array<{ user_id: string; advertised: string[]; hidden: string[] }>;
  /** A gateway bearer for a persona, the way hop 1 would end. */
  tokenFor(email: string): string;
  /** The loan book's own view of an application. Read over HTTP, as anything else would. */
  loan(loanId: string, asEmail: string): Promise<Record<string, unknown>>;
  /** The control plane's audit rows, newest first. */
  audit(): Promise<Array<Record<string, unknown>>>;
  /**
   * Where this harness's `governance.db` is.
   *
   * Exposed for #22, which needs a rule that refuses a **read** in order to
   * prove the split screen renders one as a decision rather than as a crash.
   * The seeded policy has no such rule and should not grow one for a test, so
   * the test writes it into the policy database and waits for the cache to poll
   * it up — which is the same mechanism `DESIGN.md` calls "editable live on
   * stage", exercised rather than described.
   */
  governanceDbPath: string;
  /**
   * Take the loan book away, for the one test that needs a tool to fail for a
   * reason no hook had anything to do with.
   *
   * Killing a real process rather than stubbing a fetch: the failure the UI has
   * to classify is the one a real unreachable service produces, and a hand-made
   * error is a guess at its wording. Terminal by design — nothing restarts it,
   * so the test that uses it runs last in its file.
   */
  stopLoanApp(): Promise<void>;
  /**
   * Take the control plane away, for the one test that asks what a dead
   * `/access` does to the tool list.
   *
   * Terminal in the same way `stopLoanApp` is: nothing restarts it, so the test
   * that uses it runs last in its file. Killing the real process rather than
   * pointing the stand-in at a closed port, because fail-closed has to hold for
   * the failure a real outage produces.
   */
  stopHooks(): Promise<void>;
  stop(): Promise<void>;
}

export async function startAgentHarness(): Promise<AgentHarness> {
  // One directory per harness, removed on stop. `loans.db` has to be a real
  // file rather than `:memory:` — the suite asserts on rows the API wrote, and
  // an in-memory database per connection would make that vacuous.
  const workspace = join(tmpdir(), `cg-agent-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });

  // The stub IdP binds the port named in IDP_PUBLIC_HOST, not PORT — see the
  // comment at the top of that script. So the port is chosen here and handed to
  // both it and the loan API, which is what makes them agree.
  const idpPort = freePort();
  const idpHost = `localhost:${idpPort}`;
  const idp = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "loan-app", "scripts", "dev-idp.ts")],
    cwd: REPO_ROOT,
    env: { ...process.env, IDP_PUBLIC_HOST: idpHost, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await readPort(idp as Subprocess<"ignore", "pipe", "pipe">);

  const hooks = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "hooks", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      GOVERNANCE_DB_PATH: join(workspace, "governance.db"),
      ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
      APPROVALS_STORE_TOKEN: STORE_TOKEN,
      ARCADE_LOAN_TOOLKIT: LOAN_TOOLKIT,
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      LOAN_APP_PUBLIC_HOST: "localhost:1",
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const { port: hooksPort } = await readPort(hooks as Subprocess<"ignore", "pipe", "pipe">);
  const hooksHost = `localhost:${hooksPort}`;

  const loanApp = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "loan-app", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      LOANS_DB_PATH: join(workspace, "loans.db"),
      IDP_PUBLIC_HOST: idpHost,
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const { port: loanPort } = await readPort(loanApp as Subprocess<"ignore", "pipe", "pipe">);
  const loanAppHost = `localhost:${loanPort}`;

  const calls: AgentHarness["calls"] = [];
  const lists: AgentHarness["lists"] = [];
  const gateway = createGatewayStandIn({
    gatewayId: GATEWAY_ID,
    hooksHost,
    hookSigningSecret: HOOK_SECRET,
    loanAppHost,
    loanToolkit: LOAN_TOOLKIT,
    onCall: (call) => calls.push(call),
    onList: (list) => lists.push(list),
  });

  // Read from an environment rather than written out field by field, so a new
  // key on `IdentitySurface` cannot be silently forgotten here.
  const config = readIdentitySurface({
    ARCADE_API_URL: gateway.url,
    ARCADE_API_KEY: "arcade-key-for-agent-tests",
    ARCADE_GATEWAY_ID: GATEWAY_ID,
    ARCADE_LOAN_TOOLKIT: LOAN_TOOLKIT,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY?.trim() || "anthropic-key-for-agent-tests",
    MODEL_ID: process.env.MODEL_ID?.trim() || "claude-sonnet-5",
    SESSION_SECRET,
    PUBLIC_URL: "http://localhost:1",
    IDP_ISSUER: `http://${idpHost}`,
    IDP_CLIENT_ID: "web",
    IDP_CLIENT_SECRET: "not-used-in-this-suite",
  });

  return {
    config,
    gateway,
    hooksHost,
    loanAppHost,
    governanceDbPath: join(workspace, "governance.db"),
    calls,
    lists,
    tokenFor: (email) => gateway.issueToken(email),
    async loan(loanId, asEmail) {
      const response = await fetch(`http://${loanAppHost}/loans/${loanId}`, {
        headers: { authorization: `Bearer dev:${asEmail}` },
      });
      if (!response.ok) throw new Error(`GET /loans/${loanId} -> ${response.status} ${await response.text()}`);
      return (await response.json()) as Record<string, unknown>;
    },
    async audit() {
      // `GET /audit` (#62), newest first, behind the hook signing secret — the
      // same bearer Arcade presents, because rows say more than the model was
      // told. Read over HTTP rather than by opening `governance.db`: what a
      // reviewer can reconstruct is what the endpoint serves.
      const response = await fetch(`http://${hooksHost}/audit?limit=1000`, {
        headers: { authorization: `Bearer ${HOOK_SECRET}` },
      });
      if (!response.ok) throw new Error(`GET /audit -> ${response.status} ${await response.text()}`);
      const body = (await response.json()) as { rows?: Array<Record<string, unknown>> };
      return body.rows ?? [];
    },
    async stopLoanApp() {
      loanApp.kill();
      await loanApp.exited;
    },
    async stopHooks() {
      hooks.kill();
      await hooks.exited;
    },
    async stop() {
      gateway.stop();
      for (const child of [hooks, loanApp, idp]) {
        child.kill();
        await child.exited;
      }
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

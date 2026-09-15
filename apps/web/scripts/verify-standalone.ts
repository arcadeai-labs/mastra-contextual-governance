/**
 * Drives `POST /api/chat` against the **Docker image**, which is the runtime
 * Render actually serves.
 *
 * #92 is the reason this file exists. The chat route worked under `next start`,
 * passed the 18-assertion tracer bullet, and was read by three reviewers — and
 * answered 500 on Render, because `next start` resolves imports against a full
 * `node_modules` while `output: "standalone"` ships only what file tracing
 * carried. `ws`, which `@mastra/core` opens at module scope, was not carried.
 * Every local check in this repo was blind to that by construction: they all
 * ran the source, not the image.
 *
 * So the line this draws is narrow and it is the only one that was missing:
 * **the artifact under test is `docker build -f apps/web/Dockerfile .`**, and
 * the route is reached over a published port on a real socket.
 *
 *     bun run --cwd apps/web verify:standalone
 *
 * Exit status is the result. Non-zero means either a check failed or the
 * environment could not run one — "could not verify" is a failure here, not a
 * pass, because a standalone check that quietly skips is exactly the shape of
 * the gap it was written to close.
 *
 * ## What is real
 *
 * Everything the tracer bullet makes real is real here too, because this reuses
 * its harness: `apps/hooks` compiling the actual policy, `apps/loan-app` owning
 * a real `loans.db`, the dev IdP, and the gateway stand-in speaking MCP. They
 * run on the host; the container reaches the gateway through
 * `host.docker.internal`, which is what `--add-host` guarantees on a Linux
 * daemon and Docker Desktop provides already.
 *
 * The model is the one seam, as in `test/model.ts`. With no `ANTHROPIC_API_KEY`
 * the turn cannot finish — there is no model seam reachable through HTTP, so
 * the container builds the real provider from its environment — and the checks
 * stop at the line that matters: the route **loaded**, opened the transport,
 * listed the gateway's tools and selected the governed ones. That is precisely
 * the stretch #92 broke, and it is all reachable without a key. With a key, the
 * last check runs the LN-2299 turn end to end and reads the denial and the
 * `/pre` audit row back.
 *
 * The harness is imported from `test/` rather than rebuilt here. Two copies of
 * "what is real and what is a stand-in" is how the two drift.
 */
import { spawnSync } from "node:child_process";

import {
  CONTROL_OVER_LIMIT_LOAN,
  DANA,
  SESSION_SECRET,
  startAgentHarness,
  type AgentHarness,
} from "../test/agent-harness.ts";
import { decodeEvents, type ChatEvent } from "../lib/agent/events.ts";
import { freePort } from "../test/identity-harness.ts";
import { writeSession, type Session } from "../lib/identity/session.ts";

/**
 * `--image <tag>` drives an image that already exists instead of building one.
 *
 * There for the negative control. A check nobody has watched fail is a check
 * nobody knows works, and this repo's recurring failure is a control that
 * matches nothing — so point this at the image built before the fix and watch
 * check 1 go red:
 *
 *     bun run --cwd apps/web verify:standalone -- --image cg-web-92:before
 */
const imageFlag = process.argv.indexOf("--image");
const IMAGE = imageFlag === -1 ? "cg-web-standalone-verify" : (process.argv[imageFlag + 1] ?? "");
const CONTAINER = `cg-web-standalone-verify-${crypto.randomUUID().slice(0, 8)}`;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
/** The prompt #14 names, against the loan with no seeded injection in it (#91). */
const PROMPT = `Approve loan ${CONTROL_OVER_LIMIT_LOAN} for me and double-check your work so you don't make any mistakes.`;
/** A container boot plus a cold turn through a real model. */
const READY_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 240_000;

const liveKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

interface Check {
  name: string;
  ok: boolean;
  evidence: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, evidence: string): void {
  checks.push({ name, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${evidence}`);
}

function docker(args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`docker ${args[0]}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `docker ${args.join(" ")} exited ${String(result.status)}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** The cookie a browser signed in as Alice and holding a live gateway token would send. */
async function browserCookie(harness: AgentHarness): Promise<string> {
  const session: Session = {
    email: DANA,
    signed_in_at: Date.now(),
    gateway: {
      access_token: harness.tokenFor(DANA),
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-standalone-verify",
    },
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, harness.config);
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
}

async function waitForHealth(base: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "never answered";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      const text = await response.text();
      if (response.ok) return text;
      last = `${response.status} ${text.slice(0, 200)}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await Bun.sleep(500);
  }
  throw new Error(`the container never became healthy on ${base}: ${last}`);
}

async function main(): Promise<number> {
  // A check that cannot run has not passed. Say which, and fail.
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    console.error(
      "docker is not available here, so the standalone image could not be built or driven.\n" +
        "This script verifies the artifact Render runs; `next start` is not a substitute for it.",
    );
    return 1;
  }
  console.log(`docker server ${version.stdout.trim()}`);

  if (IMAGE === "") {
    console.error("--image needs a tag");
    return 2;
  }
  if (imageFlag === -1) {
    console.log(`building ${IMAGE} from apps/web/Dockerfile …`);
    const started = Date.now();
    // Both paths absolute: `-f` is resolved against this process's cwd, not the
    // build context, and `bun run --cwd apps/web` makes those two different.
    docker(["build", "-f", `${REPO_ROOT}apps/web/Dockerfile`, "-t", IMAGE, REPO_ROOT]);
    console.log(`built in ${Math.round((Date.now() - started) / 1000)}s`);
  } else {
    console.log(`driving the existing image ${IMAGE}; nothing was built`);
  }

  const harness = await startAgentHarness();
  const port = freePort();
  const base = `http://localhost:${port}`;
  const gatewayPort = new URL(harness.gateway.url).port;
  const idpPort = new URL(harness.config.identity.idpIssuer).port;

  try {
    docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `${port}:${port}`,
      ...envFlags({
        PORT: String(port),
        HOSTNAME: "0.0.0.0",
        ARCADE_API_URL: `http://host.docker.internal:${gatewayPort}`,
        ARCADE_API_KEY: harness.config.arcadeApiKey,
        ARCADE_GATEWAY_ID: harness.config.identity.gatewayId,
        ARCADE_LOAN_TOOLKIT: harness.config.agent.toolkits[0] ?? "Loan",
        ARCADE_APPROVALS_TOOLKIT: harness.config.agent.toolkits[1] ?? "Approvals",
        ANTHROPIC_API_KEY: liveKey || "standalone-verify-has-no-key",
        MODEL_ID: harness.config.agent.modelId,
        SESSION_SECRET,
        PUBLIC_URL: base,
        IDP_ISSUER: `http://host.docker.internal:${idpPort}`,
        IDP_CLIENT_ID: harness.config.identity.idpClientId,
        IDP_CLIENT_SECRET: harness.config.identity.idpClientSecret,
        APPROVALS_STORE_TOKEN: "standalone-verify-store-token",
        HOOKS_PUBLIC_HOST: harness.hooksHost,
      }),
      IMAGE,
    ]);

    const health = await waitForHealth(base);
    record("the standalone image boots and /health answers", true, health.slice(0, 220));

    // ---- 1. The route module loads at all. -------------------------------
    //
    // This is #92 in one request. `Cannot find module 'ws'` was thrown while
    // Node evaluated the route module, before any handler logic ran, so even
    // the anonymous case answered 500. A 401 here means the module evaluated.
    const anonymous = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: PROMPT }),
    });
    const anonymousBody = await anonymous.text();
    record(
      "POST /api/chat loads its module and refuses an anonymous request",
      anonymous.status === 401 && anonymousBody.includes("Sign in"),
      `${anonymous.status} ${anonymous.headers.get("content-type") ?? ""} ${anonymousBody.slice(0, 160)}`,
    );

    // ---- 2. The MCP transport works from inside the image. ---------------
    //
    // A 502 here would mean the gateway would not list its tools or advertised
    // nothing governed. A 200 means the container opened MCP, listed, selected
    // `Loan_*` and handed the model a real toolset — the whole stretch that
    // `next start` was proving and the image was not.
    const cookie = await browserCookie(harness);
    const turn = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: PROMPT }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    const body = await turn.text();
    const events = decodeEvents(body);
    record(
      "a signed-in turn reaches the gateway and streams NDJSON",
      turn.status === 200 && (turn.headers.get("content-type") ?? "").includes("x-ndjson"),
      `${turn.status} ${turn.headers.get("content-type") ?? ""}, ${events.length} event(s): ${summarise(events)}` +
        // A 502 here is "the gateway would not list its tools" or "nothing
        // governed was advertised"; 200 means the container opened MCP,
        // listed, and selected. Whatever stopped the turn after that is the
        // model, and saying so keeps the pass from reading as more than it is.
        `${firstError(events) ? ` — stopped by: ${firstError(events)}` : ""}`,
    );

    // ---- 3. The governed chain, when there is a model to run it. ---------
    if (liveKey) {
      const denied = events.find(
        (event): event is Extract<ChatEvent, { kind: "denied" }> => event.kind === "denied",
      );
      const rows = await harness.audit();
      // The same row `test/tracer-bullet.test.ts` asserts on: `/pre` refusing
      // `Loan.ApproveLoan` for Alice, attributed to the rule that made the call.
      const preRow = rows.find(
        (row) => row.hook === "pre" && row.tool === "Loan.ApproveLoan" && row.decision === "deny",
      );
      record(
        "the LN-2299 turn is denied by the control plane, with a /pre audit row",
        denied !== undefined && preRow !== undefined && preRow.user_id === DANA,
        denied
          ? `denied ${denied.tool}: ${denied.reason.slice(0, 120)} [ref ${String(denied.ref)}]; ${rows.length} audit row(s)`
          : `no denial event; ${rows.length} audit row(s); events: ${summarise(events)}`,
      );
    } else {
      console.log(
        "SKIP  the governed chain end to end\n" +
          "      ANTHROPIC_API_KEY is not set, so the container has no model to run a turn with.\n" +
          "      Checks 1 and 2 cover the whole of what #92 broke; this one covers what #14 proves.",
      );
    }
  } finally {
    const logs = docker(["logs", CONTAINER], { allowFailure: true });
    if (checks.some((check) => !check.ok)) {
      console.log("\n--- container logs ---\n" + logs.slice(-4000));
    }
    docker(["rm", "-f", CONTAINER], { allowFailure: true });
    await harness.stop();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${IMAGE}.`);
  return failed.length === 0 ? 0 : 1;
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** What ended the run, if anything did. Evidence, not an assertion. */
function firstError(events: readonly ChatEvent[]): string {
  const error = events.find(
    (event): event is Extract<ChatEvent, { kind: "error" }> => event.kind === "error",
  );
  return error ? error.message.slice(0, 160) : "";
}

function summarise(events: readonly ChatEvent[]): string {
  const kinds = new Map<string, number>();
  for (const event of events) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
  return (
    [...kinds].map(([kind, count]) => `${kind}×${count}`).join(" ") ||
    "none"
  );
}

process.exit(await main());

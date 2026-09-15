/**
 * The Arcade stand-in as a person runs it: a real subprocess, on a port the OS
 * picked, driving both beats through the real control plane.
 *
 * `harness.ts` exercises the same module in process, which proves the
 * behaviour. This file proves the *runnable* part — that
 * `bun run --cwd apps/web arcade-stand-in` starts, binds, prints the port it
 * got, says out loud that it is a stand-in, and answers `apps/web`'s own
 * client. Those are the parts the three-terminal run in `apps/web/README.md`
 * depends on, and none of them is covered by importing the function.
 *
 * It exists because the gap it closes was found by a human, not by a test: the
 * README told someone to open the approval page and press Approve, and pressing
 * it called `api.arcade.dev` with no key. The stand-in was already written and
 * only `bun test` could reach it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";

import { ApprovalRecord } from "@cg/policy-schema";

import { readWebConfig, type WebConfig } from "../lib/config.ts";
import { submitDecision } from "../lib/decide.ts";
import {
  DANA,
  HOOK_SECRET,
  MORGAN,
  REPO,
  RILEY,
  STORE_TOKEN,
  readPort,
  startHooks,
  type Hooks,
} from "./harness.ts";

let hooks: Hooks;
let standIn: Subprocess<"ignore", "pipe", "pipe">;
let config: WebConfig;
let banner = "";

beforeAll(async () => {
  hooks = await startHooks();

  // No PORT in the environment on purpose: the script must bind :0 and print
  // what it got, which is the contract the README's three-terminal run leans
  // on when a reader has not exported one.
  standIn = spawn({
    cmd: ["bun", join(REPO, "apps", "web", "scripts", "arcade-stand-in.ts")],
    cwd: join(REPO, "apps", "web"),
    env: {
      ...process.env,
      PORT: "",
      HOOKS_PUBLIC_HOST: hooks.host,
      ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
      APPROVALS_STORE_TOKEN: STORE_TOKEN,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const boot = await readPort(standIn);
  banner = boot.banner;
  config = {
    hooksHost: hooks.host,
    approvalsStoreToken: STORE_TOKEN,
    arcadeApiUrl: `http://localhost:${boot.port}`,
    // Any non-empty value: the stand-in ignores it, and an empty one would
    // make `lib/arcade.ts` add its "the key is unset" hint to any failure.
    arcadeApiKey: "not-a-real-key",
    approvalsToolkit: "Approvals",
    // Nothing in these suites signs anyone in or runs the agent;
    // `identity-flow.test.ts` and `tracer-bullet.test.ts` build their own
    // configurations for those. Read from an empty environment rather than
    // written out, so a new field cannot be forgotten here.
    identity: readWebConfig({}).identity,
    agent: readWebConfig({}).agent,
  };
});

afterAll(async () => {
  standIn?.kill();
  hooks?.process.kill();
  await Promise.all([standIn?.exited, hooks?.process.exited]);
});

const store = (method: string, path: string, body?: unknown) =>
  fetch(`http://${hooks.host}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

let request: ApprovalRecord;

beforeEach(async () => {
  const response = await store("POST", "/approvals", {
    requester_id: DANA,
    action: "approve_loan",
    resource_id: "LN-2291",
    amount: 95_000,
    justification: "Eleven years in business.",
    approver_id: RILEY,
    candidate_approver_ids: [RILEY, MORGAN],
    required_clearance: 95_000,
  });
  expect(response.status).toBe(201);
  request = ((await response.json()) as { request: ApprovalRecord }).request;
});

const read = async () =>
  ((await (await store("GET", `/approvals/${request.id}`)).json()) as {
    request: ApprovalRecord;
  }).request;

const press = (userId: string, decision: "approved" | "denied") =>
  submitDecision({ userId, requestId: request.id, decision, note: null }, config);

describe("the stand-in a person runs", () => {
  test("bound a port it was not given, and said it is not the product", async () => {
    // Both halves of the boot contract: never a hard-coded port, and never
    // mistakable for Arcade. A fixture that reads as the product is how a demo
    // ends up quoted as evidence of the product.
    expect(config.arcadeApiUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(config.arcadeApiUrl).not.toContain(":3000");

    expect(banner).toContain("STAND-IN for Arcade");
    expect(banner).toContain("not the product");
    expect(banner).toContain("local demos only");
    // And it names the control plane it will ask, so a reader can see at a
    // glance whether it is pointed at the right one.
    expect(banner).toContain(hooks.host);
  });

  test("Charlie approves: the decision is recorded through the real pre-hook", async () => {
    const result = await press(RILEY, "approved");

    expect(result).toEqual({
      state: "recorded",
      decision: "approved",
      message: `Recorded as approved by ${RILEY}.`,
    });
    expect(await read()).toMatchObject({ status: "approved", decided_by: RILEY });
  });

  test("Alice pressing her own link gets CHECK_FAILED, and the request is untouched", async () => {
    const result = await press(DANA, "approved");

    expect(result.state).toBe("refused");
    // The hook's own words, carried through the stand-in verbatim — not a
    // fixture's idea of a denial.
    expect(result.state === "refused" && result.message).toContain("separation of duties");
    expect(result.state === "refused" && result.message).toMatch(
      /\[ref evt_[0-9a-hj-km-np-tv-z]{10}\]$/,
    );
    expect(await read()).toMatchObject({ status: "pending", decided_by: null });
  });

  test("it runs nothing when the pre-hook refuses", async () => {
    // The claim that makes the stand-in worth shipping rather than mocking: it
    // cannot answer at all without asking the control plane, and a refusal
    // stops it before the tool.
    await press(DANA, "approved");
    expect(await read()).toMatchObject({ status: "pending" });

    // And the same request is still decidable by the person who may.
    expect((await press(RILEY, "denied")).state).toBe("recorded");
    expect(await read()).toMatchObject({ status: "denied", decided_by: RILEY });
  });

  test("an unset ARCADE_API_KEY is named as the cause, and stays a fault", async () => {
    // What the human actually hit: the page said "Arcade answered 401" and
    // nothing said the key was empty or that there is an offline path.
    const arcade = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "Unauthorized" } }, { status: 401 }),
    });
    try {
      const result = await submitDecision(
        { userId: RILEY, requestId: request.id, decision: "approved", note: null },
        { ...config, arcadeApiUrl: `http://localhost:${arcade.port}`, arcadeApiKey: "" },
      );

      // A fault, not a refusal: no control has spoken.
      expect(result.state).toBe("failed");
      const message = result.state === "failed" ? result.message : "";
      expect(message).toContain("ARCADE_API_KEY is unset");
      expect(message).toContain("apps/web/README.md");
      expect(message).not.toContain("CHECK_FAILED");
      expect(await read()).toMatchObject({ status: "pending" });
    } finally {
      arcade.stop(true);
    }
  });

  test("with a key set, a failure is reported without the offline hint", async () => {
    const arcade = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "Bad gateway" } }, { status: 502 }),
    });
    try {
      const result = await submitDecision(
        { userId: RILEY, requestId: request.id, decision: "approved", note: null },
        { ...config, arcadeApiUrl: `http://localhost:${arcade.port}` },
      );
      expect(result.state).toBe("failed");
      expect(result.state === "failed" && result.message).not.toContain("ARCADE_API_KEY");
    } finally {
      arcade.stop(true);
    }
  });

  test("a tool it cannot execute is a failure, not a refusal", async () => {
    const response = await fetch(`${config.arcadeApiUrl}/v1/tools/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool_name: "Loan.GetLoan",
        input: { loan_id: "LN-2291" },
        user_id: RILEY,
      }),
    });
    const body = (await response.json()) as { success: boolean; output: { error: { message: string; code?: string } } };

    expect(body.success).toBe(false);
    expect(body.output.error.message).toContain("only runs Approvals.Decide");
    // Not CHECK_FAILED: nothing refused this, the fixture just has no tool.
    expect(body.output.error.code).toBeUndefined();
  });
});

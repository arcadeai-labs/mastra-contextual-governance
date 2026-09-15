/**
 * `event: approval` on `GET /events` — the resume trigger for #20's second
 * half, driven over a real socket against the real service.
 *
 * Four claims, and the third is the one that matters:
 *
 * 1. A recorded decision reaches an open stream as `event: approval`, carrying
 *    the request id and the requester so a browser can tell whether it is the
 *    one waiting.
 * 2. The frame carries **no `id:` line**, so the governance replay — which is
 *    defined over `audit_log` and has no row for this — is untouched. Asserted
 *    on the bytes, not on a parsed object, because that is the only place the
 *    absence of a field is visible.
 * 3. **The grant is already usable when the notice arrives.** The transaction
 *    that records `approved` is also the one that turns the pre-hook's pending
 *    grant on; a notice published before it would tell a browser to retry
 *    against a grant that is still `pending` and therefore still refused —
 *    round 1 of #52's review, one layer up. This is checked by making the
 *    *retry itself* the assertion: the moment the frame lands, a `/pre` on
 *    `Loan.ApproveLoan` is fired and must be allowed.
 * 4. The panel is unaffected: a client filtering on `event: governance` — which
 *    is what `apps/web/lib/governance/subscribe.ts` does — never sees one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createEventBus, type EventBus } from "@cg/governance-core";
import { ApprovalNotice, PreHookResult, type ApprovalRecord } from "@cg/policy-schema";

import {
  APPROVAL_EVENT_NAME,
  createApprovalNoticeBus,
  type ApprovalNoticeBus,
} from "../src/approval-notices.ts";
import type { HooksConfig } from "../src/config.ts";
import { GOVERNANCE_EVENT_NAME } from "../src/events.ts";
import { allGrants } from "../src/grants-store.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";
import { openEventStream } from "./sse-reader.ts";

const DANA = "alice@bank.example";
const RILEY = "charlie@bank.example";
const MORGAN = "michael@bank.example";

const HOOK_SECRET = "hook-secret-for-tests";
const STORE_TOKEN = "store-token-for-tests";

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: HOOK_SECRET,
  approvalsStoreToken: STORE_TOKEN,
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: 10_000,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: "",
};

/** Act 2's escalation, as `tools/approvals` sends it. */
const ESCALATION = {
  requester_id: DANA,
  action: "approve_loan",
  resource_id: "LN-2291",
  amount: 95_000,
  justification: "Eleven years in business, 742 credit score, $1.4M annual revenue.",
  approver_id: RILEY,
  candidate_approver_ids: [RILEY, MORGAN],
  required_clearance: 95_000,
};

let db: Database;
let cache: PolicyCache;
let bus: EventBus;
let notices: ApprovalNoticeBus;
let server: ReturnType<typeof createServer>;
let base: string;

beforeEach(() => {
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { pollMs: config.policyPollMs });
  cache.start();
  bus = createEventBus({});
  notices = createApprovalNoticeBus({});
  server = createServer({ config, db, cache, bus, notices, log: () => {}, streamKeepAliveMs: 60 });
  base = `http://localhost:${server.port}`;
});

afterEach(() => {
  cache.stop();
  server.stop(true);
  db.close();
});

const store = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

async function escalate(): Promise<ApprovalRecord> {
  const response = await store("POST", "/approvals", ESCALATION);
  expect(response.status).toBe(201);
  return ((await response.json()) as { request: ApprovalRecord }).request;
}

/** One `/pre` call, exactly as Arcade makes it. */
async function pre(
  userId: string,
  toolkit: string,
  name: string,
  inputs: Record<string, unknown>,
): Promise<PreHookResult> {
  const response = await fetch(`${base}/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HOOK_SECRET}` },
    body: JSON.stringify({
      execution_id: `tc_${Math.random().toString(36).slice(2, 10)}`,
      tool: { name, toolkit, version: "1.0.0" },
      inputs,
      context: { authorization: [{}], user_id: userId },
    }),
  });
  expect(response.status).toBe(200);
  return PreHookResult.parse(await response.json());
}

/**
 * The whole of act 2 up to the decision: Alice is refused, the escalation is
 * written, Charlie's click passes `/pre` and mints a pending grant.
 *
 * Everything here is the real service answering real HTTP; nothing shortcuts
 * to the database.
 */
async function upToTheClick(): Promise<ApprovalRecord> {
  const refused = await pre(DANA, "Loan", "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 });
  expect(refused.code).toBe("CHECK_FAILED");

  const request = await escalate();
  const decide = await pre(RILEY, "Approvals", "Decide", {
    request_id: request.id,
    decision: "approved",
  });
  expect(decide.code).toBe("OK");
  return request;
}

describe("a recorded decision announces itself on the stream", () => {
  test("an approval arrives as `event: approval` naming the request and the requester", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    // Everything so far is hook decisions, which are governance frames.
    await reader.settle();
    const before = reader.frames.length;

    const response = await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: "Approved — collateral verified.",
      decided_by: RILEY,
    });
    expect(response.status).toBe(200);

    await reader.untilFrames(before + 1);
    const frame = reader.frames.at(-1);
    expect(frame?.event).toBe(APPROVAL_EVENT_NAME);

    // Parsed against the shared schema, so `apps/web` and this service cannot
    // drift: the frame is typed by `@cg/policy-schema`, like every other thing
    // that crosses between them.
    const notice = ApprovalNotice.parse(JSON.parse(frame?.data ?? "null"));
    expect(notice.kind).toBe("approval.granted");
    expect(notice.request_id).toBe(request.id);
    // The address. A client resumes only when this is the persona signed in on
    // that browser.
    expect(notice.requester_id).toBe(DANA);
    expect(notice.status).toBe("approved");
    expect(notice.action).toBe("approve_loan");
    expect(notice.resource_id).toBe("LN-2291");
    expect(notice.amount).toBe(95_000);
    expect(notice.decided_by).toBe(RILEY);
    expect(notice.grants_activated).toBe(1);

    reader.abort();
  });

  test("a denial arrives too, as `approval.denied`, and activates nothing", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    await reader.settle();
    const before = reader.frames.length;

    const response = await store("POST", `/approvals/${request.id}/decision`, {
      decision: "denied",
      note: "Concentration risk in this sector.",
      decided_by: RILEY,
    });
    expect(response.status).toBe(200);

    await reader.untilFrames(before + 1);
    const notice = ApprovalNotice.parse(JSON.parse(reader.frames.at(-1)?.data ?? "null"));
    expect(notice.kind).toBe("approval.denied");
    expect(notice.status).toBe("denied");
    expect(notice.grants_activated).toBe(0);

    // And the grant the pre-hook minted is void, not merely un-activated.
    expect(allGrants(db).map((stored) => stored.lifecycle)).toEqual(["void"]);

    reader.abort();
  });

  test("a decision that changed nothing announces nothing", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });
    await reader.settle();
    const after = reader.frames.length;

    // The losing half of the compare-and-swap. It settles nothing, so it
    // announces nothing — a second notice would tell a browser to start a
    // second turn on an approval that was already spent.
    const second = await store("POST", `/approvals/${request.id}/decision`, {
      decision: "denied",
      note: null,
      decided_by: MORGAN,
    });
    expect(second.status).toBe(409);
    await reader.settle();
    expect(reader.frames.length).toBe(after);

    reader.abort();
  });
});

describe("the frame takes no part in the governance replay", () => {
  test("it carries no `id:` line at all", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });
    await reader.untilFrames(1);
    await reader.settle();

    const approval = reader.frames.filter((frame) => frame.event === APPROVAL_EVENT_NAME);
    expect(approval).toHaveLength(1);
    // `null` here means the reader never saw an `id:` line in that block —
    // which is what leaves a spec-compliant client's `Last-Event-ID` where it
    // was, and what stops the panel asking this log to replay from an anchor
    // it cannot place.
    expect(approval[0]?.id).toBeNull();

    // Read off the bytes as well, because "the parser reported null" and "the
    // line is absent" are not the same statement.
    const block = reader
      .raw()
      .split("\n\n")
      .find((part) => part.includes(`event: ${APPROVAL_EVENT_NAME}`));
    expect(block).toBeDefined();
    expect(block).not.toContain("\nid: ");

    reader.abort();
  });

  test("a governance-only client — the panel — never sees one", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });
    await reader.untilFrames(1);
    await reader.settle();

    // The filter `apps/web/lib/governance/subscribe.ts` applies, spelled out
    // rather than imported: this package cannot import an app.
    const governance = reader.frames.filter((frame) => frame.event === GOVERNANCE_EVENT_NAME);
    expect(governance.length).toBeGreaterThan(0);
    for (const frame of governance) {
      // Every one is an audit row with an id, exactly as before #20's resume
      // half added a second name to this socket.
      expect(frame.id).toMatch(/^evt_[0-9a-hj-km-np-tv-z]{10}$/);
      expect(JSON.parse(frame.data)).toHaveProperty("hook");
    }

    reader.abort();
  });
});

describe("the notice is published after the grant is usable, not before", () => {
  test("a retry fired the instant the frame lands passes /pre", async () => {
    const reader = await openEventStream(base);
    const request = await upToTheClick();
    await reader.settle();
    const before = reader.frames.length;

    // Pending until the store records the decision. This is the state a notice
    // published one line too early would be announcing.
    expect(allGrants(db).map((stored) => stored.lifecycle)).toEqual(["pending"]);

    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });
    await reader.untilFrames(before + 1);
    expect(reader.frames.at(-1)?.event).toBe(APPROVAL_EVENT_NAME);

    // The retry, made as a browser would make it: on the frame, with no wait
    // and no poll in between. The assertion is the whole ordering claim — if
    // the notice could ever precede the commit, this is the call that fails.
    const retry = await pre(DANA, "Loan", "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 });
    expect(retry.code).toBe("OK");

    reader.abort();
  });
});

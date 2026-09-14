/**
 * Two decisions in flight at once, and the grant that must not survive the
 * wrong one winning.
 *
 * Round 1 of #52's review drove this by hand and it worked: both `Decide`
 * calls pass `/pre` while the request is still `pending`, the approving one
 * mints a grant, the denial is recorded first, the approval's store write
 * loses with a `409` — and `Loan.ApproveLoan` then returned `OK` against a
 * request whose recorded outcome was `denied`.
 *
 * These tests close the class rather than that sequence. A grant is minted
 * `pending`, and only the transaction that records the winning decision as
 * `approved` turns it on; a recorded `denied` voids it in that same
 * transaction. So the property below is not "the sequence the reviewer ran now
 * passes" — it is that across **every** interleaving of the four operations,
 * a grant is usable only when the recorded status is `approved`. Nothing in it
 * depends on timing, because nothing in the mechanism does.
 *
 * All of it over real HTTP against the real service on an OS-assigned port.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { PreHookResult, type ApprovalRecord } from "@cg/policy-schema";

import { recent } from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { allGrants } from "../src/grants-store.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const DANA = "dana.okafor@bank.example";
const RILEY = "riley.chen@bank.example";
const MORGAN = "morgan.ellis@bank.example";

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
};

let db: Database;
let cache: PolicyCache;
let server: ReturnType<typeof createServer> | null = null;
let base = "";

beforeEach(() => {
  server?.stop(true);
  cache?.stop();
  db?.close();
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { pollMs: config.policyPollMs });
  cache.start();
  server = createServer({ config, db, cache, log: () => {} });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  cache?.stop();
  db?.close();
});

// ---------------------------------------------------------------------------
// The four operations, over the wire
// ---------------------------------------------------------------------------

const hook = (body: unknown) =>
  fetch(`${base}/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HOOK_SECRET}` },
    body: JSON.stringify(body),
  });

const store = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

async function pre(
  userId: string,
  toolkit: string,
  name: string,
  inputs: Record<string, unknown>,
): Promise<PreHookResult> {
  const response = await hook({
    execution_id: "tc_race",
    tool: { name, toolkit, version: "1.0.0" },
    inputs,
    context: { authorization: [{}], user_id: userId },
  });
  expect(response.status).toBe(200);
  return PreHookResult.parse(await response.json());
}

async function escalate(resourceId: string): Promise<ApprovalRecord> {
  const response = await store("POST", "/approvals", {
    requester_id: DANA,
    action: "approve_loan",
    resource_id: resourceId,
    amount: 95_000,
    justification: "Eleven years in business.",
    approver_id: RILEY,
    candidate_approver_ids: [RILEY, MORGAN],
    required_clearance: 95_000,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { request: ApprovalRecord }).request;
}

/** `/pre` for `Approvals.Decide`, as Riley. Authorizes; records nothing. */
const authorize = (id: string, decision: "approved" | "denied") =>
  pre(RILEY, "Approvals", "Decide", { request_id: id, decision });

/** The store write the tool makes after `/pre` said OK. */
const record = (id: string, decision: "approved" | "denied") =>
  store("POST", `/approvals/${id}/decision`, { decision, note: null, decided_by: RILEY });

/** Dana's retry of the call that was blocked in the first place. */
const retry = (resourceId: string) =>
  pre(DANA, "Loan", "ApproveLoan", { loan_id: resourceId, amount: 95_000 });

/** The most recent audit row for one tool. */
const lastRowFor = (tool: string) =>
  recent(db, 50).find((event) => event.tool === tool);

const statusOf = async (id: string): Promise<string> =>
  ((await (await store("GET", `/approvals/${id}`)).json()) as { request: ApprovalRecord }).request
    .status;

// ---------------------------------------------------------------------------

describe("the reviewer's sequence, verbatim", () => {
  test("an approval that loses to a denial leaves nothing usable behind", async () => {
    const request = await escalate("LN-CONCURRENT");

    // Both decisions authorize: the request is still pending, so both pass the
    // "a decision is final" rule. This is the in-flight window, and it is real.
    expect((await authorize(request.id, "approved")).code).toBe("OK");
    expect((await authorize(request.id, "denied")).code).toBe("OK");

    // The denial is recorded first and wins the compare-and-swap.
    const denial = await record(request.id, "denied");
    expect(denial.status).toBe(200);
    expect(await statusOf(request.id)).toBe("denied");

    // The approval's store write arrives second and loses.
    expect((await record(request.id, "approved")).status).toBe(409);
    expect(await statusOf(request.id)).toBe("denied");

    // The finding: this returned OK before the fix.
    const blocked = await retry("LN-CONCURRENT");
    expect(blocked.code).toBe("CHECK_FAILED");
    expect((blocked as { error_message: string }).error_message).toContain(
      "exceeds your approval authority",
    );

    // And the row that was minted is voided, not merely ignored: `revoked_at`
    // is set too, so `GrantChecker` refuses it on the record's own terms even
    // if somebody later reads the table without consulting the status.
    const grants = allGrants(db);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.lifecycle).toBe("void");
    expect(grants[0]?.voided_at).toBeString();
    expect(grants[0]?.grant.revoked_at).toBeString();
    expect(grants[0]?.grant.uses_remaining).toBe(1);
  });

  test("the mirror image: a denial that loses to an approval blocks nothing", async () => {
    const request = await escalate("LN-MIRROR");

    expect((await authorize(request.id, "denied")).code).toBe("OK");
    expect((await authorize(request.id, "approved")).code).toBe("OK");

    // The approval is recorded first and wins.
    expect((await record(request.id, "approved")).status).toBe(200);
    expect((await record(request.id, "denied")).status).toBe(409);
    expect(await statusOf(request.id)).toBe("approved");

    const allowed = await retry("LN-MIRROR");
    expect(allowed.code).toBe("OK");

    const grants = allGrants(db);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.lifecycle).toBe("active");
    expect(grants[0]?.grant.uses_remaining).toBe(0);
  });

  test("an approval recorded, then a late denial: nothing changes and the grant stays good once", async () => {
    const request = await escalate("LN-LATE");

    expect((await authorize(request.id, "approved")).code).toBe("OK");
    expect((await record(request.id, "approved")).status).toBe(200);

    // The late attempt changes nothing, and — the part that matters — voids
    // nothing it did not win the right to void.
    expect((await record(request.id, "denied")).status).toBe(409);
    expect(await statusOf(request.id)).toBe("approved");
    expect(allGrants(db)[0]?.lifecycle).toBe("active");
    expect(allGrants(db)[0]?.grant.revoked_at).toBeNull();

    // Good exactly once, which is what single use means.
    expect((await retry("LN-LATE")).code).toBe("OK");
    expect((await retry("LN-LATE")).code).toBe("CHECK_FAILED");
    expect(allGrants(db)[0]?.grant.uses_remaining).toBe(0);
  });

  test("a grant minted but never recorded authorises nothing", async () => {
    // The `Decide` tool call passed `/pre` and then never reached the store —
    // Arcade timed out, the worker died, the network dropped it. The request
    // is still pending, so the grant is still pending, so it is not authority.
    const request = await escalate("LN-ORPHAN");
    expect((await authorize(request.id, "approved")).code).toBe("OK");

    expect(await statusOf(request.id)).toBe("pending");
    expect(allGrants(db)[0]?.lifecycle).toBe("pending");
    expect((await retry("LN-ORPHAN")).code).toBe("CHECK_FAILED");
  });

  test("a grant that is not considered says so in the audit row", async () => {
    const request = await escalate("LN-LOUD");
    await authorize(request.id, "approved");
    await authorize(request.id, "denied");
    await record(request.id, "denied");

    await retry("LN-LOUD");

    const row = lastRowFor("Loan.ApproveLoan");
    // A grant that was present and ignored must be visible as exactly that. A
    // control that fires silently is indistinguishable from one that did not.
    expect(row?.reason).toContain("was not considered");
    expect(row?.reason).toContain("voided");
    expect(row?.reason).toContain(request.id);
  });
});

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

/**
 * The four operations, run in every order.
 *
 * `A`/`D` are the two `/pre` authorizations, `a`/`d` the two store writes. Each
 * is allowed to fail — a store write on a settled request is a `409`, a `/pre`
 * on a settled request is a `CHECK_FAILED`, and both are ordinary outcomes
 * here rather than test failures. What is asserted is the invariant that has to
 * hold whatever happened:
 *
 *     the retry succeeds  ⟹  the recorded status is `approved`
 *
 * One direction only, and deliberately. The converse is false and should be:
 * an approval written straight to the store, with no `/pre` behind it, leaves a
 * request reading `approved` and no grant at all — the no-bypass control
 * working. What must never happen is the other way round.
 */
const OPERATIONS = ["A", "D", "a", "d"] as const;
type Operation = (typeof OPERATIONS)[number];

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

const ORDERS = permutations(OPERATIONS);

describe("across every interleaving", () => {
  test(`a grant is usable only when the recorded status is approved (${ORDERS.length} orders)`, async () => {
    expect(ORDERS).toHaveLength(24);
    const usableWhenApproved: string[] = [];

    for (const [index, order] of ORDERS.entries()) {
      const resource = `LN-ORDER-${index}`;
      const request = await escalate(resource);

      for (const step of order as Operation[]) {
        if (step === "A") await authorize(request.id, "approved");
        else if (step === "D") await authorize(request.id, "denied");
        else if (step === "a") await record(request.id, "approved");
        else await record(request.id, "denied");
      }

      const status = await statusOf(request.id);
      const result = await retry(resource);
      const where = `order ${order.join("")}`;

      if (result.code === "OK") {
        // The invariant. Before the fix, `DAda` and `ADda` broke it.
        expect(status, `${where}: the retry succeeded`).toBe("approved");
        const grants = allGrants(db).filter((g) => g.grant.request_id === request.id);
        expect(grants, `${where}: exactly one grant`).toHaveLength(1);
        expect(grants[0]?.lifecycle, `${where}: it was active`).toBe("active");
        usableWhenApproved.push(where);
      } else {
        // Nothing usable is left behind by an order that did not succeed.
        const grants = allGrants(db).filter((g) => g.grant.request_id === request.id);
        for (const grant of grants) {
          expect(grant.lifecycle, `${where}: no active grant survives`).not.toBe("active");
        }
      }

      // Whatever happened, no order may leave the request pending *and* a
      // usable grant behind — the two halves of the same fact.
      if (status !== "approved") {
        const active = allGrants(db).filter(
          (g) => g.grant.request_id === request.id && g.lifecycle === "active",
        );
        expect(active, `${where}: status ${status} with an active grant`).toHaveLength(0);
      }
    }

    // A guard against the test passing because nothing ever worked: the orders
    // where the approval genuinely wins must actually succeed.
    expect(usableWhenApproved.length).toBeGreaterThan(0);
  });
});

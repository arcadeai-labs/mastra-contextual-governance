/**
 * The four `/approvals` endpoints, driven over real HTTP against the real
 * service on an OS-assigned port.
 *
 * This is the TypeScript counterpart of
 * `tools/approvals/tests/test_store_contract.py`, which drives the same
 * contract against a Python stand-in. Both exist on purpose: the Python one
 * says what the toolkit was built against, this one says what the service
 * actually serves, and a difference between them is the bug neither would
 * catch alone.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { ApprovalRecord } from "@cg/policy-schema";

import type { HooksConfig } from "../src/config.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

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

/** The escalation act 2 produces, as `tools/approvals` sends it. */
const ACT_TWO = {
  requester_id: DANA,
  action: "approve_loan",
  resource_id: "LN-2291",
  amount: 95_000,
  justification: "Eleven years in business, 742 credit score, $1.4M annual revenue.",
  approver_id: RILEY,
  candidate_approver_ids: [RILEY, MORGAN],
  required_clearance: 95_000,
};

/**
 * Every field the contract in `tools/approvals/README.md` says a record
 * carries — the same tuple `tools/approvals/tests/conftest.py` pins, so a
 * field dropped on one side is a failing test on both.
 */
const RECORD_FIELDS = [
  "id",
  "requester_id",
  "requester_display_name",
  "approver_id",
  "approver_display_name",
  "candidate_approver_ids",
  "action",
  "resource_id",
  "amount",
  "required_clearance",
  "rule",
  "justification",
  "status",
  "created_at",
  "decided_at",
  "decided_by",
  "note",
].sort();

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

const call = (
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown } = {},
) => {
  const token = options.token === undefined ? STORE_TOKEN : options.token;
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    // fetch() refuses a body on GET, so the bearer sweep below passes one only
    // where the verb takes it.
    ...(options.body !== undefined && method !== "GET" && { body: JSON.stringify(options.body) }),
  });
};

const create = async (overrides: Partial<typeof ACT_TWO> = {}) => {
  const response = await call("POST", "/approvals", { body: { ...ACT_TWO, ...overrides } });
  const body = (await response.json()) as { request: unknown; error?: string };
  return { response, body };
};

const ENDPOINTS: ReadonlyArray<[string, string]> = [
  ["GET", "/approvals/roster"],
  ["GET", "/approvals/apr_000000000001"],
  ["POST", "/approvals"],
  ["POST", "/approvals/apr_000000000001/decision"],
];

describe("authorization", () => {
  test.each(ENDPOINTS)("%s %s refuses a call with no bearer", async (method, path) => {
    // Without this, anyone on the internet could manufacture the approval
    // request a human then acts on — or read one they were never sent.
    expect((await call(method, path, { token: null, body: {} })).status).toBe(401);
  });

  test.each(ENDPOINTS)("%s %s refuses the wrong bearer", async (method, path) => {
    expect((await call(method, path, { token: "not-the-token", body: {} })).status).toBe(401);
  });

  test("the hook signing secret is not accepted on the approvals endpoints", async () => {
    // Two secrets, two audiences. A leaked store token must not be able to
    // forge a hook decision, and Arcade's secret must not be able to write an
    // approval record a human then acts on.
    expect((await call("GET", "/approvals/roster", { token: HOOK_SECRET })).status).toBe(401);
  });

  test("the approvals store token is not accepted on a hook", async () => {
    const response = await fetch(`${base}/pre`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("an unknown path under /approvals is a 404, but only after the bearer", async () => {
    expect((await call("GET", "/approvals/a/b/c", { token: null })).status).toBe(401);
    expect((await call("GET", "/approvals/a/b/c")).status).toBe(404);
  });
});

describe("GET /approvals/roster", () => {
  test("returns every subject the control plane knows, with the fields routing needs", async () => {
    const response = await call("GET", "/approvals/roster");
    expect(response.status).toBe(200);
    const { subjects } = (await response.json()) as {
      subjects: Array<Record<string, unknown>>;
    };

    // The whole roster, because who was *not* asked is as load-bearing as who was.
    expect(subjects.map((s) => s.user_id).sort()).toEqual(
      ["alice@bank.example", "bob@bank.example", "charlie@bank.example", "michael@bank.example"],
    );
    for (const subject of subjects) {
      expect(Object.keys(subject).sort()).toEqual(
        ["attributes", "clearance", "display_name", "role", "user_id"],
      );
    }
  });
});

describe("POST /approvals", () => {
  test("mints the id and the clock, and answers 201 with the whole record", async () => {
    const { response, body } = await create();
    expect(response.status).toBe(201);

    const record = ApprovalRecord.parse(body.request);
    expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
    // An id the toolkit invented is an id the model could predict, and
    // therefore ask about before anyone had approved it.
    expect(record.id).toMatch(/^apr_[0-9a-hj-km-np-tv-z]{12}$/);
    expect(record.created_at).toEndWith("Z");
    expect(record.status).toBe("pending");
    expect(record.decided_at).toBeNull();
    expect(record.decided_by).toBeNull();
    expect(record.note).toBeNull();
  });

  test("resolves display names from the roster, so the page need not join", async () => {
    const { body } = await create();
    const record = ApprovalRecord.parse(body.request);
    expect(record.requester_display_name).toBe("Alice");
    expect(record.approver_display_name).toBe("Charlie");
  });

  test("names the rule the blocked call actually tripped", async () => {
    // Not remembered and not guessed: the control plane re-evaluates the call
    // Alice was refused and reports the rule that refused it.
    const { body } = await create();
    const record = ApprovalRecord.parse(body.request);
    expect(record.rule).toEqual({
      id: "pre.approve-within-clearance",
      description: expect.stringContaining("Act 2"),
    });
  });

  test("reports rule as null, not absent, when no rule refuses the call", async () => {
    // Michael's $5M clearance covers $95K, so nothing denies her the call. An
    // absent key and a key set to null serialise differently; the contract
    // says null.
    const { body } = await create({ requester_id: MORGAN, approver_id: RILEY });
    const record = ApprovalRecord.parse(body.request);
    expect(record.rule).toBeNull();
    expect(Object.keys(record)).toContain("rule");
  });

  test("refuses an action no governed toolkit serves, rather than storing one that can never be granted", async () => {
    const { response, body } = await create({ action: "wire_funds" });
    expect(response.status).toBe(422);
    expect(body.error).toContain("WireFunds");
  });

  test("refuses a malformed body", async () => {
    const response = await call("POST", "/approvals", { body: { requester_id: DANA } });
    expect(response.status).toBe(400);
  });
});

describe("GET /approvals/{id}", () => {
  test("returns the same record the create returned, field for field", async () => {
    const created = ApprovalRecord.parse((await create()).body.request);

    const response = await call("GET", `/approvals/${created.id}`);
    expect(response.status).toBe(200);
    const read = ApprovalRecord.parse(((await response.json()) as { request: unknown }).request);

    // A page that can render the read is a page that can render the write.
    expect(read).toEqual(created);
  });

  test("carries everything the approval page has to show from an opaque id", async () => {
    const created = ApprovalRecord.parse((await create()).body.request);
    const read = ApprovalRecord.parse(
      ((await (await call("GET", `/approvals/${created.id}`)).json()) as { request: unknown })
        .request,
    );

    expect(read.requester_display_name).toBe("Alice");
    expect(read.action).toBe("approve_loan");
    expect(read.resource_id).toBe("LN-2291");
    expect(read.amount).toBe(95_000);
    expect(read.rule?.id).toBe("pre.approve-within-clearance");
    expect(read.justification).toBe(ACT_TWO.justification);
    expect(read.candidate_approver_ids[0]).toBe(RILEY);
  });

  test("a 404 names the id it could not find", async () => {
    const response = await call("GET", "/approvals/apr_nosuchthing");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("apr_nosuchthing");
  });

  test("the read takes no viewer and answers every caller alike", async () => {
    // The requester can read the DM she sent, so anyone holding the link
    // reaches this endpoint. There is nowhere in the contract to put a viewer,
    // which makes that structural rather than a promise.
    const created = ApprovalRecord.parse((await create()).body.request);
    const first = await (await call("GET", `/approvals/${created.id}`)).text();
    const second = await (await call("GET", `/approvals/${created.id}`)).text();
    expect(first).toBe(second);
    expect(first).not.toContain("viewer");
  });
});

describe("POST /approvals/{id}/decision", () => {
  test("records the outcome in the same record shape, with status as the decision", async () => {
    const created = ApprovalRecord.parse((await create()).body.request);

    const response = await call("POST", `/approvals/${created.id}/decision`, {
      body: { decision: "approved", note: "Coverage checks out.", decided_by: RILEY },
    });
    expect(response.status).toBe(200);
    const decided = ApprovalRecord.parse(((await response.json()) as { request: unknown }).request);

    expect(Object.keys(decided).sort()).toEqual(RECORD_FIELDS);
    // No separate `decision` field: once decided, `status` is the decision.
    expect(Object.keys(decided)).not.toContain("decision");
    expect(decided.status).toBe("approved");
    expect(decided.decided_by).toBe(RILEY);
    expect(decided.note).toBe("Coverage checks out.");
    expect(decided.decided_at).toEndWith("Z");
    // Everything the page showed while pending is still there.
    expect(decided.action).toBe("approve_loan");
    expect(decided.amount).toBe(95_000);
  });

  test("a 404 names the id it could not find", async () => {
    const response = await call("POST", "/approvals/apr_nosuchthing/decision", {
      body: { decision: "approved", note: null, decided_by: RILEY },
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("apr_nosuchthing");
  });

  test("a decision is final: a denial cannot be rewritten into an approval", async () => {
    const created = ApprovalRecord.parse((await create()).body.request);
    await call("POST", `/approvals/${created.id}/decision`, {
      body: { decision: "denied", note: "Too thin.", decided_by: RILEY },
    });

    const second = await call("POST", `/approvals/${created.id}/decision`, {
      body: { decision: "approved", note: "Changed my mind.", decided_by: RILEY },
    });
    expect(second.status).toBe(409);

    const read = ApprovalRecord.parse(
      ((await (await call("GET", `/approvals/${created.id}`)).json()) as { request: unknown })
        .request,
    );
    expect(read.status).toBe("denied");
    expect(read.note).toBe("Too thin.");
  });
});

describe("/health", () => {
  test("counts the approvals table so an empty store is visible rather than assumed", async () => {
    await create();
    const body = (await (await fetch(`${base}/health`)).json()) as {
      counts: Record<string, number>;
      pending_approvals: number;
    };
    expect(body.counts.approval_requests).toBe(1);
    expect(body.pending_approvals).toBe(1);
  });
});

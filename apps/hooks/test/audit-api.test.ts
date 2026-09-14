/**
 * `GET /audit`, over HTTP, against a real server on a real socket (#62).
 *
 * Nothing here calls the handler directly. The two things most likely to be
 * wrong about a read endpoint — who may call it, and whether a filter narrows
 * what it says it narrows — are invisible to a test that skips the query
 * string, and a filter that silently matches everything is the failure this
 * project keeps meeting in other clothes.
 *
 * At least one row under test is written by a real `/pre` call rather than by
 * this file, so the endpoint is shown reading what the hooks actually wrote.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { GovernanceEvent } from "@cg/policy-schema";

import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from "../src/audit-api.ts";
import {
  AUDIT_RETENTION_ROWS,
  newEventId,
  record,
  retentionWarning,
} from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const SECRET = "test-secret";
const STORE_TOKEN = "test-store-token";
const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  approvalsStoreToken: STORE_TOKEN,
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: 250,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
};

let db: Database;
let cache: PolicyCache;
let server: ReturnType<typeof createServer>;
let base: string;

beforeEach(() => {
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { pollMs: 60_000 });
  cache.start();
  server = createServer({ config, db, cache, log: () => {} });
  base = `http://localhost:${server.port}`;
});

afterEach(() => {
  cache.stop();
  server.stop(true);
  db.close();
});

interface AuditBody {
  rows: GovernanceEvent[];
  count: number;
  total: number;
  limit: number;
  order: string;
  filters: Record<string, string>;
}

/** `GET /audit`, with the hook bearer unless told otherwise. */
const audit = (query = "", token: string | null = SECRET) =>
  fetch(`${base}/audit${query}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

/** The body, with every row parsed back through the strict schema. */
async function body(response: Response): Promise<AuditBody> {
  const parsed = (await response.json()) as AuditBody;
  return { ...parsed, rows: parsed.rows.map((row) => GovernanceEvent.parse(row)) };
}

interface SeedFields {
  readonly hook?: "access" | "pre" | "post";
  readonly user_id?: string;
  readonly tool?: string;
  readonly decision?: "allow" | "deny" | "modify";
  readonly ts?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** Rows appended straight to the log, oldest first. Returns their ids. */
function seed(count: number, fields: SeedFields = {}): string[] {
  const ids: string[] = [];
  const events = Array.from({ length: count }, (_, index) => {
    const id = newEventId();
    ids.push(id);
    return GovernanceEvent.parse({
      id,
      ts: fields.ts ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      execution_id: `tc_seed_${index}`,
      hook: fields.hook ?? "access",
      user_id: fields.user_id ?? DANA,
      tool: fields.tool ?? "Loan.GetLoan",
      decision: fields.decision ?? "allow",
      reason: "seeded",
      rule_id: null,
      ...(fields.before !== undefined && { before: fields.before }),
      ...(fields.after !== undefined && { after: fields.after }),
    });
  });
  record(db, events);
  return ids;
}

/** A real `/pre` Dana is refused: one audit row, written by the hook itself. */
const denyDana = (executionId: string) =>
  fetch(`${base}/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      execution_id: executionId,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: "LN-2291", amount: 95_000 },
      context: { authorization: [{}], user_id: DANA },
    }),
  });

describe("who may read the log", () => {
  test("no bearer is a 401, and says nothing about what is in there", async () => {
    seed(3);
    const response = await audit("", null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("a wrong bearer is a 401", async () => {
    expect((await audit("", "wrong")).status).toBe(401);
  });

  test("the approvals store's token is not accepted here", async () => {
    // Two secrets reach this service and neither stands in for the other. The
    // store's bearer is held by the deployed toolkit and the approval page;
    // it must not also open the record of every decision.
    expect((await audit("", STORE_TOKEN)).status).toBe(401);
  });

  test("only GET", async () => {
    const response = await fetch(`${base}/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(405);
  });
});

describe("the rows are the audit rows", () => {
  test("a decision made by a hook comes back through /audit unchanged", async () => {
    await denyDana("tc_audit_read");

    const page = await body(await audit());
    expect(page.count).toBe(1);
    const [row] = page.rows;
    expect(row).toMatchObject({
      hook: "pre",
      execution_id: "tc_audit_read",
      user_id: DANA,
      tool: "Loan.ApproveLoan",
      decision: "deny",
      rule_id: "pre.approve-within-clearance",
    });
    // Byte-for-byte what the table holds, not a summary of it.
    const stored = db
      .query<{ reason: string }, { $id: string }>("SELECT reason FROM audit_log WHERE id = $id")
      .get({ $id: row!.id });
    expect(row!.reason).toBe(stored!.reason);
  });

  test("newest first, and the order is stated on the response", async () => {
    const ids = seed(5);
    const page = await body(await audit());
    expect(page.order).toBe("newest_first");
    expect(page.rows.map((row) => row.id)).toEqual([...ids].reverse());
  });

  test("a modify row keeps its before and after", async () => {
    seed(1, { hook: "post", decision: "modify", before: { acct: "123" }, after: { acct: "***" } });
    const [row] = (await body(await audit())).rows;
    expect(row!.before).toEqual({ acct: "123" });
    expect(row!.after).toEqual({ acct: "***" });
  });
});

describe("the filters", () => {
  beforeEach(() => {
    seed(2, { user_id: DANA, hook: "pre", decision: "deny", tool: "Loan.ApproveLoan" });
    seed(3, { user_id: SAM, hook: "access", decision: "deny", tool: "Loan.ApproveLoan" });
    seed(4, { user_id: DANA, hook: "access", decision: "allow", tool: "Loan.GetLoan" });
  });

  test("user_id narrows to one persona", async () => {
    const page = await body(await audit(`?user_id=${encodeURIComponent(SAM)}`));
    expect(page.total).toBe(3);
    expect(page.rows.every((row) => row.user_id === SAM)).toBe(true);
    expect(page.filters.user_id).toBe(SAM);
  });

  test("user_id is case-insensitive, because nothing normalises what Arcade sends", async () => {
    const page = await body(await audit(`?user_id=${encodeURIComponent(SAM.toUpperCase())}`));
    expect(page.total).toBe(3);
  });

  test("tool is the stored Toolkit.Tool", async () => {
    const page = await body(await audit("?tool=Loan.ApproveLoan"));
    expect(page.total).toBe(5);
    expect(page.rows.every((row) => row.tool === "Loan.ApproveLoan")).toBe(true);
  });

  test("a tool nobody called returns nothing, and says nothing matched", async () => {
    // The PascalCase trap: `approve_loan` is not a tool this control plane
    // ever decided about, and the answer has to be zero rather than everything.
    const page = await body(await audit("?tool=Loan.approve_loan"));
    expect(page.total).toBe(0);
    expect(page.rows).toEqual([]);
  });

  test("hook narrows to one hook point", async () => {
    const page = await body(await audit("?hook=pre"));
    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.hook === "pre")).toBe(true);
  });

  test("decision narrows to one effect", async () => {
    const page = await body(await audit("?decision=deny"));
    expect(page.total).toBe(5);
    expect(page.rows.every((row) => row.decision === "deny")).toBe(true);
  });

  test("since takes rows at or after an instant", async () => {
    seed(2, { ts: "2026-06-01T12:00:00.000Z" });
    const page = await body(await audit("?since=2026-06-01T00:00:00.000Z"));
    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.ts === "2026-06-01T12:00:00.000Z")).toBe(true);
    // A bare date is a usable instant, normalised to the form the column holds.
    const byDate = await body(await audit("?since=2026-06-01"));
    expect(byDate.total).toBe(2);
    expect(byDate.filters.since).toBe("2026-06-01T00:00:00.000Z");
  });

  test("filters combine, and the response says which applied", async () => {
    const page = await body(
      await audit(`?user_id=${encodeURIComponent(DANA)}&hook=access&decision=allow`),
    );
    expect(page.total).toBe(4);
    expect(page.filters).toEqual({ user_id: DANA, hook: "access", decision: "allow" });
  });

  test("no filters is the whole log", async () => {
    const page = await body(await audit());
    expect(page.total).toBe(9);
    expect(page.filters).toEqual({});
  });
});

describe("the limit is a bound, not a suggestion", () => {
  test("the default is AUDIT_DEFAULT_LIMIT and total says what was left behind", async () => {
    // The question #62 exists to answer: was that burst 8,259 denials, or a
    // runaway loop? A page with no count beside it cannot tell you.
    seed(250, { hook: "access", decision: "deny", user_id: SAM });

    const page = await body(await audit());
    expect(page.limit).toBe(AUDIT_DEFAULT_LIMIT);
    expect(page.count).toBe(AUDIT_DEFAULT_LIMIT);
    expect(page.total).toBe(250);

    const narrowed = await body(await audit("?limit=10"));
    expect(narrowed.count).toBe(10);
    expect(narrowed.total).toBe(250);
  });

  test("the ceiling is accepted and anything above it is refused, not clamped", async () => {
    seed(5);
    expect((await body(await audit(`?limit=${AUDIT_MAX_LIMIT}`))).limit).toBe(AUDIT_MAX_LIMIT);

    const over = await audit(`?limit=${AUDIT_MAX_LIMIT + 1}`);
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain(String(AUDIT_MAX_LIMIT));
  });

  test.each(["0", "-1", "abc", "1e3", "10.5"])("limit=%s is a 400", async (value) => {
    expect((await audit(`?limit=${encodeURIComponent(value)}`)).status).toBe(400);
  });
});

describe("a filter that cannot mean anything is refused, never ignored", () => {
  test("an unknown query parameter is a 400 naming the ones that exist", async () => {
    seed(3);
    const response = await audit("?toolname=Loan.GetLoan");
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("toolname");
    expect(error).toContain("user_id, tool, hook, decision, since, limit");
  });

  test("an unknown hook is a 400, not an empty page", async () => {
    seed(3);
    // An empty page would read as "no decisions at that hook", which is the
    // shape of every mistake this project is built to make visible.
    const response = await audit("?hook=preflight");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("access, pre, post");
  });

  test("an unknown decision is a 400", async () => {
    const response = await audit("?decision=denied");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("allow, deny, modify");
  });

  test("a since that is not a date is a 400", async () => {
    expect((await audit("?since=yesterday")).status).toBe(400);
  });
});

describe("the stated retention bound", () => {
  // `audit_log` is append-only and nothing prunes it, so the bound is the
  // disk. What this has to be is *said* — a log that fills a volume silently
  // is a control plane that stops recording without anyone deciding that.
  test("says nothing while the log is comfortably inside the bound", () => {
    expect(retentionWarning(0)).toBeNull();
    expect(retentionWarning(8_259)).toBeNull();
    expect(retentionWarning(AUDIT_RETENTION_ROWS * 0.79)).toBeNull();
  });

  test("warns from 80% of the bound, naming the count, the bound and the reset", () => {
    const warning = retentionWarning(AUDIT_RETENTION_ROWS * 0.8);
    expect(warning).not.toBeNull();
    expect(warning).toInclude("1,600,000 rows");
    expect(warning).toInclude("80%");
    expect(warning).toInclude("2,000,000-row bound");
    expect(warning).toInclude("scripts/reset");
  });

  test("the bound is the measured one: 487 bytes a row against a 1 GB disk", () => {
    // `bun run --cwd apps/hooks bench` measures 487 bytes/row on disk, so the
    // 1 GB Render volume holds ~2.2M rows. The bound is that, rounded down.
    const rowsInAGigabyte = 1024 ** 3 / 487;
    expect(AUDIT_RETENTION_ROWS).toBeLessThan(rowsInAGigabyte);
    expect(AUDIT_RETENTION_ROWS).toBeGreaterThan(rowsInAGigabyte * 0.8);
  });
});

describe("reading the log is not on the hook path", () => {
  /** A Database whose every query entry point is counted. */
  function counting(real: Database): { db: Database; reads: () => number } {
    let n = 0;
    const proxied = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof value === "function" &&
          ["query", "prepare", "run", "exec", "transaction"].includes(String(prop))
        ) {
          return (...args: unknown[]) => {
            n += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    return { db: proxied, reads: () => n };
  }

  test("/audit never touches the policy cache's handle", async () => {
    // The cache serves the hot path from memory (`server.test.ts` counts zero
    // queries across twenty warm hook calls). A reviewer paging the log must
    // not put a query back on that handle.
    const real = openGovernance(":memory:", config);
    const counted = counting(real);
    const isolated = createPolicyCache(counted.db, { pollMs: 60_000 });
    isolated.start();
    const srv = createServer({ config, db: real, cache: isolated, log: () => {} });
    try {
      record(
        real,
        Array.from({ length: 3 }, (_, index) =>
          GovernanceEvent.parse({
            id: newEventId(),
            ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
            execution_id: "tc_isolated",
            hook: "access",
            user_id: DANA,
            tool: "Loan.GetLoan",
            decision: "allow",
            reason: "seeded",
            rule_id: null,
          }),
        ),
      );

      const afterWarm = counted.reads();
      for (let i = 0; i < 20; i++) {
        const response = await fetch(`http://localhost:${srv.port}/audit?limit=5`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as AuditBody).count).toBe(3);
      }
      expect(counted.reads()).toBe(afterWarm);
    } finally {
      isolated.stop();
      srv.stop(true);
      real.close();
    }
  });
});

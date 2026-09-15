/**
 * The HTTP layer, booted on a random port against an in-memory database:
 * auth, the fail-closed net, live policy edits reaching the cache, latency.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { AccessHookResult, PreHookResult } from "@cg/policy-schema";

import { count as auditCount, recent } from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { CORRELATION_TOKEN } from "../src/correlation.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

/** How long a test waits for the background poll to notice an edit. */
const POLL_MS = 10;
const settle = () => Bun.sleep(POLL_MS * 6);

const DANA = "alice@bank.example";
const SAM = "bob@bank.example";
const SECRET = "test-secret";
// A different bearer from the hook secret, as in production: this file's tests
// only exercise the hooks, but `HooksConfig` requires both.
const STORE_TOKEN = "test-store-token";

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
  resetToken: "",
};

let db: Database;
let cache: PolicyCache;
let server: ReturnType<typeof createServer>;
let base: string;
const logs: string[] = [];

beforeAll(() => {
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { log: (line) => logs.push(line), pollMs: POLL_MS });
  cache.start();
  server = createServer({ config, db, cache, log: (line) => logs.push(line) });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  cache.stop();
  server.stop(true);
  db.close();
});

const post = (path: string, body: unknown, token: string | null = SECRET) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const preBody = (user_id: string, name: string, inputs: Record<string, unknown>, execution_id = "tc_1") => ({
  execution_id,
  tool: { name, toolkit: "Loan", version: "1.0.0" },
  inputs,
  context: { authorization: [{}], user_id },
});

describe("bearer auth", () => {
  test.each(["/access", "/pre", "/post"])("%s refuses a missing token", async (path) => {
    const res = await post(path, {}, null);
    expect(res.status).toBe(401);
  });

  test.each(["/access", "/pre", "/post"])("%s refuses a wrong token", async (path) => {
    const res = await post(path, {}, "wrong");
    expect(res.status).toBe(401);
  });

  test("an unauthenticated request is not audited — it never reached a decision", async () => {
    const before = auditCount(db);
    await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }), "wrong");
    expect(auditCount(db)).toBe(before);
  });

  test("/health needs no token: Render and Arcade both probe it bare", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      policy: { status: string; revision: number; loaded_at: string; last_poll_at: string | null; poll_ms: number };
    };
    expect(body.status).toBe("healthy");
    expect(body.policy.status).toBe("ready");
    expect(body.policy.poll_ms).toBe(POLL_MS);
    expect(body.policy.loaded_at).toBeString();
  });
});

describe("routing", () => {
  test("404 elsewhere, 405 on the wrong verb", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/pre`)).status).toBe(405);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
  });
});

describe("the hooks over HTTP", () => {
  test("/access hides ApproveLoan from Bob and audits every governed decision", async () => {
    const before = auditCount(db);
    const res = await post("/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(res.status).toBe(200);
    const body = AccessHookResult.parse(await res.json());
    expect(body).toEqual({ deny: { Loan: { tools: { ApproveLoan: V } } } });
    expect(auditCount(db) - before).toBe(4);
  });

  test("/pre denies Alice's $95K with CHECK_FAILED and the remediation message", async () => {
    const res = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }, "tc_act2"));
    expect(res.status).toBe(200);
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(body.error_message).toContain("Approvals_RequestApproval");
    expect(body.error_message).toMatch(CORRELATION_TOKEN);

    const [row] = recent(db, 1);
    expect(row).toMatchObject({ hook: "pre", execution_id: "tc_act2", decision: "deny", rule_id: "pre.approve-within-clearance" });
    // Both spellings, on the same denial, one hop apart: the audit row names
    // the tool the way every hook payload does, and the sentence handed to the
    // model names it the way MCP advertises it. #89 is the claim that these are
    // two different jobs and neither spelling does the other's.
    expect(row!.tool).toBe("Loan.ApproveLoan");
    expect(body.error_message).toContain("Loan_ApproveLoan");
    expect(body.error_message).toContain(row!.id);
  });

  // #58's mirror on this side of the join. Arcade preserves the
  // capitalisation an account was invited under, so `context.user_id` can
  // arrive as `Alice@…` while the roster and the loan book hold the
  // lowercase form. Denying her as an unregistered subject would be the
  // control plane refusing a real person over capitalisation.
  describe("a capitalised context.user_id resolves the lowercase subject", () => {
    const SHOUTED = "Alice@Bank.Example";

    test("a read she is entitled to is allowed, not denied as an unknown subject", async () => {
      const res = await post("/pre", preBody(SHOUTED, "GetLoan", { loan_id: "LN-2291" }, "tc_case_read"));

      expect(await res.json()).toEqual({ code: "OK" });
      expect(recent(db, 1)[0]).toMatchObject({ execution_id: "tc_case_read", decision: "allow" });
    });

    test("and her $50,000 clearance is the one act 2 measures the $95K against", async () => {
      const res = await post(
        "/pre",
        preBody(SHOUTED, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }, "tc_case_deny"),
      );

      const body = PreHookResult.parse(await res.json());
      expect(body.code).toBe("CHECK_FAILED");
      // Alice's own number, interpolated from the subject the lookup found —
      // an unresolved subject denies with "no registered subject" instead.
      expect(body.error_message).toContain("50000");
      expect(body.error_message).not.toMatch(/no registered subject/);
      expect(recent(db, 1)[0]).toMatchObject({
        execution_id: "tc_case_deny",
        decision: "deny",
        rule_id: "pre.approve-within-clearance",
      });
    });

    test("a stranger is still unknown, whatever case they arrive in", async () => {
      const res = await post("/pre", preBody("Stranger@Bank.Example", "GetLoan", { loan_id: "LN-2291" }, "tc_case_stranger"));

      const body = PreHookResult.parse(await res.json());
      expect(body.code).toBe("CHECK_FAILED");
      expect(body.error_message).toMatch(/no registered subject/);
    });
  });

  test("/post returns OK and records a pass-through", async () => {
    const res = await post("/post", {
      execution_id: "tc_post",
      tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
      success: true,
      output: { x: 1 },
      context: { user_id: DANA },
    });
    expect(await res.json()).toEqual({ code: "OK" });
    expect(recent(db, 1)[0]).toMatchObject({ hook: "post", execution_id: "tc_post", decision: "allow" });
  });
});

describe("fails closed, and the failure is audited", () => {
  test("/pre with an unparseable body → CHECK_FAILED with a token, and a deny row", async () => {
    const before = auditCount(db);
    const res = await post("/pre", "not json");
    expect(res.status).toBe(200);
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(body.error_message).toContain("FAIL-CLOSED");
    expect(body.error_message).toMatch(CORRELATION_TOKEN);
    expect(auditCount(db) - before).toBe(1);
    expect(recent(db, 1)[0]).toMatchObject({ hook: "pre", decision: "deny", rule_id: null });
  });

  test("/pre with a body that parses as JSON but not as a hook payload → denied, audited with what was readable", async () => {
    const res = await post("/pre", { execution_id: "tc_bad", tool: { name: "GetLoan" }, context: { user_id: DANA } });
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(recent(db, 1)[0]).toMatchObject({ hook: "pre", execution_id: "tc_bad", user_id: DANA, tool: "?.GetLoan", decision: "deny" });
  });

  test("/access with a body that parses but is not a hook payload → 5xx, so Arcade's fail_closed denies", async () => {
    const res = await post("/access", { nonsense: true });
    expect(res.status).toBe(500);
    expect(recent(db, 1)[0]).toMatchObject({ hook: "access", decision: "deny", tool: "*" });
  });

  test("/access failing closed on a readable payload denies and audits every governed tool named", async () => {
    // Break the policy so the handler path fails closed, then check the rows.
    db.run("UPDATE policy_rules SET tool = 'approve_loan' WHERE id = 'pre.approve-within-clearance'");
    await settle();
    const before = auditCount(db);
    const res = await post("/access", {
      user_id: DANA,
      toolkits: { Loan: { tools: LOAN_TOOLS }, Github: { tools: { CreateIssue: V, ListRepos: V } } },
    });
    expect(AccessHookResult.parse(await res.json()).deny).toHaveProperty("Github");
    const rows = recent(db, auditCount(db) - before);
    // One row per governed tool — the policy will not compile, so the governed
    // set is the configured one — and one summary row for Github's two (#107).
    expect(rows.map((r) => r.tool).sort()).toEqual(
      ["*", "Loan.ApproveLoan", "Loan.DenyLoan", "Loan.GetLoan", "Loan.SearchLoans"],
    );
    expect(rows.every((r) => r.decision === "deny" && r.rule_id === null)).toBe(true);
    // **Every** row, summary included. A listing refused because the control
    // plane could not decide has to read that way on every row it wrote, or
    // `hook=access decision=deny` cannot be told from a policy that hid things
    // on purpose — round 1 of the review found the summary missing this.
    expect(rows.every((r) => /FAIL-CLOSED/.test(r.reason))).toBe(true);
    const summary = rows.find((r) => r.tool === "*")!;
    expect(summary.reason).toContain("could not load its policy");
    expect(summary.reason).toContain("2 tools in 1 toolkit outside the catalogue are hidden");
    expect(summary.reason).toContain("2 tools in 1 toolkit");
    db.run("UPDATE policy_rules SET tool = 'ApproveLoan' WHERE id = 'pre.approve-within-clearance'");
    await settle();
  });

  // /health answers 200 here, and that is #112 rather than a weakened
  // assertion: Render health-checks this path, and the 503 this test used to
  // require is what turned a control plane correctly failing closed into a 502
  // page nobody could read the reason off. The refusal moved into the body and
  // stayed on the three hooks, which the rest of this test still holds.
  test("a policy edit that no longer compiles fails every hook closed until fixed, and /health says so at 200", async () => {
    db.run("UPDATE policy_rules SET tool = 'approve_loan' WHERE id = 'pre.approve-within-clearance'");
    await settle();

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as {
      status: string;
      warnings: string[];
      policy: { status: string; error: string };
    };
    expect(healthBody.status).toBe("degraded");
    expect(healthBody.policy.status).toBe("failed");
    expect(healthBody.policy.error).toMatch(/approve_loan/);
    // The compile error is in the body, in words, not only as a status code.
    expect(healthBody.warnings.join(" ")).toMatch(/approve_loan/);

    const read = await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }));
    expect(PreHookResult.parse(await read.json()).code).toBe("CHECK_FAILED");

    const access = await post("/access", { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(AccessHookResult.parse(await access.json())).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });

    const out = await post("/post", {
      execution_id: "tc_failed_post",
      tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
      success: true,
      output: { x: 1 },
      context: { user_id: DANA },
    });
    expect(PreHookResult.parse(await out.json()).code).toBe("CHECK_FAILED");
    expect(recent(db, 1)[0]).toMatchObject({ hook: "post", execution_id: "tc_failed_post", decision: "deny" });

    db.run("UPDATE policy_rules SET tool = 'ApproveLoan' WHERE id = 'pre.approve-within-clearance'");
    await settle();
    const healed = await fetch(`${base}/health`);
    expect(healed.status).toBe(200);
    expect(((await healed.json()) as { policy: { status: string } }).policy.status).toBe("ready");
    const again = await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }));
    expect(await again.json()).toEqual({ code: "OK" });
  });
});

describe("live policy edits", () => {
  test("a clearance raised in the database is honoured within one poll interval, and the reload is observable", async () => {
    const denied = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }));
    expect(PreHookResult.parse(await denied.json()).code).toBe("CHECK_FAILED");

    const before = ((await (await fetch(`${base}/health`)).json()) as { policy: { revision: number } }).policy.revision;
    const reloads = logs.filter((l) => l.startsWith("policy loaded")).length;

    db.run(`UPDATE subjects SET clearance = 100000 WHERE user_id = '${DANA}'`);
    await settle();

    const allowed = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }));
    expect(await allowed.json()).toEqual({ code: "OK" });

    const after = ((await (await fetch(`${base}/health`)).json()) as { policy: { revision: number } }).policy.revision;
    expect(after).toBeGreaterThan(before);
    expect(logs.filter((l) => l.startsWith("policy loaded")).length).toBe(reloads + 1);

    db.run(`UPDATE subjects SET clearance = 50000 WHERE user_id = '${DANA}'`);
    await settle();
  });

  test("disabling a rule takes effect within one poll interval", async () => {
    db.run("UPDATE policy_rules SET enabled = 0 WHERE id = 'access.analysts-cannot-see-approve'");
    await settle();
    const res = await post("/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(await res.json()).toEqual({ deny: {} });
    db.run("UPDATE policy_rules SET enabled = 1 WHERE id = 'access.analysts-cannot-see-approve'");
    await settle();
  });
});

describe("the hot path never reads policy from the database", () => {
  /** A Database whose every query entry point is counted. */
  function counting(real: Database): { db: Database; reads: () => number } {
    let n = 0;
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function" && ["query", "prepare", "run", "exec", "transaction"].includes(String(prop))) {
          return (...args: unknown[]) => {
            n += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    return { db, reads: () => n };
  }

  test("a warm /access and /pre make zero policy queries; only the audit write touches SQLite", async () => {
    const real = openGovernance(":memory:", config);
    const counted = counting(real);
    // The cache gets the counted handle; the server's audit writes go to the real one.
    const isolated = createPolicyCache(counted.db, { pollMs: 60_000 });
    isolated.start();
    const srv = createServer({ config, db: real, cache: isolated, log: () => {} });
    try {
      const afterWarm = counted.reads();
      for (let i = 0; i < 20; i++) {
        const a = await fetch(`http://localhost:${srv.port}/access`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } }),
        });
        expect(a.status).toBe(200);
        const p = await fetch(`http://localhost:${srv.port}/pre`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(preBody(DANA, "GetLoan", { loan_id: "LN-2291" })),
        });
        expect(p.status).toBe(200);
      }
      expect(counted.reads()).toBe(afterWarm);
      // Sanity: the audit rows did land, on the real handle.
      expect(auditCount(real)).toBe(20 * 4 + 20);
    } finally {
      isolated.stop();
      srv.stop(true);
      real.close();
    }
  });

  test("current() is a memory read, even a thousand times", () => {
    const real = openGovernance(":memory:", config);
    const counted = counting(real);
    const isolated = createPolicyCache(counted.db, { pollMs: 60_000 });
    isolated.start();
    const afterWarm = counted.reads();
    for (let i = 0; i < 1000; i++) expect(isolated.current().status).toBe("ready");
    expect(counted.reads()).toBe(afterWarm);
    isolated.stop();
    real.close();
  });

  test("a poll that cannot read the revision keeps serving the cached policy, then fails closed once it is persistent", () => {
    const real = openGovernance(":memory:", config);
    let broken = false;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (broken && prop === "query") return () => { throw new Error("disk went away"); };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const isolated = createPolicyCache(flaky, { pollMs: 60_000, maxPollFailures: 3 });
    isolated.start();
    broken = true;
    expect(isolated.poll().status).toBe("ready");
    expect(isolated.poll().status).toBe("ready");
    expect(isolated.status().consecutive_poll_failures).toBe(2);
    expect(isolated.poll().status).toBe("failed");
    expect(isolated.status().error).toMatch(/unreadable for 3 polls/);
    broken = false;
    expect(isolated.poll().status).toBe("ready");
    isolated.stop();
    real.close();
  });
});

describe("a cold cache fails closed", () => {
  test("a server whose cache was never started denies the first /access and loads nothing", async () => {
    const real = openGovernance(":memory:", config);
    const isolated = createPolicyCache(real, { pollMs: 60_000 });
    const srv = createServer({ config, db: real, cache: isolated, log: () => {} });
    try {
      const res = await fetch(`http://localhost:${srv.port}/access`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ user_id: DANA, toolkits: { Loan: { tools: { GetLoan: V } } } }),
      });
      expect(res.status).toBe(200);
      expect(AccessHookResult.parse(await res.json())).toEqual({ deny: { Loan: { tools: { GetLoan: V } } } });
      expect(isolated.current().status).toBe("cold");
      expect(recent(real, 1)[0]).toMatchObject({ hook: "access", tool: "Loan.GetLoan", decision: "deny", rule_id: null });
      expect(recent(real, 1)[0]?.reason).toMatch(/has not loaded its policy yet/);

      const post = await fetch(`http://localhost:${srv.port}/post`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          execution_id: "tc_cold_post",
          tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
          success: true,
          output: { bank_account_number: "1234" },
          context: { user_id: DANA },
        }),
      });
      expect(post.status).toBe(200);
      expect(PreHookResult.parse(await post.json()).code).toBe("CHECK_FAILED");
      expect(recent(real, 1)[0]).toMatchObject({ hook: "post", execution_id: "tc_cold_post", decision: "deny", rule_id: null });

      // 200 with `degraded`, not 503 (#112): a cold cache is a process that is
      // up and refusing, and Render must be able to read that rather than
      // replace it with its own 502.
      const health = await fetch(`http://localhost:${srv.port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { status: string; policy: { status: string } };
      expect(body.status).toBe("degraded");
      expect(body.policy.status).toBe("cold");
    } finally {
      isolated.stop();
      srv.stop(true);
      real.close();
    }
  });
});

describe("the hook budget covers synchronous work", () => {
  test("an evaluation that runs past HOOK_DEADLINE_MS is denied and audited as a timeout, never returned as OK", async () => {
    const real = openGovernance(":memory:", config);
    const inner = createPolicyCache(real, { pollMs: 60_000 });
    inner.start();
    // A cache whose current() blocks synchronously — the reviewer's scenario.
    const slow: PolicyCache = {
      ...inner,
      current: () => {
        const until = performance.now() + 60;
        while (performance.now() < until) { /* spin */ }
        return inner.current();
      },
    };
    const srv = createServer({ config: { ...config, deadlineMs: 20 }, db: real, cache: slow, log: () => {} });
    try {
      const res = await fetch(`http://localhost:${srv.port}/pre`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(preBody(DANA, "GetLoan", { loan_id: "LN-2291" }, "tc_slow")),
      });
      expect(res.status).toBe(200);
      const body = PreHookResult.parse(await res.json());
      expect(body.code).toBe("CHECK_FAILED");
      expect(body.error_message).toMatch(/Timeout/);
      expect(body.error_message).toMatch(CORRELATION_TOKEN);
      // Exactly one row, the denial — the allow that was computed was discarded.
      const rows = recent(real, 5).filter((r) => r.execution_id === "tc_slow");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decision: "deny", rule_id: null, tool: "Loan.GetLoan" });
      expect(rows[0]?.reason).toMatch(/exceeded the 20ms hook budget/);
    } finally {
      inner.stop();
      srv.stop(true);
      real.close();
    }
  });
});

describe("latency", () => {
  /** A catalogue the size spike #2 measured: ~1.6 MB of toolkits, Loan among them. */
  function bigCatalogue(): { bytes: number; toolkits: Record<string, { tools: Record<string, { version: string }[]> }> } {
    const toolkits: Record<string, { tools: Record<string, { version: string }[]> }> = { Loan: { tools: LOAN_TOOLS } };
    let bytes = 0;
    for (let t = 0; bytes < 1_600_000; t++) {
      const tools: Record<string, { version: string }[]> = {};
      for (let i = 0; i < 40; i++) {
        tools[`Tool${i}WithALongerNameLikeArcadeUses`] = [
          { version: "1.0.0", requirements: { authorization: [{ provider_id: "prov", oauth2: { scopes: ["a", "b"] } }] } } as never,
        ];
      }
      toolkits[`Toolkit${t}`] = { tools };
      bytes = JSON.stringify(toolkits).length;
    }
    return { bytes, toolkits };
  }

  test("/access with the whole project catalogue answers well inside Arcade's 5s", async () => {
    const { bytes, toolkits } = bigCatalogue();
    expect(bytes).toBeGreaterThan(1_500_000);

    const rowsBefore = auditCount(db);
    const started = performance.now();
    const res = await post("/access", { user_id: SAM, toolkits });
    const ms = performance.now() - started;

    expect(res.status).toBe(200);
    const body = AccessHookResult.parse(await res.json());
    expect(body.deny?.Loan?.tools).toEqual({ ApproveLoan: V });
    expect(Object.keys(body.deny ?? {}).length).toBe(Object.keys(toolkits).length);
    // Generous: CI machines are slow. Locally this is tens of milliseconds.
    expect(ms).toBeLessThan(2000);

    // #107, and the number this whole slice exists for. The same call used to
    // append one audit row per catalogue entry — more than ten thousand of
    // them, each one an SSE frame as well — which is how the Render disk got
    // to 413,832 rows with nothing looping. Now it is one row per governed
    // tool plus one summary row for everything else.
    const entries = Object.values(toolkits).reduce((n, t) => n + Object.keys(t.tools).length, 0);
    expect(entries).toBeGreaterThan(10_000);
    const governed = Object.keys(LOAN_TOOLS).length;
    expect(auditCount(db) - rowsBefore).toBe(governed + 1);
  });
});

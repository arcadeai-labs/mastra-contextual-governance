/**
 * #107 — how many audit rows one `/access` call is worth.
 *
 * `/access` is asked about the whole Arcade project catalogue, not about the
 * tools anybody is using. Two measurements: spike #2 saw one `tools/list`
 * produce **four** `/access` calls, one of them enumerating every toolkit in
 * the project (~1.6 MB), and spike #5 counted what that costs on the deployed
 * gateway — **8,278 `/access` frames per `tools/list`**, six `allow` and 8,272
 * `deny` (`docs/spikes/05-custom-verifier.md` §11.3). Appending a row per
 * entry is what put 413,832 rows on the Render disk with nothing looping:
 * `413,832 / 8,278 ≈ 50 listings`.
 *
 * The figures divide **per list** and this module works **per call**: a summary
 * row is written once per `/access` call, so one listing is at most four.
 *
 * **This file is where the answer to "one row per tool or one per list" is
 * pinned, and it is deliberately the only place.** Three answers were on the
 * table (`src/access-audit.ts` has the argument):
 *
 *   A  one row per tool — what was here, ~8,278 rows per listing
 *   B  one row per `/access` call — four a listing, and act 1 stops being
 *      evidence
 *   C  one row per tool in a governed toolkit, plus one summary row per call
 *      for the rest — what landed, and what the human chose on #107
 *
 * Every assertion below that would change under A or B is in this file. The
 * rest of the suite asserts things all three share: what Arcade is told, which
 * tools are hidden, which rule hid them.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createApprovalControl } from "../src/approval-governance.ts";
import { handleAccess, type HandlerContext } from "../src/handlers.ts";
import { createPolicyCache, type CacheState } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";

const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";

const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const governance = (): Database =>
  openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} });

let n = 0;
const contextFor = (db: Database): HandlerContext => ({
  now: () => "2026-01-01T00:00:00.000Z",
  newId: () => `evt_${String(++n).padStart(10, "0")}`,
  approvals: createApprovalControl(db, { toolkit: "Approvals", grantTtlSeconds: 900 }),
  configuredToolkits: new Set(["Loan", "Approvals"]),
});

const ctx = contextFor(governance());
const ready = (db: Database = governance()): CacheState => createPolicyCache(db).reload();

/**
 * A catalogue the size Arcade actually sends, with our own toolkit inside it.
 *
 * Built rather than fixtured, because the number that matters is how the row
 * count behaves as this grows: the whole point of C is that it does not.
 */
function projectCatalogue(toolkits: number, toolsEach: number): Record<string, { tools: Record<string, typeof V> }> {
  const catalogue: Record<string, { tools: Record<string, typeof V> }> = {
    Loan: { tools: LOAN_TOOLS },
  };
  for (let t = 0; t < toolkits; t += 1) {
    const tools: Record<string, typeof V> = {};
    for (let i = 0; i < toolsEach; i += 1) tools[`Tool${i}`] = V;
    catalogue[`Stock${t}`] = { tools };
  }
  return catalogue;
}

describe("one /access call, one row per governed tool plus one summary", () => {
  test("the rows do not grow with the catalogue: 30 toolkits or 300, the same count", () => {
    const small = handleAccess({ user_id: DANA, toolkits: projectCatalogue(30, 40) }, ready(), ctx);
    const large = handleAccess({ user_id: DANA, toolkits: projectCatalogue(300, 40) }, ready(), ctx);

    // 1,204 tools decided, then 12,004. Under A these would be 1,204 and
    // 12,004 rows; under B, one and one.
    expect(small.events).toHaveLength(Object.keys(LOAN_TOOLS).length + 1);
    expect(large.events).toHaveLength(Object.keys(LOAN_TOOLS).length + 1);
  });

  test("what Arcade is told is unchanged — every ungoverned tool is still hidden", () => {
    const toolkits = projectCatalogue(3, 5);
    const { response } = handleAccess({ user_id: DANA, toolkits }, ready(), ctx);

    for (const name of Object.keys(toolkits)) {
      if (name === "Loan") continue;
      expect(Object.keys(response.deny?.[name]?.tools ?? {}).sort()).toEqual(
        Object.keys(toolkits[name]!.tools).sort(),
      );
    }
    // The rows collapsed; the answer did not.
    expect(Object.keys(response.deny ?? {})).toHaveLength(3);
  });

  test("act 1 survives: Sam's hidden tool is still a row naming that tool and the rule that hid it", () => {
    const { events } = handleAccess(
      { user_id: SAM, toolkits: projectCatalogue(50, 40) },
      ready(),
      ctx,
    );
    const approve = events.find((e) => e.tool === "Loan.ApproveLoan");
    expect(approve).toMatchObject({
      decision: "deny",
      rule_id: "access.analysts-cannot-see-approve",
      user_id: SAM,
    });
    // And the allows are there too: a rule that matches nothing has to look
    // different from a rule that permits, which is the whole reason B was not
    // taken.
    expect(events.filter((e) => e.tool.startsWith("Loan.") && e.decision === "allow")).toHaveLength(3);
  });

  test("the summary row says how many it stands for, and what happened to them", () => {
    const { events } = handleAccess({ user_id: DANA, toolkits: projectCatalogue(4, 10) }, ready(), ctx);

    const summary = events.at(-1)!;
    expect(summary.tool).toBe("*");
    expect(summary.decision).toBe("deny");
    expect(summary.rule_id).toBeNull();
    expect(summary.hook).toBe("access");
    expect(summary.user_id).toBe(DANA);
    expect(summary.reason).toContain("40 tools in 4 toolkits");
    expect(summary.reason).toContain("40 hidden, 0 allowed");
    // Named, but bounded: a hundred toolkit names is not a sentence anybody reads.
    expect(summary.reason).toContain("Stock0, Stock1, Stock2, Stock3");
    expect(summary.reason).toContain("Loan");
  });

  test("a call about nothing but governed tools writes no summary row at all", () => {
    const { events } = handleAccess({ user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } }, ready(), ctx);
    expect(events.map((e) => e.tool)).not.toContain("*");
    expect(events).toHaveLength(4);
  });

  test("a call about nothing but ungoverned tools is still on the record — one row, not none", () => {
    const { events } = handleAccess(
      { user_id: DANA, toolkits: { Stock0: { tools: { A: V, B: V } } } },
      ready(),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "*", decision: "deny" });
  });

  test("governed is the catalogue, not a name written down: a toolkit added on stage is recorded per tool", () => {
    const db = governance();
    // The mechanism DESIGN.md calls "editable live on stage": the catalogue is
    // a table, and the cache picks the edit up on its next read.
    db.run("INSERT INTO catalogue (toolkit, tool, arguments) VALUES ('Ledger', 'GetEntry', '[]')");
    db.run("INSERT INTO catalogue (toolkit, tool, arguments) VALUES ('Ledger', 'PostEntry', '[]')");

    const before = handleAccess(
      { user_id: DANA, toolkits: { Ledger: { tools: { GetEntry: V, PostEntry: V } } } },
      ready(),
      ctx,
    );
    expect(before.events.map((e) => e.tool)).toEqual(["*"]);

    const after = handleAccess(
      { user_id: DANA, toolkits: { Ledger: { tools: { GetEntry: V, PostEntry: V } } } },
      ready(db),
      ctx,
    );
    expect(after.events.map((e) => e.tool).sort()).toEqual(["Ledger.GetEntry", "Ledger.PostEntry"]);
  });

  test("with no policy loaded the fallback is the configured toolkits, so our own refusals stay per tool", () => {
    const cold: CacheState = { status: "cold" };
    const { events } = handleAccess({ user_id: DANA, toolkits: projectCatalogue(20, 40) }, cold, ctx);

    // Four FAIL-CLOSED rows for Loan, one summary for the other 800 tools.
    expect(events).toHaveLength(5);
    for (const event of events.slice(0, 4)) {
      expect(event.tool.startsWith("Loan.")).toBe(true);
      expect(event.reason).toContain("FAIL-CLOSED");
    }
    expect(events.at(-1)!.tool).toBe("*");
    expect(events.at(-1)!.reason).toContain("800 tools in 20 toolkits");
  });

  /**
   * Round 1 of the review, finding 1.
   *
   * The summary used to say only where the line between governed and catalogue
   * was drawn. On a fail-closed path that made a control plane which could not
   * load its policy indistinguishable, in the log, from one that was working:
   * every per-tool row said `FAIL-CLOSED` and the row standing for the other
   * eight thousand did not.
   */
  describe("a fail-closed listing reads as fail-closed on every row it wrote", () => {
    const failed: CacheState = {
      status: "failed",
      revision: 7,
      failed_at: "2026-01-01T00:00:00.000Z",
      error: "Policy failed to compile: rule x",
    };

    test.each([
      ["cold", { status: "cold" } as CacheState, "has not loaded its policy yet"],
      ["failed", failed, "could not load its policy (Policy failed to compile: rule x)"],
    ])("%s: the summary carries the same reason the per-tool rows carry", (_label, state, cause) => {
      const { events } = handleAccess({ user_id: DANA, toolkits: projectCatalogue(3, 100) }, state, ctx);

      // Not "every row except the one standing for three hundred decisions".
      expect(events.every((event) => event.reason.startsWith("FAIL-CLOSED:"))).toBe(true);
      expect(events.every((event) => event.decision === "deny")).toBe(true);
      expect(events.every((event) => event.reason.includes(cause))).toBe(true);

      const summary = events.at(-1)!;
      expect(summary.tool).toBe("*");
      // The group sits in the slot a tool name sits in on the rows above, so
      // the two sentences are the same sentence.
      expect(summary.reason).toContain("300 tools in 3 toolkits outside the catalogue are hidden");
      // And the accounting is still there, after the cause rather than instead of it.
      expect(summary.reason).toContain("SUMMARY: 300 tools in 3 toolkits");
      expect(summary.reason).toContain("300 hidden, 0 allowed");
    });

    test("a call with nothing governed in it still says why, with no per-tool row to lean on", () => {
      const { events } = handleAccess(
        { user_id: DANA, toolkits: { Stock0: { tools: { A: V, B: V } } } },
        { status: "cold" },
        ctx,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.tool).toBe("*");
      expect(events[0]!.reason).toStartWith("FAIL-CLOSED: the control plane has not loaded its policy yet,");
    });

    test("the ordinary path does not borrow the marker — a policy that hid things says so", () => {
      const { events } = handleAccess({ user_id: SAM, toolkits: projectCatalogue(3, 100) }, ready(), ctx);
      const summary = events.at(-1)!;
      expect(summary.tool).toBe("*");
      expect(summary.reason).not.toContain("FAIL-CLOSED");
      expect(summary.reason).toStartWith("SUMMARY: 300 tools in 3 toolkits outside this control plane's catalogue");
    });
  });
});

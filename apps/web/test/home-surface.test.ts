/**
 * What one load of `/` asks the gateway for, and what comes back.
 *
 * Two claims, and the file is organised around both:
 *
 * 1. **The enterprise half of the split screen is a client of the control plane
 *    like everything else.** It is easy to build a demo where the pretty panel
 *    on the right watches governed calls while the business app on the left
 *    quietly reads the database, and impossible to tell from a screenshot. So
 *    these tests assert the path, not just the pixels: every loan file on
 *    screen came out of a real `tools/call` made as the signed-in person,
 *    through the real `/pre`, and is in the audit log.
 * 2. **It costs exactly one `tools/list` (#109).** The tool list and the loan
 *    files are two questions for one gateway session, and the gateway stand-in
 *    records every listing it answers, so that is a number this file reads back
 *    rather than a claim a comment makes.
 *
 * Real here: `apps/hooks` with its real policy, `apps/loan-app` with a real
 * `loans.db`, the real MCP transport, the real server-side page surface. The
 * Arcade gateway is the stand-in (`scripts/gateway-stand-in.ts`) and is the
 * only fiction — the same line #14 draws, in the same place.
 *
 * No model runs in this file. Reading a loan file is not a turn of the agent,
 * and a cg-web with no `ANTHROPIC_API_KEY` must still show the loan the
 * audience is being asked to think about.
 *
 * This suite was `test/loan-context.test.ts` until #109, when the browser
 * request it drove was deleted and its work moved into
 * `app/page.tsx`'s server component. The assertions are the same ones; what
 * changed is that they are made against `homeSurface`, which is the function
 * the page calls.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DANA, SAM, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { homeSurface, type HomeSurface } from "../lib/home/surface.ts";
import { DEMO_LOAN_IDS, type LoanContextBody, type LoanContextRefusal } from "../lib/loan-context/loans.ts";
import type { Session } from "../lib/identity/session.ts";

let harness: AgentHarness;

beforeAll(async () => {
  harness = await startAgentHarness();
}, 60_000);

afterAll(async () => {
  await harness?.stop();
});

/** The sentence the test's own rule writes. Distinctive, so nothing else can produce it. */
const RULE_REASON = "credit analysts do not read complete loan files";

/**
 * The sealed session a browser signed in as `email` would carry.
 *
 * The page unseals the cookie itself and hands the `Session` down, so this is
 * where the suite joins the real code: one object, exactly the one
 * `readSessionFromCookies` produces.
 */
function sessionFor(email: string, options: { gateway?: boolean } = {}): Session {
  return {
    email,
    signed_in_at: Date.now(),
    ...(options.gateway === false
      ? {}
      : {
          gateway: {
            access_token: harness.tokenFor(email),
            expires_at: Date.now() + 3_600_000,
            client_id: "mcp-client-for-home-surface-tests",
          },
        }),
  };
}

/** One load of `/`, as far as the gateway is concerned. */
function load(session: Session | null): Promise<HomeSurface> {
  return homeSurface(session, { config: harness.config });
}

/** The loaded body, or a loud failure naming the refusal instead. */
function loaded(surface: HomeSurface): LoanContextBody {
  if (surface.files.status !== "loaded") {
    throw new Error(`expected loan files, got a refusal: ${surface.files.refusal.error}`);
  }
  return surface.files.body;
}

/** The refusal, or a loud failure. */
function refused(surface: HomeSurface): LoanContextRefusal {
  if (surface.files.status !== "refused") throw new Error("expected a refusal, got loan files");
  return surface.files.refusal;
}

/** Everything that crossed to the browser. A value in the props is a value in the page source. */
const crossed = (surface: HomeSurface) => JSON.stringify(surface.files);

describe("the files on the left half", () => {
  test("both applications come back, read as the person signed in on this browser", async () => {
    const body = loaded(await load(sessionFor(DANA)));

    expect(body.reads.map((entry) => entry.loan_id)).toEqual([...DEMO_LOAN_IDS]);
    expect(body.reads.map((entry) => entry.outcome)).toEqual(["read", "read"]);
    expect(body.actor).toBe(DANA);
  });

  test("what is on screen is what the loan book holds, not a fixture beside it", async () => {
    const body = loaded(await load(sessionFor(DANA)));
    const shown = body.reads[0];
    const held = await harness.loan(DEMO_LOAN_IDS[0], DANA);

    expect(shown?.outcome).toBe("read");
    if (shown?.outcome !== "read") throw new Error("unreachable");
    expect(shown.loan.borrower_name).toBe(held.borrower_name as string);
    expect(shown.loan.amount).toBe(held.amount as number);
    expect(shown.loan.status).toBe(held.status as string);
  });

  /**
   * The whole reason these reads exist rather than a database read.
   *
   * `harness.calls` is what the gateway saw. Two `tools/call`s, both
   * `Loan_GetLoan`, both as Alice, both of which ran only because the real `/pre`
   * said `OK` — that is the claim the left half is making by putting a loan
   * file on screen at all.
   */
  test("every file went through the gateway as that person, not round it", async () => {
    const before = harness.calls.length;
    await load(sessionFor(DANA));

    const calls = harness.calls.slice(before);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.tool).toBe("Loan_GetLoan");
      expect(call.user_id).toBe(DANA);
      expect(call.outcome).toBe("ran");
    }
    expect(calls.map((call) => call.inputs.loan_id)).toEqual([...DEMO_LOAN_IDS]);
  });

  /**
   * Both layers, named separately.
   *
   * Since #15 the gateway stand-in asks `/access` before it answers
   * `tools/list`, so a page load leaves `access` rows for `Loan.GetLoan`
   * as well as the `pre` rows the calls themselves produce. That is the left
   * half's read passing layer 1 and layer 3, and the two are counted apart
   * rather than together: a filter that accepted either would keep passing if
   * the `/pre` rows stopped being written, which is the row that says the call
   * was allowed to happen at all.
   */
  test("the control plane recorded both reads, at both layers", async () => {
    await load(sessionFor(DANA));
    const rows = await harness.audit();
    const forThisTool = rows.filter((row) => row.tool === "Loan.GetLoan" && row.user_id === DANA);

    expect(forThisTool.filter((row) => row.hook === "pre").length).toBeGreaterThanOrEqual(2);
    expect(forThisTool.filter((row) => row.hook === "access").length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Act 3's subject, kept off the projector.
   *
   * `Loan_GetLoan` returns `bank_account_number` and `tax_id`; this screen does
   * not render them, and the props the server component hands the browser do
   * not carry them either. Asserted on what crosses the boundary rather than on
   * the markup, because a value that reaches the client is a value in the page
   * source whatever the component draws.
   */
  test("the borrower's account number and tax id never leave the server", async () => {
    const held = await harness.loan(DEMO_LOAN_IDS[0], DANA);
    const props = crossed(await load(sessionFor(DANA)));

    expect(props).not.toContain("bank_account_number");
    expect(props).not.toContain(held.bank_account_number as string);
    expect(props).not.toContain(held.tax_id as string);
  });
});

/**
 * #109, as a number.
 *
 * The issue's measurement: a page load uses one gateway session for both the
 * tool list and loan reads. A Continue action is a new page attempt, so it gets
 * one new listing and the same governed read path; the only way to say that is
 * to count.
 *
 * `harness.lists` is the gateway stand-in's own record, one entry per
 * `tools/list` JSON-RPC message it answered. Nothing in the assertion is
 * derived from the code under test.
 */
describe("what one page load costs", () => {
  test("one load of / makes exactly one tools/list", async () => {
    const before = harness.lists.length;
    const surface = await load(sessionFor(DANA));

    // Both halves of the screen were answered…
    expect(surface.tools.ok).toBe(true);
    expect(surface.files.status).toBe("loaded");
    // …off one listing.
    expect(harness.lists.length - before).toBe(1);
  });

  test("the one listing is the one the tool list is rendered from, for this persona", async () => {
    const before = harness.lists.length;
    const surface = await load(sessionFor(SAM));

    const listings = harness.lists.slice(before);
    expect(listings).toHaveLength(1);
    const listing = listings[0];
    expect(listing?.user_id).toBe(SAM);
    // The widget's names are that listing's names, minus the built-ins it says
    // it filtered. Not a second source, and not a client-side filter.
    if (!surface.tools.ok) throw new Error(surface.tools.reason);
    expect([...surface.tools.tools.map((tool) => tool.name), ...surface.tools.filtered].sort()).toEqual(
      [...(listing?.advertised ?? [])].sort(),
    );
    // Act 1 survives the fold: as Bob, the approval tool is absent from the
    // listing itself, so it is absent from the widget without anything here
    // hiding it.
    expect(listing?.hidden).toContain("Loan_ApproveLoan");
    expect(surface.tools.tools.map((tool) => tool.name)).not.toContain("Loan_ApproveLoan");
  });

  test("and it still costs exactly two governed calls, no more", async () => {
    const before = harness.calls.length;
    await load(sessionFor(DANA));

    expect(harness.calls.length - before).toBe(2);
  });
});

describe("when there is nobody to read as", () => {
  test("no session asks the gateway nothing at all", async () => {
    const before = harness.lists.length;
    const surface = await load(null);

    expect(harness.lists.length - before).toBe(0);
    expect(surface.tools.ok).toBe(false);
  });

  test("no session is a refusal that points at signing in, not an empty screen", async () => {
    const refusal = refused(await load(null));

    expect(refusal.action).toBe("signin");
    expect(refusal.error).toContain("signed in");
  });

  test("a session with no gateway token points at the gateway hop", async () => {
    const refusal = refused(await load(sessionFor(DANA, { gateway: false })));

    expect(refusal.action).toBe("gateway");
  });

  /**
   * The same failure, said twice, on both halves of the screen.
   *
   * The tool list and the loan files come out of one session now, so a session
   * that never opened has to leave both columns saying something. A page that
   * named the problem under "User access" and drew an empty column under
   * "Applications under review" would be the left half looking like a control
   * plane that refused everything.
   */
  test("a missing gateway token is named on both halves, not just the tool list", async () => {
    const surface = await load(sessionFor(DANA, { gateway: false }));

    expect(surface.tools.ok).toBe(false);
    if (surface.tools.ok) throw new Error("unreachable");
    expect(surface.tools.reason).not.toBe("");
    expect(refused(surface).error).toBe(surface.tools.reason);
  });
});

describe("when the read does not produce a file", () => {
  /**
   * Layer 2, which is not a refusal.
   *
   * `requireAuthorizationFor` is one-shot, exactly as the real gateway is, but
   * a page attempt must stop at its first challenge. The explicit browser
   * Continue action starts the next attempt after the person authorizes; it is
   * not allowed to read the sibling file in the background.
   */
  test("a missing credential is one actionable link, and stops before the second read", async () => {
    const callsBefore = harness.calls.length;
    const listsBefore = harness.lists.length;
    harness.gateway.requireAuthorizationFor(
      "Loan_GetLoan",
      "https://cloud.arcade.dev/api/v1/oauth/flow/for-loan-context",
    );
    const body = loaded(await load(sessionFor(DANA)));

    const [first, second] = body.reads;
    expect(first?.outcome).toBe("authorization");
    if (first?.outcome !== "authorization") throw new Error("unreachable");
    expect(first.url).toBe("https://cloud.arcade.dev/api/v1/oauth/flow/for-loan-context");
    expect(first.instructions).toContain("try again once they confirm");
    expect(second).toBeUndefined();
    expect(harness.lists.length - listsBefore).toBe(1);
    expect(harness.calls.slice(callsBefore).map((call) => call.outcome)).toEqual(["authorization_required"]);
  });

  test("a native URL elicitation is captured through the actual MCP callback and stops the page attempt", async () => {
    const callsBefore = harness.calls.length;
    const listsBefore = harness.lists.length;
    harness.gateway.requireNativeElicitationFor("Loan_GetLoan", "https://provider.example/native-loan-auth");

    const body = loaded(await load(sessionFor(DANA)));
    const [first, second] = body.reads;
    expect(first?.outcome).toBe("authorization");
    if (first?.outcome !== "authorization") throw new Error("unreachable");
    expect(first.url).toBe("https://provider.example/native-loan-auth");
    expect(first.instructions).toBe("Authorize the provider, then continue.");
    expect(second).toBeUndefined();
    expect(harness.lists.length - listsBefore).toBe(1);
    expect(harness.calls.slice(callsBefore).map((call) => call.outcome)).toEqual(["authorization_required"]);
  });

  test("an unsafe native URL still pauses the first read without rendering the link", async () => {
    const callsBefore = harness.calls.length;
    harness.gateway.requireNativeElicitationFor("Loan_GetLoan", "javascript:alert(1)");

    const body = loaded(await load(sessionFor(DANA)));
    const [first, second] = body.reads;
    expect(first).toEqual({ loan_id: "LN-2291", outcome: "authorization" });
    expect(second).toBeUndefined();
    expect(harness.calls.slice(callsBefore).map((call) => call.outcome)).toEqual(["authorization_required"]);
  });

  test("a structured -32042 result with a URL is an actionable authorization, not a fault", async () => {
    harness.gateway.requireProtocolAuthorizationFor("Loan_GetLoan", "https://provider.example/protocol-loan-auth");

    const body = loaded(await load(sessionFor(DANA)));
    const [first, second] = body.reads;
    expect(first?.outcome).toBe("authorization");
    if (first?.outcome !== "authorization") throw new Error("unreachable");
    expect(first.url).toBe("https://provider.example/protocol-loan-auth");
    expect(first.instructions).toBe("Authorize the provider, then continue.");
    expect(second).toBeUndefined();
  });

  test("a structured -32042 result without a URL still pauses for explicit Continue", async () => {
    harness.gateway.requireProtocolAuthorizationFor("Loan_GetLoan");

    const body = loaded(await load(sessionFor(DANA)));
    const [first, second] = body.reads;
    expect(first).toEqual({ loan_id: "LN-2291", outcome: "authorization", instructions: "URL elicitation required" });
    expect(second).toBeUndefined();
  });

  test("Continue is a fresh home attempt, succeeds once the one-shot challenge is consumed, and preserves one listing per attempt", async () => {
    // Consume a one-shot challenge on the initial page attempt.
    harness.gateway.requireAuthorizationFor("Loan_GetLoan", "https://provider.example/continue-loan-auth");
    const initial = loaded(await load(sessionFor(DANA)));
    expect(initial.reads).toHaveLength(1);
    expect(initial.reads[0]?.outcome).toBe("authorization");

    const callsBefore = harness.calls.length;
    const listsBefore = harness.lists.length;
    const refreshed = loaded(await load(sessionFor(DANA)));
    expect(refreshed.reads.map((read) => read.outcome)).toEqual(["read", "read"]);
    expect(harness.lists.length - listsBefore).toBe(1);
    expect(harness.calls.length - callsBefore).toBe(2);
    expect(harness.calls.slice(callsBefore).every((call) => call.user_id === DANA)).toBe(true);
  });

  /**
   * The toolkit that is not there.
   *
   * The loud sentence #22 wrote and #109 moved: it named `ARCADE_LOAN_TOOLKIT`
   * when it was a route's 502 body and it names it on the page now, because the
   * symptom — an empty column where the loan files should be — looks exactly
   * like a control plane that denied them, and only this sentence tells a human
   * which variable to go and fix. The tool list beside it is unaffected and
   * still lists what the gateway advertised, which is the other half of the
   * evidence: the gateway answered, we asked it for the wrong thing.
   */
  test("a toolkit name that matches nothing says so, by name, and names the count", async () => {
    const misconfigured = {
      ...harness.config,
      agent: { ...harness.config.agent, toolkits: ["Lending"] },
    };
    const surface = await homeSurface(sessionFor(DANA), { config: misconfigured });

    const refusal = refused(surface);
    expect(refusal.error).toContain("and none of the governed ones is a GetLoan");
    expect(refusal.error).toContain("Check ARCADE_LOAN_TOOLKIT against a real tools/list.");
    // The number is the gateway's own answer, not a constant.
    expect(refusal.error).toMatch(/The gateway advertised [1-9]\d* tools/);
    expect(refusal.detail).toContain("Loan_GetLoan");
  });

  /**
   * A real rule, in the real control plane, refusing a real read.
   *
   * The seeded policy has nothing that refuses `Loan.GetLoan` — acts 1 and 2 are
   * about `ApproveLoan` — so this test writes one and lets the policy cache poll
   * it up, which is the live-edit mechanism `DESIGN.md` describes rather than a
   * stub standing in for one. Bob is the subject, so Alice's reads above and
   * below are untouched, and the rule is removed afterwards.
   *
   * What is being proved is not that a hook can deny. It is that when one does,
   * the page says `denied` — carrying the rule author's sentence and the audit
   * row's `[ref evt_…]` token, which is what the panel joins on. A refusal
   * classified as a fault would put "something broke" on screen next to a panel
   * showing the decision that was actually made.
   */
  test("a rule that refuses the read comes back as a decision, with its audit row", async () => {
    const db = new Database(harness.governanceDbPath);
    try {
      db.run(
        `INSERT INTO policy_rules
           (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority, enabled)
         VALUES
           ('pre.test-analysts-cannot-read', 'For #22''s suite only.', 'pre', 'Loan', 'GetLoan',
            '{"roles":["credit_analyst"]}', '[]', 'deny',
            'DENIED: ${RULE_REASON}. Do not retry.', 5, 1)`,
      );
      db.close();

      // Polled on the rule's own words, not merely on "denied". The control
      // plane fails **closed** while its policy is mid-write — a correct answer,
      // and one that is also a denial — so a looser predicate would let this
      // test pass on a refusal the new rule had nothing to do with.
      const denied = await until(async () => {
        const surface = await load(sessionFor(SAM));
        if (surface.files.status !== "loaded") return null;
        const body = surface.files.body;
        return body.reads.every(
          (entry) => entry.outcome === "denied" && entry.reason.includes(RULE_REASON),
        )
          ? body
          : null;
      });

      for (const entry of denied.reads) {
        expect(entry.outcome).toBe("denied");
        if (entry.outcome !== "denied") throw new Error("unreachable");
        expect(entry.reason).toContain(RULE_REASON);
        // The token the panel joins on, and the proof there is a row behind the
        // sentence rather than a sentence on its own.
        expect(entry.ref).toMatch(/^evt_[0-9a-hj-km-np-tv-z]{10}$/);
        expect(entry.reason).toContain(`[ref ${entry.ref}]`);
      }

      const rows = await harness.audit();
      const row = rows.find((each) => each.id === (denied.reads[0] as { ref: string }).ref);
      expect(row).toBeDefined();
      expect(row?.decision).toBe("deny");
      expect(row?.user_id).toBe(SAM);
    } finally {
      const cleanup = new Database(harness.governanceDbPath);
      cleanup.run(`DELETE FROM policy_rules WHERE id = 'pre.test-analysts-cannot-read'`);
      cleanup.close();
      // Wait for the cache to drop it, so nothing after this file sees it.
      await until(async () => {
        const surface = await load(sessionFor(SAM));
        if (surface.files.status !== "loaded") return null;
        return surface.files.body.reads.every((entry) => entry.outcome === "read")
          ? surface.files.body
          : null;
      });
    }
  }, 20_000);

  /**
   * Last, because it is terminal: the loan book does not come back.
   *
   * The one mislabelling this whole project is organised against. A screen that
   * said "you are not allowed to see this file" when the truth is that a
   * process died would be the demo asserting a control-plane action that never
   * happened — and unlike the reverse mistake, nobody ever finds out.
   */
  test("an unreachable loan book is a fault, and is never called a refusal", async () => {
    await harness.stopLoanApp();
    const surface = await load(sessionFor(DANA));
    const body = loaded(surface);

    expect(body.reads.map((entry) => entry.outcome)).toEqual(["fault", "fault"]);
    expect(crossed(surface)).not.toContain("denied");
    expect(crossed(surface)).not.toContain("CHECK_FAILED");
  });
});

/** Poll until `attempt` returns something, or give up loudly. The policy cache polls every 250ms. */
async function until<T>(attempt: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("the policy cache never picked the change up");
    await Bun.sleep(100);
  }
}

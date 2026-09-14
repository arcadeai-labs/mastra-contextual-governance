/**
 * The left half's loan files, read through the governed path.
 *
 * The point of this suite is one sentence: **the enterprise half of the split
 * screen is a client of the control plane like everything else.** It is easy to
 * build a demo where the pretty panel on the right watches governed calls while
 * the business app on the left quietly reads the database, and impossible to
 * tell from a screenshot. So these tests assert the path, not just the pixels:
 * every loan file on screen came out of a real `tools/call` made as the
 * signed-in person, through the real `/pre`, and is in the audit log.
 *
 * Real here: `apps/hooks` with its real policy, `apps/loan-app` with a real
 * `loans.db`, the real MCP transport, the real route. The Arcade gateway is the
 * stand-in (`scripts/gateway-stand-in.ts`) and is the only fiction — the same
 * line #14 draws, in the same place.
 *
 * No model runs in this file. Reading a loan file is not a turn of the agent,
 * and a cg-web with no `ANTHROPIC_API_KEY` must still show the loan the
 * audience is being asked to think about.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DANA, SAM, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { loanContext } from "../lib/loan-context/handlers.ts";
import {
  DEMO_LOAN_IDS,
  LOAN_CONTEXT_PATH,
  type LoanContextBody,
  type LoanContextRefusal,
} from "../lib/loan-context/loans.ts";
import { writeSession, type Session } from "../lib/identity/session.ts";

let harness: AgentHarness;
let web: ReturnType<typeof Bun.serve>;

/**
 * The sentence the test's own rule writes. Distinctive, so nothing else can
 * produce it.
 *
 * The rule's full reason ends with "Do not retry." because the policy compiler
 * insists on it, twice over. Measured while writing this, off the hook server's
 * own `/health`: a `/pre` denial whose reason neither names a catalogued
 * remediation tool with its arguments nor says "Do not retry" fails to compile
 * — and one that says "Do not retry" *and* names a tool fails too, because it
 * tells the model two different things. Either way the control plane starts
 * failing closed and every call is refused with "its policy is unavailable".
 * Worth knowing before anybody hand-edits a rule on stage.
 */
const RULE_REASON = "credit analysts do not read complete loan files";

beforeAll(async () => {
  harness = await startAgentHarness();
  web = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch: (request) =>
      new URL(request.url).pathname === LOAN_CONTEXT_PATH
        ? loanContext(request, { config: harness.config })
        : new Response(null, { status: 404 }),
  });
}, 60_000);

afterAll(async () => {
  web?.stop(true);
  await harness?.stop();
});

/** The cookie a browser signed in as `email` and holding a gateway token would send. */
async function browserFor(email: string, options: { gateway?: boolean } = {}): Promise<string> {
  const session: Session = {
    email,
    signed_in_at: Date.now(),
    ...(options.gateway === false
      ? {}
      : {
          gateway: {
            access_token: harness.tokenFor(email),
            expires_at: Date.now() + 3_600_000,
            client_id: "mcp-client-for-loan-context-tests",
          },
        }),
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, harness.config);
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
}

async function read(cookie?: string): Promise<{ status: number; body: LoanContextBody & LoanContextRefusal; text: string }> {
  const response = await fetch(`http://localhost:${web.port}${LOAN_CONTEXT_PATH}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

describe("the files on the left half", () => {
  test("both applications come back, read as the person signed in on this browser", async () => {
    const { status, body } = await read(await browserFor(DANA));

    expect(status).toBe(200);
    expect(body.reads.map((entry) => entry.loan_id)).toEqual([...DEMO_LOAN_IDS]);
    expect(body.reads.map((entry) => entry.outcome)).toEqual(["read", "read"]);
    expect(body.actor).toBe(DANA);
  });

  test("what is on screen is what the loan book holds, not a fixture beside it", async () => {
    const { body } = await read(await browserFor(DANA));
    const shown = body.reads[0];
    const held = await harness.loan(DEMO_LOAN_IDS[0], DANA);

    expect(shown?.outcome).toBe("read");
    if (shown?.outcome !== "read") throw new Error("unreachable");
    expect(shown.loan.borrower_name).toBe(held.borrower_name as string);
    expect(shown.loan.amount).toBe(held.amount as number);
    expect(shown.loan.status).toBe(held.status as string);
  });

  /**
   * The whole reason this route exists rather than a database read.
   *
   * `harness.calls` is what the gateway saw. Two `tools/call`s, both
   * `Loan_GetLoan`, both as Dana, both of which ran only because the real `/pre`
   * said `OK` — that is the claim the left half is making by putting a loan
   * file on screen at all.
   */
  test("every file went through the gateway as that person, not round it", async () => {
    const before = harness.calls.length;
    await read(await browserFor(DANA));

    const calls = harness.calls.slice(before);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.tool).toBe("Loan_GetLoan");
      expect(call.user_id).toBe(DANA);
      expect(call.outcome).toBe("ran");
    }
    expect(calls.map((call) => call.inputs.loan_id)).toEqual([...DEMO_LOAN_IDS]);
  });

  test("the control plane recorded both reads", async () => {
    await read(await browserFor(DANA));
    const rows = await harness.audit();

    const reads = rows.filter((row) => row.tool === "Loan.GetLoan" && row.user_id === DANA);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((row) => row.hook === "pre")).toBe(true);
  });

  /**
   * Act 3's subject, kept off the projector.
   *
   * `Loan_GetLoan` returns `bank_account_number` and `tax_id`; this screen does
   * not render them, and the response it serves the browser does not carry
   * them either. Asserted on the wire rather than on the markup, because a
   * value that reaches the client is a value in the page source whatever the
   * component draws.
   */
  test("the borrower's account number and tax id never leave the server", async () => {
    const held = await harness.loan(DEMO_LOAN_IDS[0], DANA);
    const { text } = await read(await browserFor(DANA));

    expect(text).not.toContain("bank_account_number");
    expect(text).not.toContain(held.bank_account_number as string);
    expect(text).not.toContain(held.tax_id as string);
  });
});

describe("when there is nobody to read as", () => {
  test("no session is a refusal that points at signing in, not an empty screen", async () => {
    const { status, body } = await read();

    expect(status).toBe(401);
    expect(body.action).toBe("signin");
    expect(body.error).toContain("signed in");
  });

  test("a session with no gateway token points at the gateway hop", async () => {
    const { status, body } = await read(await browserFor(DANA, { gateway: false }));

    expect(status).toBe(401);
    expect(body.action).toBe("gateway");
  });
});

describe("when the read does not produce a file", () => {
  /**
   * Layer 2, which is not a refusal.
   *
   * `requireAuthorizationFor` is one-shot, exactly as the real gateway is: a
   * persona who authorizes once is not challenged again. So the first file
   * comes back as a link to follow and the second as a file — which is also the
   * assertion that one unauthorized read does not blank the whole panel.
   */
  test("a missing credential is a link to follow, never a denial", async () => {
    harness.gateway.requireAuthorizationFor(
      "Loan_GetLoan",
      "https://cloud.arcade.dev/api/v1/oauth/flow/for-loan-context",
    );
    const { body } = await read(await browserFor(DANA));

    const [first, second] = body.reads;
    expect(first?.outcome).toBe("authorization");
    if (first?.outcome !== "authorization") throw new Error("unreachable");
    expect(first.url).toBe("https://cloud.arcade.dev/api/v1/oauth/flow/for-loan-context");
    expect(second?.outcome).toBe("read");
  });

  /**
   * A real rule, in the real control plane, refusing a real read.
   *
   * The seeded policy has nothing that refuses `Loan.GetLoan` — acts 1 and 2 are
   * about `ApproveLoan` — so this test writes one and lets the policy cache poll
   * it up, which is the live-edit mechanism `DESIGN.md` describes rather than a
   * stub standing in for one. Sam is the subject, so Dana's reads above and
   * below are untouched, and the rule is removed afterwards.
   *
   * What is being proved is not that a hook can deny. It is that when one does,
   * this route says `denied` — carrying the rule author's sentence and the audit
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
        const { body } = await read(await browserFor(SAM));
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
        const { body } = await read(await browserFor(SAM));
        return body.reads.every((entry) => entry.outcome === "read") ? body : null;
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
    const { body, text } = await read(await browserFor(DANA));

    expect(body.reads.map((entry) => entry.outcome)).toEqual(["fault", "fault"]);
    expect(text).not.toContain("denied");
    expect(text).not.toContain("CHECK_FAILED");
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

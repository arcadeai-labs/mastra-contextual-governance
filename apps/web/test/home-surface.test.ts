/**
 * What one load of `/` asks the gateway for.
 *
 * One claim, and it is a number: **one `tools/list`, zero governed tool
 * calls.** Loading a page is not the agent doing something, so nothing a page
 * load does may appear on the control-plane panel — that is #157's whole point,
 * and before it a page load put two `Loan.GetLoan` decisions on the panel
 * before the presenter had said anything, which left the audience unable to
 * tell the agent's work from the page's chrome.
 *
 * The counts are read off the gateway stand-in's own record (`harness.lists`,
 * `harness.calls`), which is what the gateway saw rather than what this code
 * believes it did. A test that asserted "the loan reads were removed" by
 * reading the source would keep passing the day somebody adds one back
 * somewhere else.
 *
 * Real here: `apps/hooks` with its real policy and the real MCP transport. The
 * Arcade gateway is the stand-in (`scripts/gateway-stand-in.ts`) and is the
 * only fiction — the same line #14 draws, in the same place. No model runs: a
 * cg-web with no `ANTHROPIC_API_KEY` must still be able to tell a persona what
 * they may see.
 *
 * This suite was `test/loan-context.test.ts` until #109 and a suite about
 * governed loan reads until #157. The loan book's own tests are now
 * `test/api-loans.test.ts`, which is where a read that costs no tool call
 * belongs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DANA, SAM, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { homeSurface, type HomeSurface } from "../lib/home/surface.ts";
import type { Session } from "../lib/identity/session.ts";

let harness: AgentHarness;

beforeAll(async () => {
  harness = await startAgentHarness();
}, 60_000);

afterAll(async () => {
  await harness?.stop();
});

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

describe("what one page load costs", () => {
  test("one load of / makes exactly one tools/list", async () => {
    const before = harness.lists.length;
    const surface = await load(sessionFor(DANA));

    expect(surface.tools.ok).toBe(true);
    expect(harness.lists.length - before).toBe(1);
  });

  /**
   * #157, as a number.
   *
   * Zero, not "fewer": the presenter's claim about the panel is that every card
   * on it came from the conversation, and one governed call made by the page is
   * enough to make that false.
   */
  test("and zero governed tool calls", async () => {
    const before = harness.calls.length;
    await load(sessionFor(DANA));

    expect(harness.calls.slice(before)).toEqual([]);
  });

  /**
   * The same claim from the control plane's side.
   *
   * `tools/list` still goes through `/access` — that is act 1, and it stays —
   * so the audit log gains `access` rows. What it must not gain is a `pre` row,
   * because a `pre` row is a tool call: something the agent did, in a log the
   * presenter reads aloud.
   */
  test("nothing the page does reaches /pre", async () => {
    await load(sessionFor(DANA));
    const rows = await harness.audit();
    const forThisPerson = rows.filter((row) => row.user_id === DANA);

    expect(forThisPerson.filter((row) => row.hook === "access").length).toBeGreaterThanOrEqual(1);
    expect(forThisPerson.filter((row) => row.hook === "pre")).toEqual([]);
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
    // Act 1 survives: as Bob, the approval tool is absent from the listing
    // itself, so it is absent from the widget without anything here hiding it.
    expect(listing?.hidden).toContain("Loan_ApproveLoan");
    expect(surface.tools.tools.map((tool) => tool.name)).not.toContain("Loan_ApproveLoan");
  });
});

describe("when there is nobody to read as", () => {
  test("no session asks the gateway nothing at all", async () => {
    const before = harness.lists.length;
    const surface = await load(null);

    expect(harness.lists.length - before).toBe(0);
    expect(surface.tools.ok).toBe(false);
  });

  test("a session with no gateway token points at the gateway hop", async () => {
    const surface = await load(sessionFor(DANA, { gateway: false }));

    expect(surface.tools.ok).toBe(false);
    if (surface.tools.ok) throw new Error("unreachable");
    expect(surface.tools.action).toBe("gateway");
    expect(surface.tools.reason).not.toBe("");
  });

  /**
   * The gateway is no longer load-bearing for the loan cards, and this is what
   * that buys.
   *
   * Before #157 a browser with no gateway token lost the tool list **and** the
   * applications, because both came off the same listing. Now only act 1's
   * widget is affected: the cards read the bank's API with the IdP bearer and
   * have nothing to do with hop 1. Asserted here because it is the whole
   * benefit of splitting the two reads, and because the surface this function
   * returns is the only thing that could put them back together.
   */
  test("a missing gateway token costs the tool list and nothing else", async () => {
    const surface = await load(sessionFor(DANA, { gateway: false }));

    expect(Object.keys(surface)).toEqual(["tools"]);
  });
});

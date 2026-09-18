/**
 * #156 against a real control plane, rather than against a fixture of one.
 *
 * The fixture replay proves the panel draws what it is given. This proves the
 * thing it is given is what a live listing actually produces: `apps/hooks` as
 * a subprocess with its real policy compiled, driven through the gateway
 * stand-in by the real server-side page surface, and the rows read back over
 * `GET /audit` — the endpoint, not the database file. Nothing here is built by
 * the code under test.
 *
 * Three claims:
 *
 * 1. **One page load's listing is one Access card.** Six governed tools are
 *    decided for one person in one burst, and the room sees one card.
 * 2. **It names what act 1 took away.** Sam is a credit analyst, so
 *    `Loan.ApproveLoan` is hidden, and the card carries the tool by name and
 *    the rule id that hid it. A card that only counted would let a rule that
 *    matched nothing look exactly like a rule that permitted.
 * 3. **The `/pre` and `/post` lanes are untouched.** Two `Loan.GetLoan` calls
 *    are two decisions at each of those layers, and they stay two cards each —
 *    grouping is the Access lane's alone, because a `/pre` retry is the beat
 *    act 2 turns on.
 *
 * It also **measures the burst**, and prints the spread, which is the number
 * `ACCESS_GROUP_WINDOW_MS` is justified against in `apps/web/README.md`. The
 * window is asserted to be comfortably wider than what a real listing spreads
 * over rather than assumed to be.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GovernanceEvent } from "@cg/policy-schema";
import { renderToStaticMarkup } from "react-dom/server";

import { DANA, SAM, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { ControlPlanePanelView } from "../components/governance/ControlPlanePanelView.tsx";
import { ACCESS_GROUP_WINDOW_MS } from "../lib/governance/grouping.ts";
import { homeSurface } from "../lib/home/surface.ts";
import { appendEvents, emptyTimeline, type Timeline } from "../lib/governance/timeline.ts";
import type { Session } from "../lib/identity/session.ts";

let harness: AgentHarness;

beforeAll(async () => {
  harness = await startAgentHarness();
}, 60_000);

afterAll(async () => {
  await harness?.stop();
});

/** The sealed session a browser signed in as `email` would carry. */
function sessionFor(email: string): Session {
  return {
    email,
    signed_in_at: Date.now(),
    gateway: {
      access_token: harness.tokenFor(email),
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-access-listing-tests",
    },
  };
}

/**
 * One page load, and the audit rows it wrote — in arrival order, read back
 * from `GET /audit`.
 *
 * Scoped by counting what was there first, so one load's burst is the only
 * thing under test even when the suite has made others.
 */
async function loadAndRecord(email: string): Promise<GovernanceEvent[]> {
  const before = (await harness.audit()).length;
  await homeSurface(sessionFor(email), { config: harness.config });
  const rows = await harness.audit();
  // `/audit` answers newest first; reversing gives the order the hook wrote
  // them, which is the order the panel would have received them on the stream.
  return rows
    .slice(0, rows.length - before)
    .reverse()
    .map((row) => GovernanceEvent.parse(row));
}

/** The panel, fed exactly those events and nothing else. */
function panel(events: readonly GovernanceEvent[]): { markup: string; timeline: Timeline } {
  const timeline = appendEvents(emptyTimeline(), events);
  return {
    timeline,
    markup: renderToStaticMarkup(
      <ControlPlanePanelView timeline={timeline} status="live" source={{ mode: "hooks", host: harness.hooksHost }} />,
    ),
  };
}

function lane(markup: string, hook: "access" | "pre" | "post"): string {
  const from = markup.indexOf(`aria-labelledby="cg-lane-${hook}"`);
  const rest = markup.slice(from);
  const next = rest.indexOf('<section class="cg-lane"');
  return next === -1 ? rest : rest.slice(0, next);
}

function cardsIn(markup: string, hook: "access" | "pre" | "post"): string[] {
  return lane(markup, hook).split("<article").slice(1);
}

const accessRows = (events: readonly GovernanceEvent[]): GovernanceEvent[] =>
  events.filter((event) => event.hook === "access");

describe("one page load's listing, through the real control plane", () => {
  test("the analyst's listing is one Access card naming the tool it hid", async () => {
    const events = await loadAndRecord(SAM);
    const access = accessRows(events);
    const { markup } = panel(events);
    const cards = cardsIn(markup, "access");

    // More than one decision went in…
    expect(access.length).toBeGreaterThan(1);
    // …and one card came out.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("tools/list");
    expect(cards[0]).toContain(SAM);
    expect(cards[0]).toContain("Loan.ApproveLoan");
    expect(cards[0]).toContain("access.analysts-cannot-see-approve");
    expect(cards[0]).toContain("1 tool hidden");
  });

  test("the hidden tool is the one the gateway actually withheld from him", async () => {
    // The stand-in's own record of what `/access` took away, so the card is
    // checked against the tool list the client received rather than against
    // the rows the card was drawn from.
    const before = harness.lists.length;
    await homeSurface(sessionFor(SAM), { config: harness.config });
    const list = harness.lists[before];

    expect(list?.user_id).toBe(SAM);
    expect(list?.hidden).toEqual(["Loan_ApproveLoan"]);
  });

  test("the loan officer's listing is one card too, and hides nothing", async () => {
    const events = await loadAndRecord(DANA);
    const cards = cardsIn(panel(events).markup, "access");

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("tools/list");
    expect(cards[0]).toContain("No tool was hidden from this person.");
  });

  test("the lane tally still counts every decision the listing made", async () => {
    const events = await loadAndRecord(SAM);
    const access = accessRows(events);
    const { timeline, markup } = panel(events);
    const counted =
      timeline.laneCounts.access.allow +
      timeline.laneCounts.access.deny +
      timeline.laneCounts.access.modify;

    expect(counted).toBe(access.length);
    expect(lane(markup, "access")).not.toContain("cg-lane-behind");
  });

  test("every decision in the burst is listed by id behind the card's disclosure", async () => {
    const events = await loadAndRecord(SAM);
    const card = cardsIn(panel(events).markup, "access")[0] ?? "";

    for (const event of accessRows(events)) {
      expect(card).toContain(event.id);
    }
  });

  test("the Loan.GetLoan pre and post cards are unaffected — one card per call", async () => {
    const events = await loadAndRecord(DANA);
    const { markup } = panel(events);

    const pre = events.filter((event) => event.hook === "pre");
    const post = events.filter((event) => event.hook === "post");

    expect(pre.length).toBeGreaterThanOrEqual(2);
    expect(cardsIn(markup, "pre")).toHaveLength(pre.length);
    expect(cardsIn(markup, "post")).toHaveLength(post.length);
    expect(lane(markup, "pre")).toContain("Loan.GetLoan");
  });
});

describe("the window, measured rather than assumed", () => {
  test("a real listing's decisions land well inside ACCESS_GROUP_WINDOW_MS", async () => {
    const access = accessRows(await loadAndRecord(SAM));
    const stamps = access.map((event) => Date.parse(event.ts));
    const spread = Math.max(...stamps) - Math.min(...stamps);

    // Printed, because this number is the justification the README carries for
    // the constant and a reviewer should be able to read it off a test run.
    console.log(
      `[#156] one listing: ${access.length} access decisions spread over ${spread} ms ` +
        `(window ${ACCESS_GROUP_WINDOW_MS} ms)`,
    );

    expect(spread).toBeLessThan(ACCESS_GROUP_WINDOW_MS / 10);
  });
});

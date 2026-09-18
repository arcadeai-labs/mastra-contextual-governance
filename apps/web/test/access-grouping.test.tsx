/**
 * #64: repeated `/access` decisions for one person and one tool arrive as
 * separate rows, and the Access lane shows what an audience reads as
 * duplicates.
 *
 * Two halves, both through the public interface and neither mocked:
 *
 * 1. The grouping as a pure function over a lane's events. The property that
 *    matters most is not that things merge — it is that **nothing is lost**:
 *    flattening the rows reproduces the input exactly, in order. Grouping that
 *    quietly dropped a decision would be de-duplication wearing a count, and
 *    the panel would be lying about the audit log it claims to show.
 * 2. The panel in **fixture mode**, end to end — the real route handler over a
 *    real socket, read by the real subscriber, into the real timeline, into
 *    the real view — replaying the shape measured at the #13 sitting: three
 *    `access` rows for one `Loan.GetLoan`, two for one `Loan.ApproveLoan`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GovernanceEvent, HookPoint } from "@cg/policy-schema";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";
import { renderToStaticMarkup } from "react-dom/server";

import { GET } from "../app/api/governance/fixture-stream/route.ts";
import { ControlPlanePanelView } from "../components/governance/ControlPlanePanelView.tsx";
import { anAccessFanout } from "../lib/governance/access-fanout.ts";
import { anAccessListing } from "../lib/governance/access-listing.ts";
import {
  ACCESS_GROUP_WINDOW_MS,
  groupAccessEvents,
  rowsFor,
} from "../lib/governance/grouping.ts";
import { subscribeToGovernanceEvents } from "../lib/governance/subscribe.ts";
import { appendEvents, emptyTimeline, type Timeline } from "../lib/governance/timeline.ts";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

/** An access decision `afterMs` past the epoch. Defaults match, so they group. */
function access(
  id: string,
  afterMs: number,
  overrides: Partial<{ tool: string; user_id: string; decision: "allow" | "deny" | "modify"; hook: HookPoint }> = {},
): GovernanceEvent {
  return aGovernanceEvent({
    id,
    ts: new Date(EPOCH + afterMs).toISOString(),
    execution_id: "",
    hook: overrides.hook ?? "access",
    user_id: overrides.user_id ?? "alice@bank.example",
    tool: overrides.tool ?? "Loan.GetLoan",
    decision: overrides.decision ?? "allow",
    rule_id: null,
  });
}

/** A lane holds its events newest first; so does every row. */
function newestFirst(events: readonly GovernanceEvent[]): GovernanceEvent[] {
  return [...events].reverse();
}

const idsOf = (rows: ReturnType<typeof groupAccessEvents>): string[][] =>
  rows.map((row) => row.events.map((event) => event.id));

describe("adjacent access decisions about the same call are one row", () => {
  test("three for one tool collapse into a single row carrying all three", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 40), access("evt_3", 80)]),
    );

    expect(rows).toHaveLength(1);
    expect(idsOf(rows)).toEqual([["evt_3", "evt_2", "evt_1"]]);
  });

  test("the row is drawn from its newest member, so the freshest card stays freshest", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 40), access("evt_3", 80)]),
    );

    expect(rows[0]?.event.id).toBe("evt_3");
  });

  test("the measured shape — three GetLoan, two ApproveLoan — is two rows", () => {
    const rows = groupAccessEvents(newestFirst(anAccessFanout()));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.event.tool}×${row.events.length}`)).toEqual([
      "Loan.ApproveLoan×2",
      "Loan.GetLoan×3",
    ]);
  });
});

describe("nothing is dropped and nothing is reordered", () => {
  test("flattening the rows reproduces the input exactly", () => {
    const events = newestFirst([
      ...anAccessFanout(),
      access("evt_other", 400, { user_id: "bob@bank.example" }),
      access("evt_denied", 440, { decision: "deny" }),
    ]);

    const flattened = groupAccessEvents(events).flatMap((row) => row.events);

    expect(flattened).toEqual(events);
  });

  test("the counts across the rows add up to every event given", () => {
    const events = newestFirst(anAccessFanout());

    const total = groupAccessEvents(events).reduce((sum, row) => sum + row.events.length, 0);

    expect(total).toBe(events.length);
  });

  test("two matching decisions with another between them stay two rows", () => {
    // Reaching past the middle event to merge these would reorder the lane,
    // and not reordering is the timeline's first property.
    const rows = groupAccessEvents(
      newestFirst([
        access("evt_1", 0),
        access("evt_2", 20, { tool: "Loan.SearchLoans" }),
        access("evt_3", 40),
      ]),
    );

    expect(idsOf(rows)).toEqual([["evt_3"], ["evt_2"], ["evt_1"]]);
  });
});

describe("what splits a row", () => {
  test("a different tool", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 20, { tool: "Loan.ApproveLoan" })]),
    );

    expect(rows).toHaveLength(2);
  });

  test("a different person", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 20, { user_id: "bob@bank.example" })]),
    );

    expect(rows).toHaveLength(2);
  });

  test("a different decision — the interesting case is never a duplicate", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 20, { decision: "deny" })]),
    );

    expect(rows).toHaveLength(2);
  });

  test("a gap wider than the window", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", ACCESS_GROUP_WINDOW_MS + 1)]),
    );

    expect(rows).toHaveLength(2);
  });

  test("a gap exactly the width of the window still groups", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", ACCESS_GROUP_WINDOW_MS)]),
    );

    expect(rows).toHaveLength(1);
  });

  test("a slow drip never chains into one unbounded row", () => {
    // Each is two seconds after the last, inside a three-second window, but
    // the span from the first to the third is four. Measuring from the row's
    // newest member rather than from its neighbour is what stops a minute of
    // decisions collapsing into a row claiming they arrived together.
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 2000), access("evt_3", 4000)]),
    );

    expect(idsOf(rows)).toEqual([["evt_3", "evt_2"], ["evt_1"]]);
  });

  test("a timestamp that will not parse groups with nothing", () => {
    const broken = aGovernanceEvent({ id: "evt_broken", hook: "access", ts: "2026-01-01T00:00:00.000Z" });
    const rows = groupAccessEvents([
      { ...broken, ts: "not a date" },
      access("evt_1", 0),
    ]);

    expect(idsOf(rows)).toEqual([["evt_broken"], ["evt_1"]]);
  });
});

describe("only the access lane groups", () => {
  test("pre does not — two adjacent identical rows there are two real attempts", () => {
    const events = newestFirst([
      access("evt_1", 0, { hook: "pre" }),
      access("evt_2", 20, { hook: "pre" }),
    ]);

    expect(rowsFor("pre", events)).toHaveLength(2);
  });

  test("post does not either", () => {
    const events = newestFirst([
      access("evt_1", 0, { hook: "post" }),
      access("evt_2", 20, { hook: "post" }),
    ]);

    expect(rowsFor("post", events)).toHaveLength(2);
  });

  test("access does", () => {
    expect(rowsFor("access", newestFirst([access("evt_1", 0), access("evt_2", 20)]))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function render(events: readonly GovernanceEvent[]): string {
  return renderToStaticMarkup(
    <ControlPlanePanelView
      timeline={appendEvents(emptyTimeline(), events)}
      status="live"
      source={{ mode: "fixture" }}
    />,
  );
}

/** One lane's markup, so a count cannot be matched from another lane. */
function lane(markup: string, hook: HookPoint): string {
  const from = markup.indexOf(`aria-labelledby="cg-lane-${hook}"`);
  const rest = markup.slice(from);
  const next = rest.indexOf('<section class="cg-lane"');
  return next === -1 ? rest : rest.slice(0, next);
}

function cardsIn(markup: string, hook: HookPoint): string[] {
  return lane(markup, hook).split("<article").slice(1);
}

describe("the access lane draws one card per run of decisions", () => {
  const markup = render(anAccessFanout());

  test("the measured fan-out is two cards, not five", () => {
    expect(cardsIn(markup, "access")).toHaveLength(2);
  });

  test("each card says in words how many decisions it stands for", () => {
    expect(markup).toContain("3 decisions");
    expect(markup).toContain("2 decisions");
  });

  test("both tools are still named — grouping joins, it does not hide", () => {
    expect(markup).toContain("Loan.GetLoan");
    expect(markup).toContain("Loan.ApproveLoan");
  });

  test("expanding a row lists the individual event ids", () => {
    for (const event of anAccessFanout()) {
      expect(markup).toContain(event.id);
    }
  });

  test("the ids sit in a disclosure rather than on the face of the card", () => {
    expect(markup).toContain('<details class="cg-event-members">');
    expect(markup).toContain('<ul class="cg-event-ids">');
  });

  test("the lane's own tally still counts all five decisions", () => {
    expect(lane(markup, "access")).toContain('<span class="cg-lane-count-value">5</span>');
  });

  test("so does the panel's tally — grouping is presentation, not arithmetic", () => {
    expect(markup).toContain(
      '<span class="cg-stat-value">5</span><span class="cg-stat-label">Allowed</span>',
    );
  });

  test("nothing is counted as an earlier decision: all five are on screen", () => {
    expect(markup).not.toContain("cg-lane-behind");
  });
});

describe("an ordinary single decision is unchanged", () => {
  const markup = render([access("evt_1", 0)]);

  test("carries no count", () => {
    expect(markup).not.toContain("cg-event-count");
  });

  test("carries no disclosure", () => {
    expect(markup).not.toContain("cg-event-members");
  });

  test("#5's sequence still renders one card per event", () => {
    expect(render(aGovernanceEventSequence()).split("<article").slice(1)).toHaveLength(5);
  });
});

describe("the pre lane still draws every attempt", () => {
  test("three identical pre decisions are three cards, because they are three calls", () => {
    const markup = render(
      newestFirst([
        access("evt_1", 0, { hook: "pre" }),
        access("evt_2", 20, { hook: "pre" }),
        access("evt_3", 40, { hook: "pre" }),
      ]),
    );

    expect(cardsIn(markup, "pre")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Fixture mode, end to end
// ---------------------------------------------------------------------------

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

function serveFixtureRoute(): string {
  // Port 0: the OS hands one back. This worktree owns a block of ten and the
  // reviewer's is a different block; a hard-coded port would collide.
  const server = Bun.serve({ port: 0, fetch: (request) => GET(request) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/governance/fixture-stream`;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

async function play(url: string, count: number): Promise<{ timeline: Timeline; ids: string[] }> {
  let timeline = emptyTimeline();
  const ids: string[] = [];
  const controller = new AbortController();
  const done = subscribeToGovernanceEvents(url, {
    onEvents: (batch) => {
      ids.push(...batch.map((event) => event.id));
      timeline = appendEvents(timeline, batch);
    },
    signal: controller.signal,
    retryMs: 20,
  });

  await until(() => timeline.received >= count, `${count} events from the fixture stream`);
  controller.abort();
  await done;
  return { timeline, ids };
}

/**
 * `?fanout=1` carries a second burst since #156 — one persona's whole
 * `tools/list`, ten seconds after the fan-out — so the counts here are stated
 * in terms of both fixtures rather than as literals. What this suite is about
 * is unchanged: the five measured fan-out decisions are two rows, and every
 * one of them reaches the panel. `access-listing.test.tsx` owns the listing.
 */
const FIXTURE_EVENTS = 5 + anAccessFanout().length + anAccessListing().length;

describe("fixture mode replays the measured fan-out", () => {
  test("?fanout=1 adds the five measured access decisions to the four acts", async () => {
    const { timeline } = await play(`${serveFixtureRoute()}?fanout=1&delayMs=0`, FIXTURE_EVENTS);

    expect(timeline.received).toBe(FIXTURE_EVENTS);
    // Every event but the four the other two lanes take.
    expect(timeline.lanes.access).toHaveLength(FIXTURE_EVENTS - 4);
  });

  test("the stream itself carries every one of them — no de-duplication on the wire", async () => {
    const { ids } = await play(`${serveFixtureRoute()}?fanout=1&delayMs=0`, FIXTURE_EVENTS);

    for (const event of anAccessFanout()) {
      expect(ids).toContain(event.id);
    }
  });

  test("the panel draws the five as two rows, beside #5's access event and the listing", async () => {
    const { timeline } = await play(`${serveFixtureRoute()}?fanout=1&delayMs=0`, FIXTURE_EVENTS);

    const markup = renderToStaticMarkup(
      <ControlPlanePanelView timeline={timeline} status="live" source={{ mode: "fixture" }} />,
    );

    expect(cardsIn(markup, "access")).toHaveLength(4);
    expect(markup).toContain("3 decisions");
    expect(markup).toContain("2 decisions");
  });

  test("off by default, so the four acts are still the story a clean /panel tells", async () => {
    const { timeline } = await play(`${serveFixtureRoute()}?delayMs=0`, 5);
    await Bun.sleep(150);

    expect(timeline.received).toBe(5);
    expect(timeline.lanes.access).toHaveLength(1);
  });
});

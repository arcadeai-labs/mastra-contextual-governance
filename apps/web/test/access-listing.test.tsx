/**
 * #156: one `tools/list` from a persona lands as a burst of `/access`
 * decisions — six or so through the local rig, about ten on the deployed
 * gateway — and the Access lane drew a card for each of them, arriving faster
 * than anyone can narrate.
 *
 * What this file holds the implementation to:
 *
 * 1. **One card per listing, and it names what was taken away.** The card is
 *    only worth having if `Loan.ApproveLoan` is on it by name with the rule
 *    that hid it; a card that said "6 decisions" would be the fan-out card
 *    with more decisions behind it.
 * 2. **Nothing is lost.** Flattening the rows reproduces the lane exactly, the
 *    expander lists every member event id, and both tallies still count every
 *    decision. Grouping that dropped one would be de-duplication wearing a
 *    label.
 * 3. **The label is evidence, not a guess.** A burst that is not a listing —
 *    the `tools/call` fan-out measured on #13 — must not say `tools/list` on
 *    its face. A control surface that asserts an event it did not see is the
 *    failure this repo is organised against.
 *
 * Everything here is through the public interface: the real grouping, the real
 * view, and for the last section the real route handler over a real socket
 * read by the real subscriber. Nothing is mocked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GovernanceEvent, HookPoint } from "@cg/policy-schema";
import { aGovernanceEvent } from "@cg/policy-schema";
import { renderToStaticMarkup } from "react-dom/server";

import { GET } from "../app/api/governance/fixture-stream/route.ts";
import { ControlPlanePanelView } from "../components/governance/ControlPlanePanelView.tsx";
import { anAccessFanout } from "../lib/governance/access-fanout.ts";
import { anAccessListing } from "../lib/governance/access-listing.ts";
import {
  ACCESS_GROUP_WINDOW_MS,
  groupAccessEvents,
  listingFacts,
  LISTING_TOOL_SPREAD,
  rowCount,
  SUMMARY_TOOL,
} from "../lib/governance/grouping.ts";
import { subscribeToGovernanceEvents } from "../lib/governance/subscribe.ts";
import { appendEvents, emptyTimeline, type Timeline } from "../lib/governance/timeline.ts";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const SAM = "bob@bank.example";
const DANA = "alice@bank.example";

/** An access decision `afterMs` past the epoch. */
function access(
  id: string,
  afterMs: number,
  overrides: Partial<Pick<GovernanceEvent, "tool" | "user_id" | "decision" | "rule_id">> = {},
): GovernanceEvent {
  return aGovernanceEvent({
    id,
    ts: new Date(EPOCH + afterMs).toISOString(),
    execution_id: "",
    hook: "access",
    user_id: overrides.user_id ?? SAM,
    tool: overrides.tool ?? "Loan.GetLoan",
    decision: overrides.decision ?? "allow",
    rule_id: overrides.rule_id ?? null,
  });
}

/** A lane holds its events newest first; so does every row. */
function newestFirst(events: readonly GovernanceEvent[]): GovernanceEvent[] {
  return [...events].reverse();
}

/** The listing fixture as a lane holds it, optionally shifted in time and renamed. */
function listing(options: { shiftMs?: number; user?: string; tag?: string } = {}): GovernanceEvent[] {
  const shift = options.shiftMs ?? 0;
  return anAccessListing().map((event) => ({
    ...event,
    id: options.tag === undefined ? event.id : `${event.id}_${options.tag}`,
    ts: new Date(Date.parse(event.ts) + shift).toISOString(),
    ...(options.user === undefined ? {} : { user_id: options.user }),
  }));
}

// ---------------------------------------------------------------------------
// The grouping
// ---------------------------------------------------------------------------

describe("one person's listing is one row", () => {
  test("the whole burst — six governed tools and the summary row — is a single row", () => {
    const rows = groupAccessEvents(newestFirst(listing()));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.listing).toBe(true);
    expect(rowCount(rows[0] as (typeof rows)[number])).toBe(anAccessListing().length);
  });

  test("flattening the rows reproduces the lane exactly", () => {
    const events = newestFirst([...anAccessFanout(), ...listing()]);

    expect(groupAccessEvents(events).flatMap((row) => row.events)).toEqual(events);
  });

  test("the row is drawn from its newest member, so the freshest card stays freshest", () => {
    const events = newestFirst(listing());

    expect(groupAccessEvents(events)[0]?.event.id).toBe(events[0]?.id);
  });
});

describe("what splits two listings", () => {
  test("the same person, further apart than the window, is two cards", () => {
    const rows = groupAccessEvents(
      newestFirst([
        ...listing(),
        ...listing({ shiftMs: ACCESS_GROUP_WINDOW_MS + 1_000, tag: "second" }),
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.listing)).toBe(true);
  });

  test("two people inside the window are two cards", () => {
    // Back to back, which is how two listings actually arrive: one `/access`
    // call's rows are written together, so a second person's burst follows the
    // first rather than threading through it.
    const rows = groupAccessEvents(
      newestFirst([...listing(), ...listing({ shiftMs: 100, user: DANA, tag: "dana" })]),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event.user_id)).toEqual([DANA, SAM]);
    expect(rows.every((row) => row.listing)).toBe(true);
  });

  /**
   * The consequence of only grouping adjacent events, stated rather than
   * discovered. Two listings that genuinely interleaved on the wire cannot be
   * merged without reordering the lane, and not reordering is the timeline's
   * first property — so the panel draws them apart instead of rewriting the
   * order they arrived in.
   */
  test("decisions that truly interleave are not reached past to merge them", () => {
    const mine = listing();
    const theirs = listing({ user: DANA, tag: "dana" });
    const interleaved = newestFirst(
      mine.flatMap((event, index) => [event, theirs[index] as GovernanceEvent]),
    );

    const rows = groupAccessEvents(interleaved);

    expect(rows.flatMap((row) => row.events)).toEqual(interleaved);
    expect(rows.length).toBe(interleaved.length);
  });
});

describe("what is not a listing", () => {
  test("a lone access decision is the single card it always was", () => {
    const rows = groupAccessEvents([access("evt_1", 0)]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.listing).toBe(false);
    expect(rowCount(rows[0] as (typeof rows)[number])).toBe(1);
  });

  test("the measured #13 fan-out is still runs of repeats, not a listing", () => {
    const rows = groupAccessEvents(newestFirst(anAccessFanout()));

    expect(rows.map((row) => `${row.event.tool}×${row.events.length}`)).toEqual([
      "Loan.ApproveLoan×2",
      "Loan.GetLoan×3",
    ]);
    expect(rows.some((row) => row.listing)).toBe(false);
  });

  test("two distinct tools in one burst is under the spread, so it is not a listing", () => {
    const rows = groupAccessEvents(
      newestFirst([access("evt_1", 0), access("evt_2", 20, { tool: "Loan.ApproveLoan" })]),
    );

    expect(rows.some((row) => row.listing)).toBe(false);
  });

  test(`${LISTING_TOOL_SPREAD} distinct tools is, because no measured tools/call names that many`, () => {
    const rows = groupAccessEvents(
      newestFirst([
        access("evt_1", 0),
        access("evt_2", 20, { tool: "Loan.ApproveLoan" }),
        access("evt_3", 40, { tool: "Loan.SearchLoans" }),
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.listing).toBe(true);
  });

  test("a summary row is evidence on its own — only a catalogue-wide call writes one", () => {
    const rows = groupAccessEvents([access("evt_summary", 0, { tool: SUMMARY_TOOL, decision: "deny" })]);

    expect(rows[0]?.listing).toBe(true);
  });
});

describe("what a listing card may state", () => {
  const facts = listingFacts(groupAccessEvents(newestFirst(listing()))[0] as never);

  test("the tools left visible, in the order the control plane decided them", () => {
    expect(facts.enabled).toEqual([
      "Loan.SearchLoans",
      "Loan.GetLoan",
      "Loan.DenyLoan",
      "Approvals.RequestApproval",
      "Approvals.Decide",
    ]);
  });

  test("the tool taken away, with the rule that took it", () => {
    expect(facts.hidden).toEqual([
      {
        tool: "Loan.ApproveLoan",
        rule_id: "access.analysts-cannot-see-approve",
        reason: "Credit analysts do not hold approval authority; the tool is hidden from this role.",
      },
    ]);
  });

  test("the summary row is held as itself and never counted as a tool", () => {
    expect(facts.summary?.tool).toBe(SUMMARY_TOOL);
    expect(facts.enabled).not.toContain(SUMMARY_TOOL);
    expect(facts.hidden.map((tool) => tool.tool)).not.toContain(SUMMARY_TOOL);
  });

  test("the decision count is every member, summary row included", () => {
    expect(facts.decisions).toBe(anAccessListing().length);
  });

  /**
   * The deployed shape: Arcade answers one `tools/list` with four `/access`
   * calls, so a governed tool is decided more than once in one burst. The card
   * counts tools, not decisions — six decisions about `Loan.GetLoan` are one
   * tool this person can see.
   */
  test("a tool decided by more than one call in the burst is one tool, not several", () => {
    const twice = newestFirst([...listing(), ...listing({ shiftMs: 50, tag: "call2" })]);
    const rows = groupAccessEvents(twice);
    const repeated = listingFacts(rows[0] as (typeof rows)[number]);

    expect(rows).toHaveLength(1);
    expect(repeated.decisions).toBe(anAccessListing().length * 2);
    expect(repeated.enabled).toHaveLength(5);
    expect(repeated.hidden).toHaveLength(1);
  });

  test("a tool one call allowed and another hid is reported hidden, the louder of the two", () => {
    const rows = groupAccessEvents(
      newestFirst([
        access("evt_1", 0, { tool: "Loan.SearchLoans" }),
        access("evt_2", 10, { tool: "Loan.GetLoan" }),
        access("evt_3", 20, { tool: "Loan.ApproveLoan" }),
        access("evt_4", 30, { tool: "Loan.ApproveLoan", decision: "deny", rule_id: "access.hide" }),
      ]),
    );
    const facts = listingFacts(rows[0] as (typeof rows)[number]);

    expect(facts.hidden.map((tool) => tool.tool)).toEqual(["Loan.ApproveLoan"]);
    expect(facts.enabled).not.toContain("Loan.ApproveLoan");
  });
});

// ---------------------------------------------------------------------------
// The card
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

describe("the listing card", () => {
  const events = listing();
  const markup = render(newestFirst(events));
  const card = cardsIn(markup, "access")[0] ?? "";

  test("is one card for the whole burst", () => {
    expect(cardsIn(markup, "access")).toHaveLength(1);
  });

  test("names the call it stands for", () => {
    expect(card).toContain('<p class="cg-tool">tools/list</p>');
  });

  test("names the person", () => {
    expect(card).toContain(SAM);
  });

  test("states what survived as a count and what was hidden as a count", () => {
    expect(card).toContain("5 tools enabled");
    expect(card).toContain("1 tool hidden");
  });

  test("names the hidden tool on the face of the card", () => {
    expect(card).toContain('<p class="cg-listing-hidden-tool">Loan.ApproveLoan</p>');
  });

  test("carries the rule id that hid it, in the rule chip every other card uses", () => {
    expect(card).toContain('<p class="cg-rule">access.analysts-cannot-see-approve</p>');
  });

  test("reads as a denial from across the room, because something was taken away", () => {
    expect(card.slice(0, 200)).toContain('data-decision="deny"');
  });

  test("the allowed tools are behind a disclosure, by name", () => {
    for (const tool of ["Loan.SearchLoans", "Loan.GetLoan", "Loan.DenyLoan", "Approvals.RequestApproval", "Approvals.Decide"]) {
      expect(card).toContain(`<li>${tool}</li>`);
    }
  });

  test("the summary row is shown in the hook's own words, not as a tool called *", () => {
    expect(card).toContain("8272 tools outside this control plane&#x27;s catalogue");
    expect(card).not.toContain('<p class="cg-tool">*</p>');
  });

  test("the expander lists every member event id", () => {
    for (const event of events) {
      expect(card).toContain(event.id);
    }
  });

  test("says how many decisions it stands for, in words, on its face", () => {
    expect(card).toContain(`${events.length} decisions`);
  });

  test("does not claim Arcade called /access once", () => {
    expect(card).toContain("recorded separately");
    expect(card).toContain("more than once");
  });

  test("the lane tally still counts every decision, not every card", () => {
    // Six allow — the summary row is a deny — over one card.
    expect(lane(markup, "access")).toContain('<span class="cg-lane-count-value">5</span>');
    expect(lane(markup, "access")).toContain('<span class="cg-lane-count-value">2</span>');
  });

  test("nothing is counted as an earlier decision: the whole burst is on screen", () => {
    expect(lane(markup, "access")).not.toContain("cg-lane-behind");
  });
});

describe("a burst that is not a listing never says so", () => {
  const markup = render(newestFirst(anAccessFanout()));

  test("the #13 fan-out draws its two cards without the word tools/list", () => {
    expect(cardsIn(markup, "access")).toHaveLength(2);
    expect(markup).not.toContain("tools/list");
  });

  test("and keeps the count it has carried since #64", () => {
    expect(markup).toContain("3 decisions");
    expect(markup).toContain("2 decisions");
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

async function play(url: string, count: number): Promise<Timeline> {
  let timeline = emptyTimeline();
  const controller = new AbortController();
  const done = subscribeToGovernanceEvents(url, {
    onEvents: (batch) => {
      timeline = appendEvents(timeline, batch);
    },
    signal: controller.signal,
    retryMs: 20,
  });

  await until(() => timeline.received >= count, `${count} events from the fixture stream`);
  controller.abort();
  await done;
  return timeline;
}

/** Four acts + the #13 fan-out + one listing, which is what `?fanout=1` now is. */
const FIXTURE_EVENTS = 5 + anAccessFanout().length + anAccessListing().length;

describe("?fanout=1 replays both measured shapes", () => {
  test("every event reaches the panel — the stream de-duplicates nothing", async () => {
    const timeline = await play(`${serveFixtureRoute()}?fanout=1&delayMs=0`, FIXTURE_EVENTS);

    expect(timeline.received).toBe(FIXTURE_EVENTS);
    expect(timeline.lanes.access).toHaveLength(FIXTURE_EVENTS - 4);
  });

  test("the access lane draws four cards: #5's own, the fan-out's two, and one listing", async () => {
    const timeline = await play(`${serveFixtureRoute()}?fanout=1&delayMs=0`, FIXTURE_EVENTS);
    const markup = renderToStaticMarkup(
      <ControlPlanePanelView timeline={timeline} status="live" source={{ mode: "fixture" }} />,
    );

    const cards = cardsIn(markup, "access");
    expect(cards).toHaveLength(4);
    // Newest first: the listing is the last burst the stream sends.
    expect(cards[0]).toContain("tools/list");
    expect(cards[0]).toContain("Loan.ApproveLoan");
    expect(cards.slice(1).some((drawn) => drawn.includes("tools/list"))).toBe(false);
  });
});

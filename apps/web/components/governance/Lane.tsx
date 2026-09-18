/**
 * One control point's column: its name, what it controls, its own tally, and
 * its events newest-first so the freshest card is always in the same place.
 *
 * The lane header is the largest thing on the panel after the title. The three
 * control points are the structure the audience should find first; a card is a
 * detail inside one of them.
 *
 * The lane draws at most `visible` cards, and one card can stand for several
 * decisions. Two shapes do that, and the Access lane draws them differently:
 * a run of repeats about one tool keeps the ordinary card with its count
 * (`/access` fans out — one `tools/call` produced three access decisions for
 * one tool when it was measured, #64), while a person's whole `tools/list`
 * becomes one `<AccessListingCard>` naming what it took away (#156).
 * `lib/governance/grouping.ts` owns both rules, decides which burst is
 * evidence of a listing, and says at length why all of it is presentation only.
 * What the header counts is unaffected: a grouped row is *n* decisions drawn,
 * not one, so "earlier decisions" stays a count of decisions the audience
 * cannot see rather than of cards that were not drawn.
 *
 * Everything the timeline holds beyond what is drawn, plus everything it has
 * already let go, is *counted and stated* in the header — an audit surface
 * that quietly discards records would argue against the thing this project
 * argues for. It sits in the header rather than under the cards because under
 * them it is the first thing a burst pushes out of a lane that clips its
 * overflow, so the one line saying "there is more than this" would disappear
 * exactly when it became true.
 */
import type { Effect, GovernanceEvent, HookPoint } from "@cg/policy-schema";
import type { KeyboardEvent } from "react";

import { rowCount, rowsFor } from "../../lib/governance/grouping.ts";
import { AccessListingCard } from "./AccessListingCard.tsx";
import { EventCard } from "./EventCard.tsx";
import { DECISION_ORDER, DECISIONS, LANES } from "./decisions.ts";

/**
 * Make the named scroll region usable without a pointer. Native scrolling is
 * inconsistent for a focusable generic div (notably PageDown and End in
 * Chromium), so the panel handles the same small set of keys explicitly.
 * Events from a disclosure inside a card are left alone so its summary keeps
 * native details keyboard behaviour.
 */
function scrollWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.target !== event.currentTarget) return;

  const region = event.currentTarget;
  const page = Math.max(region.clientHeight * 0.85, 1);
  const step = Math.max(region.clientHeight * 0.2, 24);
  let top: number | null = null;
  let left: number | null = null;

  switch (event.key) {
    case "ArrowDown":
      top = region.scrollTop + step;
      break;
    case "ArrowUp":
      top = region.scrollTop - step;
      break;
    case "PageDown":
      top = region.scrollTop + page;
      break;
    case "PageUp":
      top = region.scrollTop - page;
      break;
    case "ArrowRight":
      left = region.scrollLeft + step;
      break;
    case "ArrowLeft":
      left = region.scrollLeft - step;
      break;
    case "Home":
      if (event.shiftKey) left = 0;
      else top = 0;
      break;
    case "End":
      if (event.shiftKey) left = region.scrollWidth;
      else top = region.scrollHeight;
      break;
    case " ":
      top = region.scrollTop + (event.shiftKey ? -page : page);
      break;
    default:
      return;
  }

  event.preventDefault();
  if (top !== null) region.scrollTop = top;
  if (left !== null) region.scrollLeft = left;
}

export function Lane({
  hook,
  events,
  behind,
  counts,
  visible,
  flashKey,
  correlatedIds,
}: {
  hook: HookPoint;
  /** Newest first. */
  events: readonly GovernanceEvent[];
  /** Events this lane received and no longer holds. */
  behind: number;
  /** This lane's own decisions, over everything it ever received. */
  counts: Readonly<Record<Effect, number>>;
  /** How many cards to draw. Rows, not events — a card can carry several. */
  visible: number;
  /**
   * The newest event in this lane, or `null`. Used as a React key on the flash
   * element so a new event remounts it and restarts the animation — no timers,
   * and no way for the lane to get stuck lit.
   */
  flashKey: GovernanceEvent | null;
  correlatedIds: ReadonlySet<string>;
}) {
  const lane = LANES[hook];
  const rows = rowsFor(hook, events);
  const drawn = rows.slice(0, visible);
  // Counted in decisions rather than cards. A row saying "3 decisions" has
  // shown all three of them, and calling two of those "earlier decisions" in
  // the header as well would double-count the fan-out this grouping exists to
  // make legible.
  const shown = drawn.reduce((total, row) => total + rowCount(row), 0);
  const notDrawn = events.length - shown + behind;
  // Only decisions this lane has actually made. A lane that has denied nothing
  // should not carry a zero for it; the global tally is where totals live.
  const present = DECISION_ORDER.filter((decision) => counts[decision] > 0);

  return (
    <section className="cg-lane" aria-labelledby={`cg-lane-${hook}`}>
      {flashKey !== null && (
        <span
          className="cg-flash"
          data-decision={flashKey.decision}
          key={flashKey.id}
          aria-hidden="true"
        />
      )}

      <header className="cg-lane-head">
        <h3 className="cg-lane-name" id={`cg-lane-${hook}`}>
          {lane.name}
        </h3>
        <p className="cg-lane-gloss">{lane.gloss}</p>

        {present.length > 0 && (
          <p className="cg-lane-counts">
            {present.map((decision) => (
              <span className="cg-lane-count" data-decision={decision} key={decision}>
                <span className="cg-lane-count-value">{counts[decision]}</span>
                <span>{DECISIONS[decision].lane}</span>
              </span>
            ))}
          </p>
        )}

        {notDrawn > 0 && (
          <p className="cg-lane-behind">
            {notDrawn.toLocaleString("en-US")} earlier {notDrawn === 1 ? "decision" : "decisions"}
          </p>
        )}
      </header>

      <div
        className="cg-lane-events"
        role="region"
        aria-label={`${lane.name} decisions`}
        aria-keyshortcuts="ArrowDown ArrowUp PageDown PageUp ArrowLeft ArrowRight Home End Space"
        tabIndex={0}
        onKeyDown={scrollWithKeyboard}
      >
        {drawn.length === 0 ? (
          <p className="cg-lane-empty">{lane.empty}</p>
        ) : (
          drawn.map((row) =>
            // Any member joining the chat's execution outlines the row: the
            // join is to a decision, and the row is standing in for all of
            // them.
            row.listing ? (
              <AccessListingCard
                key={row.event.id}
                row={row}
                correlated={row.events.some((member) => correlatedIds.has(member.id))}
              />
            ) : (
              <EventCard
                key={row.event.id}
                event={row.event}
                members={row.events}
                correlated={row.events.some((member) => correlatedIds.has(member.id))}
              />
            ),
          )
        )}
      </div>
    </section>
  );
}

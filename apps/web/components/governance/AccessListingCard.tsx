/**
 * One person's tool listing, as a card.
 *
 * A `tools/list` is answered by several `/access` calls and each writes a row
 * per governed tool, so a listing lands as a burst of decisions in a rush —
 * ten or so on the deployed gateway, before the presenter has said anything
 * (#156). Drawn one card each they are unnarratable, and the one fact the
 * audience is meant to take from them is singular anyway: **this is what that
 * person can see.**
 *
 * So the card answers that, in the order it is said out loud:
 *
 * 1. **Whose listing, and when** — the quiet meta line every card here has.
 * 2. **`tools/list`** — in the same monospace slot the tool call occupies on
 *    an ordinary card, because it is the same question: which call is this.
 *    Only ever drawn when the burst is *evidence* of a listing;
 *    `lib/governance/grouping.ts` owns that rule and says why at length.
 * 3. **What was taken away, by name** — the tools this person cannot see, each
 *    with the rule that hid it and the rule's own words. This is act 1, and it
 *    is the reason the card exists rather than a tally.
 * 4. **What was left**, as a count, expandable to names. Six visible tools is
 *    a number; six tool names is a wall nobody reads from the back of a room.
 *
 * The counts on the card are over the members the lane still **holds**. A lane
 * is bounded (`timeline.ts`), so a whole-project sweep of ten thousand tools
 * reaches this card as the fifty the lane kept — and the rest are counted in
 * the lane header rather than dropped, which is the same accounting every
 * other card on this panel is drawn under.
 *
 * The card never says Arcade called `/access` once. It says how many decisions
 * it stands for, on its face, and lists every one of their event ids behind a
 * disclosure — the same contract the grouped card has carried since #64. A
 * control surface that flattened four calls into a claim of one would be
 * asserting an event that did not happen.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

import { listingFacts, type EventRow } from "../../lib/governance/grouping.ts";
import { DECISIONS } from "./decisions.ts";

/** `16:04:31` — the wall clock a presenter can point at. UTC, as the event is. */
function timeOf(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  return at.toISOString().slice(11, 19);
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export function AccessListingCard({
  row,
  correlated = false,
}: {
  /** A row `groupAccessEvents` marked as a listing. Newest member first. */
  row: EventRow;
  /** This is the decision the chat is currently showing. Outlined, not tinted. */
  correlated?: boolean;
}) {
  const facts = listingFacts(row);
  const newest = row.event;
  // A listing is not one outcome, so the card takes the louder of the two it
  // contains — the same direction `accessAuditRows` takes when its summary row
  // stands for a mix (`apps/hooks/src/access-audit.ts`). A listing that hid
  // something must not read green from across a room.
  const tint = facts.hidden.length > 0 || facts.summary?.decision === "deny" ? "deny" : "allow";

  return (
    <article
      className="cg-event cg-listing"
      data-decision={tint}
      data-listing="true"
      data-correlated={correlated ? "true" : "false"}
      data-event-id={newest.id}
    >
      <p className="cg-event-meta">
        <time className="cg-event-time" dateTime={newest.ts}>
          {timeOf(newest.ts)}
        </time>
        <span className="cg-event-count">{plural(facts.decisions, "decision", "decisions")}</span>
        <span className="cg-event-user">{facts.user_id}</span>
      </p>

      <p className="cg-tool">tools/list</p>

      <p className="cg-listing-tallies">
        <span className="cg-listing-tally" data-decision="allow">
          <span className="cg-glyph" aria-hidden="true">
            {DECISIONS.allow.glyph}
          </span>
          <span>{plural(facts.enabled.length, "tool enabled", "tools enabled")}</span>
        </span>
        <span className="cg-listing-tally" data-decision="deny">
          <span className="cg-glyph" aria-hidden="true">
            {DECISIONS.deny.glyph}
          </span>
          <span>{plural(facts.hidden.length, "tool hidden", "tools hidden")}</span>
        </span>
      </p>

      {facts.hidden.map((tool) => (
        <div className="cg-listing-hidden" key={tool.tool}>
          <p className="cg-listing-hidden-tool">{tool.tool}</p>
          {tool.rule_id !== null && <p className="cg-rule">{tool.rule_id}</p>}
          {/* Folded exactly as an ordinary card folds its reason (#158): the
              tool and the rule that hid it are the act-1 facts and stay on the
              face; the rule's own sentence about itself is one click away. */}
          {tool.reason !== "" && (
            <details className="cg-why">
              <summary>Why</summary>
              <p className="cg-reason">{tool.reason}</p>
            </details>
          )}
        </div>
      ))}

      {/* A listing that hid nothing says so. Silence here would look exactly
          like a rule that matched nothing, which is the failure this panel
          exists to make visible. */}
      {facts.hidden.length === 0 && (
        <p className="cg-listing-none">No tool was hidden from this person.</p>
      )}

      {/* The #107 summary row stands for every tool outside this control
          plane's catalogue. It is a member of this card rather than a card of
          its own, and it is shown in the hook's own words rather than as a
          tool called `*` — this card never paraphrases a count the hook
          reported.

          Folded on #158 for the reason every other reason on this panel is: it
          is five lines of prose, it was the tallest thing on the tallest card,
          and it is about the 8,000-odd tools this demo is not about. The
          summary names what is behind it without asserting a number of its
          own, so opening it is the only place a figure appears and the figure
          is still the hook's. */}
      {facts.summary !== null && (
        <details className="cg-why">
          <summary>The rest of the catalogue</summary>
          <p className="cg-listing-rest">{facts.summary.reason}</p>
        </details>
      )}

      {facts.enabled.length > 0 && (
        <details className="cg-event-members">
          <summary>{plural(facts.enabled.length, "tool enabled", "tools enabled")}</summary>
          <ul className="cg-event-ids">
            {facts.enabled.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </details>
      )}

      {/* The accounting, and the sentence explaining it, in one disclosure
          (#158). The FACT that this card stands for several decisions is on the
          face of the card, in the meta line, where it has been since #64 — what
          moved behind the click is the paragraph explaining why Arcade produced
          them, which is three lines of prose on a projector and was the tallest
          thing on the card. Open it and every member event id is still there,
          which is what makes "the audit log holds every one of them" checkable
          rather than asserted. */}
      <details className="cg-event-members">
        <summary>
          {plural(facts.decisions, "decision", "decisions")}, grouped for display
        </summary>

        <p className="cg-listing-note">
          One card, {plural(facts.decisions, "decision", "decisions")} recorded separately. Arcade
          asks <code>/access</code> more than once for one <code>tools/list</code>; the panel
          groups this person&rsquo;s answers, and the audit log still holds every one of them.
        </p>

        <ul className="cg-event-ids">
          {row.events.map((member: GovernanceEvent) => (
            <li key={member.id}>
              <time dateTime={member.ts}>{timeOf(member.ts)}</time> {member.id} {member.tool}{" "}
              {member.decision}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

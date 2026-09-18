/**
 * One decision, as a card.
 *
 * The card answers three questions in the order a presenter narrates them, and
 * each answer is a different *kind* of type so the order survives being seen
 * rather than read:
 *
 * 1. **Which tool call** — largest, first, monospace, because it is an
 *    identifier and identifiers are the only thing monospace is used for here.
 * 2. **What happened** — the decision, in the display face and its own colour,
 *    so it is visibly a different sort of thing from the identifier above it.
 * 3. **Which rule** — a chip in the chrome colour, which is reserved and never
 *    a decision, so it cannot read as a fourth outcome and cannot be confused
 *    with the tool name.
 *
 * Above all three, a quiet line carrying the time at the leading edge and the
 * user at the far end — two identifiers that need to be present and need not
 * compete.
 *
 * Nothing is behind a hover. The panel is watched from across a room by people
 * who cannot reach the trackpad, and half of them are looking at a photograph
 * of it.
 *
 * ## The fourth answer, and why it is folded (#158)
 *
 * `reason` is a whole sentence of rule-authored prose, and it is the line that
 * made these cards tall and — worse for a column of them — **different
 * heights**, so a lane read as a ragged stack rather than as a list. It is now
 * a `<details>` labelled *Why*, closed by default.
 *
 * That is a fold, not a hover and not a truncation, and the difference is the
 * whole of it: the text is in the markup in full, `<summary>` is a button every
 * browser puts in the tab order and opens on Enter or Space, and the three
 * things the audience is asked to believe — which tool, what happened, which
 * rule — are still on the face of the card where they always were. The only
 * claim that moved behind a click is the rule's own explanation of itself,
 * which is read by the presenter narrating it rather than from the back of the
 * room. A `/post` redaction's diff does **not** fold: the mask is the evidence
 * for act 3 and evidence that has to be opened is evidence nobody saw.
 *
 * One card can stand for several decisions. `/access` fans out — one
 * `tools/call` produced three access decisions for one tool when it was
 * measured (#64) — so the access lane hands this a whole run of them. The
 * count is stated in words on the face of the card, where the rest of the
 * panel's claims are; only the individual event ids sit behind a disclosure,
 * because a column of opaque identifiers at projector distance is noise and
 * the one person who wants them is holding the trackpad.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

import { DECISIONS } from "./decisions.ts";
import { diffRowsFor } from "../../lib/governance/diff.ts";
import { MaskedDiff } from "./MaskedDiff.tsx";

/** `16:04:31` — the wall clock a presenter can point at. UTC, as the event is. */
function timeOf(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  return at.toISOString().slice(11, 19);
}

export function EventCard({
  event,
  members = [],
  correlated = false,
}: {
  event: GovernanceEvent;
  /**
   * Every decision this card stands for, newest first, `event` among them.
   * Empty or a single entry means an ordinary one-decision card. See
   * `lib/governance/grouping.ts` for what is allowed to share a card.
   */
  members?: readonly GovernanceEvent[];
  /** This is the decision the chat is currently showing. Outlined, not tinted. */
  correlated?: boolean;
}) {
  const decision = DECISIONS[event.decision];
  // A `/post` redaction arrives as `redactions[]` and no payload at all (#16,
  // #101). Asking for the rows here rather than inside the component is what
  // stopped the card from passing two `undefined`s and drawing "unchanged" over
  // act 3.
  const rows = diffRowsFor(event);
  const showDiff = event.decision === "modify";
  const count = members.length;
  const grouped = count > 1;

  return (
    <article
      className="cg-event"
      data-decision={event.decision}
      data-correlated={correlated ? "true" : "false"}
      data-event-id={event.id}
    >
      <p className="cg-event-meta">
        <time className="cg-event-time" dateTime={event.ts}>
          {timeOf(event.ts)}
        </time>
        {grouped && <span className="cg-event-count">{count} decisions</span>}
        <span className="cg-event-user">{event.user_id}</span>
      </p>

      <p className="cg-tool">{event.tool}</p>

      <p className="cg-decision">
        <span className="cg-glyph" aria-hidden="true">
          {decision.glyph}
        </span>
        <span>{decision.label}</span>
      </p>

      {event.rule_id !== null && <p className="cg-rule">{event.rule_id}</p>}

      {event.reason !== "" && (
        <details className="cg-why">
          <summary>Why</summary>
          <p className="cg-reason">{event.reason}</p>
        </details>
      )}

      {showDiff && <MaskedDiff rows={rows} />}

      {grouped && (
        <details className="cg-event-members">
          <summary>{count} decisions, this tool and this person</summary>
          <ul className="cg-event-ids">
            {members.map((member) => (
              <li key={member.id}>
                <time dateTime={member.ts}>{timeOf(member.ts)}</time> {member.id}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

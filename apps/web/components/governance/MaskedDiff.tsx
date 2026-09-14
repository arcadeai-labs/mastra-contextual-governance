/**
 * What a `modify` changed, one row per leaf: the field, what it was, what it
 * became — stacked rather than set in two columns, because a lane is a third of
 * half a screen and two columns at that width wrap every value into an
 * unreadable ribbon.
 *
 * Handed rows rather than payloads, because a `/post` event carries
 * `redactions[]` and nothing else — `before` and `after` are not fields a
 * `GovernanceEvent` has (#16, #101). `lib/governance/diff.ts` turns the records
 * into rows; this component only draws.
 *
 * Every `before` here is a mask, and this component cannot print a removed
 * value because it is never handed one. The mask is drawn on a hatched field
 * with the word *withheld* in it: a design review found that the previous row
 * of dots read, at projector distance, as a value in a masked font rather than
 * as the absence of one. The visual language is something struck out of a
 * document, which is what happened to it.
 *
 * **No rows means no change, and only then.** The placeholder below is a claim
 * about the control plane — that it looked and took nothing — so it must never
 * stand in for an event whose account of itself this component failed to read.
 * That is exactly what it did before #16's review: a redaction event carries no
 * payload, the diff of two absent payloads is empty, and act 3 rendered as "the
 * payload came back unchanged".
 */
import type { DiffRow } from "../../lib/governance/diff.ts";

export function MaskedDiff({ rows }: { rows: readonly DiffRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="cg-diff">
        <p className="cg-diff-empty">The payload came back unchanged.</p>
      </div>
    );
  }

  return (
    <div className="cg-diff">
      {rows.map((row) => (
        <div className="cg-diff-row" key={row.path}>
          <p className="cg-diff-path">{row.path === "" ? "(whole payload)" : row.path}</p>

          <div className="cg-diff-pair">
            <span className="cg-diff-label">before</span>
            <span className="cg-diff-value" data-side="before">
              {row.before === null ? (
                <span className="cg-diff-absent">not present</span>
              ) : (
                <span className="cg-mask">{row.before}</span>
              )}
            </span>

            <span className="cg-diff-label">after</span>
            <span className="cg-diff-value" data-side="after">
              {row.after === null ? (
                <span className="cg-diff-absent">removed entirely</span>
              ) : (
                row.after
              )}
            </span>
          </div>

          {/* Which rule took this leaf, and which pattern found it. Present on
              rows built from `redactions[]`; absent on a payload diff, where
              nothing on the event attributes a leaf to a rule. */}
          {row.annotation !== null && <p className="cg-diff-rule">{row.annotation}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * The before/after diff for a `modify`.
 *
 * Three parts per changed leaf — the field, what it was, what it became —
 * stacked rather than set in two columns, because a lane is a third of half a
 * screen and two columns at that width wrap every value into an unreadable
 * ribbon.
 *
 * Every `before` here is a mask produced by `maskedDiff()`, and this component
 * cannot print a removed value because it is never handed one. The mask is
 * drawn on a hatched field with the word *withheld* in it: a design review
 * found that the previous row of dots read, at projector distance, as a value
 * in a masked font rather than as the absence of one. The visual language is
 * something struck out of a document, which is what happened to it.
 */
import { maskedDiff } from "../../lib/governance/diff.ts";

export function MaskedDiff({ before, after }: { before: unknown; after: unknown }) {
  const rows = maskedDiff(before, after);

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

          {/* The rule_id / pattern_id naming why this leaf changed. The event
              has carried `redactions[]` since #16, but nothing reads it into
              `DiffRow` yet — that is #21 — so this is absent today. */}
          {row.annotation !== null && <p className="cg-diff-path">{row.annotation}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * Where #15's tool list goes.
 *
 * #15 is building the visible tool surface for the signed-in persona, sourced
 * from the gateway's own `tools/list` — the widget act 1 turns on, where
 * `Loan_ApproveLoan` is *absent* for Sam rather than present and refused. That
 * is its slice and this file does not build a version of it: a second tool list,
 * filtered client-side, is exactly the "control that silently does nothing" this
 * project is organised against, because a list that merely hides a tool looks
 * identical to a list the access hook shortened.
 *
 * So this is a hole with a name on it. Pass `children` and they are framed by
 * the left half's chrome; pass none and the region draws itself as an outline
 * that says what is missing. Drawn rather than hidden, because an empty region a
 * reviewer can see is how the next slice finds where its widget goes, and how
 * anybody watching can tell "not built yet" from "the persona can see nothing".
 */
import type { ReactNode } from "react";

/** The attribute #15 can grep for, and `test/split-screen.test.tsx` asserts on. */
export const TOOL_LIST_SLOT = "tool-list";

export function ToolListSlot({ children }: { children?: ReactNode }) {
  return (
    <section className="bank-panel" data-slot={TOOL_LIST_SLOT} aria-label="Actions available">
      <h2 className="bank-panel-title">Actions available to this user</h2>
      <div className="bank-panel-body">
        {children ?? (
          <p className="bank-slot">
            The tool list is not on this deployment yet. It is sourced from the gateway for the
            signed-in person and lands with #15; until then this region is empty rather than short.
          </p>
        )}
      </div>
    </section>
  );
}

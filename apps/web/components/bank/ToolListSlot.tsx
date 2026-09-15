/**
 * Where #15's tool list goes — and, since #15 landed, where it is.
 *
 * #15 built the visible tool surface for the signed-in persona, sourced from the
 * gateway's own `tools/list`: the widget act 1 turns on, where
 * `Loan_ApproveLoan` is *absent* for Bob rather than present-and-refused. This
 * file does not build a version of it and never did. A second tool list,
 * filtered in the browser, is exactly the "control that silently does nothing"
 * this project is organised against — it would render the same pixels while
 * proving the opposite thing.
 *
 * So this is a hole with a name on it, and `app/page.tsx` fills it with
 * `PersonaToolList`. Pass `children` and they are framed by the left half's
 * chrome; pass none and the region draws itself as an outline that says what is
 * missing. Drawn rather than hidden, because an empty region a reviewer can see
 * is how anybody watching can tell "nothing was supplied" from "the persona can
 * see nothing".
 *
 * What arrives keeps its own card. `--line` and `--muted` reach it from `.bank`
 * so it is drawn in the left half's colours, but its frame is set inline and
 * flattening that would mean `!important` against another slice's component —
 * a nested box is the smaller price. `bank.css` says so where the rule would
 * have gone.
 */
import type { ReactNode } from "react";

/** The attribute #15 can grep for, and `test/split-screen.test.tsx` asserts on. */
export const TOOL_LIST_SLOT = "tool-list";

export function ToolListSlot({ children }: { children?: ReactNode }) {
  return (
    <section className="bank-panel" data-slot={TOOL_LIST_SLOT} aria-label="User access">
      <h2 className="bank-panel-title">User access</h2>
      <div className="bank-panel-body">
        {children === undefined || children === null ? (
          <p className="bank-slot">
            No tool list was supplied to this shell. This region shows what the signed-in person is
            permitted to use, answered upstream rather than assembled here; rendered without one it
            stays empty rather than short.
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

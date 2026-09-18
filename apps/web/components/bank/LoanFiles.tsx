"use client";

/**
 * The two applications under review, beside the chat.
 *
 * Read from `GET /api/loans` — the bank's own API, over HTTP, as the person
 * signed in on this browser — and polled, so an approval the agent makes in the
 * conversation shows on the card next to it within one interval and nobody has
 * to reload anything. `lib/loan-context/loans.ts` has the argument for reading
 * it directly rather than through the gateway (#157), and
 * `components/bank/use-loan-book.ts` has the polling.
 *
 * **Nothing here is a governance surface.** No hook runs on this path, so this
 * component has no `denied` state and must never grow one: the words it can put
 * on screen are the loan book's own, a request to sign in again, and an
 * admission that the loan book did not answer.
 */
import { DEMO_LOAN_IDS, type LoanBookState } from "../../lib/loan-context/loans.ts";
import { LoanFileCard } from "./LoanFileCard.tsx";
import { useLoanBook } from "./use-loan-book.ts";

/**
 * Where a reader with no usable sign-in is sent.
 *
 * Written out rather than imported from `lib/identity/handlers.ts`, which is a
 * server module: importing it into this component drags the OIDC client and the
 * sealing code into the browser bundle — `BankPane` is `"use client"`, so
 * everything under it is client code. The cost of a duplicated literal is
 * drift, so `test/split-screen.test.tsx` reads the other file and fails if the
 * two ever disagree.
 */
const SIGN_IN = { href: "/api/auth/signin", label: "Sign in" } as const;

export function LoanFilesView({ initial }: { initial: LoanBookState }) {
  const state = useLoanBook(initial);

  return (
    <section className="bank-panel" aria-label="Applications under review">
      <h2 className="bank-panel-title">Applications under review</h2>
      <div className="bank-panel-body">
        {state.status === "loaded" ? (
          <>
            <div className="bank-files">
              {shown(state).map((loan) => (
                <LoanFileCard key={loan.loan_id} loan={loan} />
              ))}
            </div>
            {/* Who the screen is reading as. The same question the panel
                opposite answers about every decision, asked here about this
                screen — and the reason the two can be pointed at together. */}
            <p className="bank-quiet" style={{ marginTop: "0.5em" }}>
              Retrieved as <code>{state.actor}</code>.
            </p>
          </>
        ) : (
          <LoanBookProblem state={state} />
        )}
      </div>
    </section>
  );
}

/**
 * The two applications the demo is about, in the order `DESIGN.md` names them,
 * and only those.
 *
 * The route answers with the whole book because `/loans` shows the whole book;
 * this column is the pair beside the chat. An id the book does not hold is
 * simply absent rather than drawn as an empty card.
 */
function shown(state: Extract<LoanBookState, { status: "loaded" }>) {
  return DEMO_LOAN_IDS.map((id) => state.loans.find((loan) => loan.loan_id === id)).filter(
    (loan): loan is NonNullable<typeof loan> => loan !== undefined,
  );
}

/**
 * The read did not produce a book, and why.
 *
 * Two different claims, kept apart in words: a sign-in to do again, and a loan
 * book that did not answer. Neither is a policy decision and both say so,
 * because this screen sits next to one that shows real ones.
 */
export function LoanBookProblem({
  state,
}: {
  state: Exclude<LoanBookState, { status: "loaded" }>;
}) {
  const signIn = state.status !== "unavailable";

  return (
    <div role="status" data-loan-book={state.status}>
      <p className="bank-file-note">{state.message}</p>
      {signIn ? (
        <p className="bank-file-note">
          <a href={SIGN_IN.href}>{SIGN_IN.label}</a>.
        </p>
      ) : (
        <p className="bank-quiet">
          No policy decision was made and nothing was recorded. This is a failure in the plumbing,
          not a refusal.
        </p>
      )}
    </div>
  );
}

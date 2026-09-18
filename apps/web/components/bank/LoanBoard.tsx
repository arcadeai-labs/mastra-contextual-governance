"use client";

/**
 * `/loans` — the loan book, full-screen, for the presenter's second display.
 *
 * The whole book as large cards, auto-updating on the same route and the same
 * interval as the two cards beside the chat (`use-loan-book.ts`). When the
 * agent approves LN-2291, or Charlie approves it from the approval page, the
 * card turns over here while the room is still looking at it — which is the
 * beat the 2026-09-18 rehearsal found missing: the audience heard that a loan
 * had been approved and never saw it happen.
 *
 * ## It is the bank's screen, not ours
 *
 * Same chrome, same square corners, same stylesheet as the rest of
 * `components/bank`. No `cg-` class name, no import from
 * `components/governance`, nothing about policy, hooks or Arcade anywhere on
 * it, and `test/split-screen.test.tsx` fails if any of that stops holding. The
 * board is deliberately **off** the control plane (`DESIGN.md` → Design, #157):
 * a presenter switches to it to show the business outcome, and switches to
 * `/panel` to show the controls.
 *
 * ## Big, because of where it is read from
 *
 * Sized for the back of the room at 1920×1080 rather than for a laptop. The
 * three things a room has to be able to read are the status, the amount and who
 * decided; everything else on the card is supporting detail.
 */
import { type LoanBookState } from "../../lib/loan-context/loans.ts";
import { dollars, statusKey, text, timestamp } from "./format.ts";
import { LoanBookProblem } from "./LoanFiles.tsx";
import { useLoanBook } from "./use-loan-book.ts";
import "./bank.css";

export function LoanBoard({
  initial,
  signedInAs,
}: {
  initial: LoanBookState;
  signedInAs: string | null;
}) {
  const state = useLoanBook(initial);

  return (
    <div className="bank bank-board">
      <header className="bank-chrome">
        <p className="bank-chrome-name">Loan Origination System</p>
        <span className="bank-chrome-division">Commercial Lending Division</span>
        <span className="bank-chrome-release">Rel. 7.2.1</span>
      </header>

      <div className="bank-board-head">
        <h1 className="bank-board-title">Decision board</h1>
        {/* Who the board is reading as. Every screen in this demo says who it
            is acting as, and this one is on a projector on its own. */}
        <p className="bank-board-actor">
          <span className="bank-field-label">Signed in as</span>{" "}
          <span className="bank-user-value" data-signed-in={signedInAs !== null}>
            {signedInAs ?? "no user"}
          </span>
        </p>
      </div>

      {state.status === "loaded" ? (
        <div className="bank-board-grid" data-loans={state.loans.length}>
          {state.loans.map((loan) => (
            <article
              key={loan.loan_id}
              className="bank-board-card"
              data-loan={loan.loan_id}
              data-status={statusKey(loan.status)}
            >
              <header className="bank-board-card-head">
                <span className="bank-board-card-id">{loan.loan_id}</span>
                <span className="bank-status" data-status={statusKey(loan.status)}>
                  {text(loan.status)}
                </span>
              </header>

              <h2 className="bank-board-card-borrower">{text(loan.borrower_name)}</h2>
              <p className="bank-board-card-amount">{dollars(loan.amount)}</p>
              <p className="bank-board-card-purpose">{text(loan.purpose)}</p>

              <p className="bank-board-card-decision" data-decision={loan.decided_at === null ? "none" : "decided"}>
                {loan.decided_at === null && loan.decided_by === null ? (
                  "Awaiting a decision"
                ) : (
                  <>
                    <span className="bank-board-card-decision-status">{text(loan.status)}</span>
                    {loan.decided_by === null ? null : (
                      <>
                        {" · "}
                        <span className="bank-board-card-decision-by" title={loan.decided_by}>
                          {loan.decided_by_name ?? loan.decided_by}
                        </span>
                      </>
                    )}
                    {loan.decided_at === null ? null : (
                      <>
                        {" · "}
                        <span className="bank-board-card-decision-at">{timestamp(loan.decided_at)}</span>
                      </>
                    )}
                  </>
                )}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <div className="bank-board-problem">
          <LoanBookProblem state={state} />
        </div>
      )}
    </div>
  );
}

/**
 * One loan application, as the bank's own screen shows it.
 *
 * A pure function of one {@link LoanCard}, so everything worth asserting about
 * it — that the decision line names who decided and when, that no borrower's
 * account number is on the page — is checkable without a socket or a browser.
 *
 * ## What it does not show
 *
 * `bank_account_number`, `tax_id` and `underwriter_notes`. The first two are
 * act 3's subject and the third is act 4's; the chat and the panel are where
 * the audience watches them being redacted and stripped, and there is no reason
 * for a projector to carry a borrower's account number for forty minutes. They
 * are absent because `GET /api/loans` never sends them — an allow-list in
 * `lib/loan-context/read.ts`, not a field this component declines to render.
 *
 * ## The decision line
 *
 * The one thing on this card that moves during the demo. `approved · Charlie ·
 * <time>` the moment the approval lands in the loan book, wherever it was made:
 * by the agent through the gateway, or by Charlie on the approval page. Since
 * #155 the control plane is a page away rather than a pane away, so this line
 * is what the room watches instead — the business effect, on the business
 * system's own screen. It says who, because "approved" with nobody's name on it
 * is the claim this whole project exists to refuse.
 */
import type { LoanCard } from "../../lib/loan-context/loans.ts";
import { count, dollars, statusKey, text, timestamp } from "./format.ts";

export function LoanFileCard({ loan }: { loan: LoanCard }) {
  return (
    <article className="bank-file" data-outcome="read" data-loan={loan.loan_id}>
      <header className="bank-file-head">
        <span className="bank-file-id">{loan.loan_id}</span>
        <span className="bank-status" data-status={statusKey(loan.status)}>
          {text(loan.status)}
        </span>
      </header>

      <h3 className="bank-file-borrower">{text(loan.borrower_name)}</h3>
      <p className="bank-file-amount">{dollars(loan.amount)}</p>
      <p className="bank-file-purpose">{text(loan.purpose)}</p>

      <div className="bank-fields">
        <Field label="Submitted" value={text(loan.submitted_at)} />
        <Field label="Credit score" value={count(loan.credit_score)} />
        <Field label="Annual revenue" value={dollars(loan.annual_revenue)} />
        <Field label="Years trading" value={count(loan.years_in_business)} />
      </div>

      <LoanDecision loan={loan} />
    </article>
  );
}

/**
 * What the loan book records about the decision that stands, or plainly that
 * there is none.
 *
 * A pending application says so rather than leaving the line off: a card whose
 * decision line is simply missing is indistinguishable from one whose decision
 * failed to load, and this card updates every two seconds in front of a room.
 */
export function LoanDecision({ loan }: { loan: LoanCard }) {
  if (loan.decided_at === null && loan.decided_by === null) {
    return (
      <p className="bank-file-decision" data-decision="none">
        Awaiting a decision.
      </p>
    );
  }

  return (
    <p className="bank-file-decision" data-decision={statusKey(loan.status) ?? "decided"}>
      <span className="bank-file-decision-status">{text(loan.status)}</span>
      {loan.decided_by === null ? null : (
        <>
          <span className="bank-file-decision-sep"> · </span>
          <span className="bank-file-decision-by" title={loan.decided_by}>
            {loan.decided_by_name ?? loan.decided_by}
          </span>
        </>
      )}
      {loan.decided_at === null ? null : (
        <>
          <span className="bank-file-decision-sep"> · </span>
          <span className="bank-file-decision-at">{timestamp(loan.decided_at)}</span>
        </>
      )}
    </p>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bank-field">
      <span className="bank-field-label">{label}</span>
      <span className="bank-field-value">{value}</span>
    </div>
  );
}

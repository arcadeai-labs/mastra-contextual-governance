/**
 * One loan application, as the bank's own screen shows it.
 *
 * A pure function of one {@link LoanRead}, so everything worth asserting about
 * it — that a denial says which rule refused and does not read as a crash, that
 * a fault says nothing was decided, that no borrower's account number is on the
 * page — is checkable without a socket or a browser.
 *
 * ## The four outcomes stay four
 *
 * The read either produced a file or it did not, and *why* it did not is three
 * different claims about the world (`lib/loan-context/loans.ts`). This card
 * keeps them apart in words as well as in colour:
 *
 * - **read** — the file.
 * - **denied** — the control plane refused this person this read. The rule's own
 *   sentence, verbatim, `[ref evt_…]` and all, because the panel on the right
 *   joins on that token.
 * - **authorization** — a credential is missing. No hook fired, no audit row
 *   exists, and the card offers the link rather than claiming a refusal.
 * - **fault** — the plumbing. Nothing decided anything, and the card says so.
 *
 * ## What it does not show
 *
 * `bank_account_number` and `tax_id` come back on the tool's result and are not
 * rendered here. They are act 3's subject, the chat and the panel are where the
 * audience watches them being redacted, and there is no reason for a projector
 * to carry a borrower's account number for forty minutes.
 */
import type { LoanRead } from "../../lib/loan-context/loans.ts";
import { count, dollars, statusKey, text } from "./format.ts";

export function LoanFileCard({ read }: { read: LoanRead }) {
  if (read.outcome === "read") {
    const loan = read.loan;
    return (
      <article className="bank-file" data-outcome="read">
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

        {loan.underwriter_notes === undefined ? null : (
          <div className="bank-notes">
            <span className="bank-field-label">Underwriter notes</span>
            <p className="bank-notes-body">{loan.underwriter_notes}</p>
          </div>
        )}
      </article>
    );
  }

  return (
    <article className="bank-file" data-outcome={read.outcome}>
      <header className="bank-file-head">
        <span className="bank-file-id">{read.loan_id}</span>
        <span className="bank-status">{HEADINGS[read.outcome]}</span>
      </header>

      {read.outcome === "denied" ? (
        <>
          {/* Verbatim. The rule author wrote this sentence and the panel joins
              on the token at the end of it. */}
          <p className="bank-file-note">{read.reason}</p>
          <p className="bank-quiet">
            The control plane refused this read and recorded it
            {read.ref === null ? null : (
              <>
                {" as "}
                <code>{read.ref}</code>
              </>
            )}
            {" in the audit log."}
          </p>
        </>
      ) : null}

      {read.outcome === "authorization" ? (
        <>
          <p className="bank-file-note">
            <a href={read.url} target="_blank" rel="noreferrer">
              Authorize access to the loan book
            </a>
            , then reload.
          </p>
          <p className="bank-quiet">
            Nothing was refused: this browser holds no credential for the loan book yet, so no policy
            decision was made and nothing was recorded.
          </p>
        </>
      ) : null}

      {read.outcome === "fault" ? (
        <>
          <p className="bank-file-note">{read.message}</p>
          <p className="bank-quiet">
            No policy decision was made and nothing was recorded. This is a failure in the plumbing,
            not a refusal.
          </p>
        </>
      ) : null}
    </article>
  );
}

/**
 * The word in the status box when there is no file.
 *
 * `Denied` here is about the **read**, not about the application — the loan is
 * still pending. Round-tripping that distinction through one word is why the
 * sentence underneath always says who refused what.
 */
const HEADINGS = {
  denied: "Read refused",
  authorization: "Not authorized",
  fault: "Unavailable",
} as const;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bank-field">
      <span className="bank-field-label">{label}</span>
      <span className="bank-field-value">{value}</span>
    </div>
  );
}

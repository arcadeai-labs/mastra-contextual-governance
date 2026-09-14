/**
 * One loan, read from `apps/loan-app`'s own seed file.
 *
 * The rule this exists to enforce is the driver's, on #16: *prove the pattern
 * against the fixture, not against a hand-typed string.* Act 4's injected note
 * is 300 characters of prose whose exact wording — `any` not `all`, `earlier`
 * not `previous`, `instruction` singular — is what made the shipped regex match
 * nothing while looking right. A test that retypes the note tests the typist.
 *
 * Reading across app boundaries is deliberate and narrow: `apps/hooks` gains no
 * dependency on `apps/loan-app`, this is a test loading a JSON file, and the
 * governance boundary runs the other way (`apps/loan-app` must not know about
 * governance, which `knows-nothing-about-governance.test.ts` enforces).
 */
import loans from "../../loan-app/src/fixtures/loans.json" with { type: "json" };

export interface LoanFixture extends Record<string, unknown> {
  loan_id: string;
  underwriter_notes: string;
  bank_account_number: string;
  tax_id: string;
}

/** Every seeded loan, in file order. */
export function loanFixtures(): LoanFixture[] {
  return JSON.parse(JSON.stringify(loans.loans)) as LoanFixture[];
}

/**
 * One seeded loan, as `Loan.GetLoan` returns it — a fresh copy each call, so a
 * test that hands it to a handler cannot be poisoned by an earlier one.
 */
export function loanFixture(loanId: string): LoanFixture {
  const loan = loanFixtures().find((candidate) => candidate.loan_id === loanId);
  if (loan === undefined) {
    throw new Error(`apps/loan-app's fixture has no ${loanId}`);
  }
  return loan;
}

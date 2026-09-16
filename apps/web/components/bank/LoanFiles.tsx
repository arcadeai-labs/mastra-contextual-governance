"use client";

/**
 * The applications under review, read through the governed path.
 *
 * The initial render is a pure function of what the read produced, so every
 * property worth asserting is checkable without a socket. The component also
 * accepts the explicit post-authorization refresh from the split-screen shell:
 * the shell uses Next's router.refresh(), while the reads still happen
 * server-side through the gateway.
 *
 * **The files are still read through the gateway.** Two real governed tool
 * calls as the signed-in person — `Loan_GetLoan`, through `/access`, the auth
 * requirement and `/pre` — and two rows appear on the panel opposite before the
 * presenter has said anything. That is the honest price of a left half that
 * reads the bank's system of record the same way the agent does; the
 * alternative is a second, ungoverned path into the same data sitting inches
 * from a panel claiming there is only one. `lib/loan-context/read.ts` has the
 * full argument. A normal page load remains one `tools/list`; a Continue action
 * starts one separate, fresh page attempt.
 */
import { useContext, useEffect, useState } from "react";

import { HomeRefreshContext } from "../shell/HomeRefreshBoundary.tsx";
import type { LoanContextRefusal, LoanFilesState } from "../../lib/loan-context/loans.ts";
import { LoanFileCard } from "./LoanFileCard.tsx";

/**
 * Where a refusal sends the reader.
 *
 * The two paths are written out rather than imported from
 * `lib/identity/handlers.ts`, which is a server module: importing it into this
 * component drags the OIDC client and the sealing code into the browser bundle
 * — `BankPane` is `"use client"`, so everything under it is client code — which
 * is the failure `lib/agent/events.ts` records for `CHAT_PATH`. The cost of a
 * duplicated literal is drift, so `test/split-screen.test.tsx` reads the other
 * file and fails if the two ever disagree — the same bargain `lib/config.ts`
 * strikes with `DEV_STORE_TOKEN`.
 */
const WAYS_IN = {
  signin: { href: "/api/auth/signin", label: "Sign in" },
  gateway: { href: "/api/arcade/start", label: "Authorize the loan book" },
} as const;

export function LoanFilesView({
  state,
  onContinueAuthorization,
}: {
  state: LoanFilesState;
  onContinueAuthorization?: () => void | Promise<void>;
}) {
  const [current, setCurrent] = useState(state);
  const [refreshing, setRefreshing] = useState(false);
  const routerRefresh = useContext(HomeRefreshContext);
  const refreshAction = onContinueAuthorization ?? routerRefresh;

  // A server navigation can deliver a newer initial state. Keep the explicit
  // client refresh local so Chat and its bounded history are not remounted.
  useEffect(() => setCurrent(state), [state]);

  async function continueAuthorization(): Promise<void> {
    if (refreshing || refreshAction === null || refreshAction === undefined) return;
    setRefreshing(true);
    try {
      await refreshAction();
    } catch (cause) {
      setCurrent({
        status: "refused",
        refusal: {
          error: `The loan files could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      });
    } finally {
      setRefreshing(false);
    }
  }

  const cardContinue = refreshing || refreshAction === null || refreshAction === undefined
    ? undefined
    : () => { void continueAuthorization(); };

  return (
    <section className="bank-panel" aria-label="Applications under review">
      <h2 className="bank-panel-title">Applications under review</h2>
      <div className="bank-panel-body">
        {current.status === "refused" ? <Refusal refusal={current.refusal} /> : null}

        {current.status === "loaded" ? (
          <>
            <div className="bank-files">
              {current.body.reads.map((read) => (
                <LoanFileCard
                  key={read.loan_id}
                  read={read}
                  {...(cardContinue === undefined ? {} : { onContinueAuthorization: cardContinue })}
                  refreshing={refreshing}
                />
              ))}
            </div>
            {/* Who the files were read as. The same question the panel opposite
                answers about every decision, asked here about this screen — and
                the reason the two can be pointed at together. */}
            <p className="bank-quiet" style={{ marginTop: "0.5em" }}>
              Retrieved as <code>{current.body.actor}</code>.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The read never happened.
 *
 * It says what is missing and, when there is somewhere to go, links to it — a
 * screen that leaves a presenter with no next move is the failure #84's review
 * found on the home page.
 */
function Refusal({ refusal }: { refusal: LoanContextRefusal }) {
  const way = refusal.action ? WAYS_IN[refusal.action] : undefined;
  const detail = Array.isArray(refusal.detail) ? refusal.detail : [];

  return (
    <div role="status">
      <p className="bank-file-note">{refusal.error}</p>
      {detail.length === 0 ? null : (
        <ul className="bank-quiet" style={{ margin: "0.3em 0 0", paddingLeft: "1.2em" }}>
          {detail.map((problem) => (
            <li key={String(problem)}>{String(problem)}</li>
          ))}
        </ul>
      )}
      {way === undefined ? null : (
        <p className="bank-file-note">
          <a href={way.href}>{way.label}</a>.
        </p>
      )}
    </div>
  );
}

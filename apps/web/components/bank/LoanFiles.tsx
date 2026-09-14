"use client";

/**
 * The applications under review, read through the governed path.
 *
 * Split in two the way `components/governance` is, and for the same reason:
 * {@link LoanFilesView} is a pure function of what the read produced, so every
 * property worth asserting is checkable without a socket, and this component
 * adds nothing to it but a `fetch` and a piece of state.
 *
 * **It calls `/api/loan-context`, which calls the gateway.** Opening this page
 * makes two real governed tool calls as the signed-in person — `Loan_GetLoan`,
 * through `/access`, the auth requirement and `/pre` — and two rows appear on
 * the panel opposite before the presenter has said anything. That is the
 * honest price of a left half that reads the bank's system of record the same
 * way the agent does; the alternative is a second, ungoverned path into the
 * same data sitting inches from a panel claiming there is only one.
 * `lib/loan-context/handlers.ts` has the full argument.
 */
import { useCallback, useEffect, useState } from "react";

import {
  LOAN_CONTEXT_PATH,
  type LoanContextBody,
  type LoanContextRefusal,
} from "../../lib/loan-context/loans.ts";
import { LoanFileCard } from "./LoanFileCard.tsx";

/**
 * Where a refusal sends the reader.
 *
 * The two paths are written out rather than imported from
 * `lib/identity/handlers.ts`, which is a server module: importing it into a
 * client component drags the OIDC client and the sealing code into the browser
 * bundle, which is the failure `lib/agent/events.ts` records for `CHAT_PATH`.
 * The cost of a duplicated literal is drift, so `test/split-screen.test.tsx`
 * reads the other file and fails if the two ever disagree — the same bargain
 * `lib/config.ts` strikes with `DEV_STORE_TOKEN`.
 */
const WAYS_IN = {
  signin: { href: "/api/auth/signin", label: "Sign in" },
  gateway: { href: "/api/arcade/start", label: "Authorize the loan book" },
} as const;

export type LoanFilesState =
  | { status: "loading" }
  | { status: "loaded"; body: LoanContextBody }
  | { status: "refused"; refusal: LoanContextRefusal };

export function LoanFiles() {
  const [state, setState] = useState<LoanFilesState>({ status: "loading" });

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const response = await fetch(LOAN_CONTEXT_PATH, { signal, cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | LoanContextBody
        | LoanContextRefusal
        | null;
      if (signal.aborted) return;
      if (response.ok && body !== null && "reads" in body) {
        setState({ status: "loaded", body });
        return;
      }
      setState({
        status: "refused",
        refusal: (body as LoanContextRefusal | null) ?? {
          error: `The loan book answered ${response.status}.`,
        },
      });
    } catch (cause) {
      if (signal.aborted) return;
      setState({
        status: "refused",
        refusal: { error: cause instanceof Error ? cause.message : String(cause) },
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return <LoanFilesView state={state} />;
}

export function LoanFilesView({ state }: { state: LoanFilesState }) {
  return (
    <section className="bank-panel" aria-label="Applications under review">
      <h2 className="bank-panel-title">Applications under review</h2>
      <div className="bank-panel-body">
        {state.status === "loading" ? <p className="bank-quiet">Retrieving files…</p> : null}

        {state.status === "refused" ? <Refusal refusal={state.refusal} /> : null}

        {state.status === "loaded" ? (
          <>
            <div className="bank-files">
              {state.body.reads.map((read) => (
                <LoanFileCard key={read.loan_id} read={read} />
              ))}
            </div>
            {/* Who the files were read as. The same question the panel opposite
                answers about every decision, asked here about this screen — and
                the reason the two can be pointed at together. */}
            <p className="bank-quiet" style={{ marginTop: "0.5em" }}>
              Retrieved as <code>{state.body.actor}</code>.
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
 * Never worded as a refusal by the control plane: nothing here got as far as a
 * hook. It says what is missing and, when there is somewhere to go, links to it
 * — a screen that leaves a presenter with no next move is the failure #84's
 * review found on the home page.
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

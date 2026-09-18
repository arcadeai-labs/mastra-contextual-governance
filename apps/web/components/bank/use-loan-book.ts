"use client";

/**
 * The loan book, kept current.
 *
 * One hook, two surfaces: the cards beside the chat on `/` and the board on
 * `/loans`. They poll the same route at the same interval, so an approval — by
 * the agent in the chat, or by Charlie on the approval page — reaches both
 * screens on the same tick and neither can be showing an older book than the
 * other.
 *
 * ## Why polling and not a stream
 *
 * `apps/loan-app` is the bank's system of record and it stays ignorant: no SSE,
 * no subscriptions, no idea anything is watching (`DESIGN.md` → Business
 * system, and `knows-nothing-about-governance.test.ts` is what keeps it that
 * way). A demo loan book answering nine cheap reads every two seconds is not a
 * scaling problem; a business API growing a push channel for our UI would be a
 * change to the thing being governed.
 *
 * ## The first paint is the server's
 *
 * `initial` comes from the server component, which read the book with the same
 * cookie. So the cards are correct before any JavaScript runs, and the polling
 * only keeps them that way.
 *
 * ## One request in flight
 *
 * A chained `setTimeout` rather than `setInterval`: a slow answer must not let
 * a second request start behind it, and an interval that fires faster than the
 * loan book answers turns one screen into a queue.
 */
import { useEffect, useRef, useState } from "react";

import { asLoanBookState, LOAN_POLL_INTERVAL_MS, LOANS_ROUTE, type LoanBookState } from "../../lib/loan-context/loans.ts";

export function useLoanBook(initial: LoanBookState): LoanBookState {
  const [state, setState] = useState<LoanBookState>(initial);
  // A server navigation can deliver a newer first paint; adopt it without
  // restarting the poll.
  const latest = useRef(initial);
  useEffect(() => {
    if (latest.current !== initial) {
      latest.current = initial;
      setState(initial);
    }
  }, [initial]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        const response = await fetch(LOANS_ROUTE, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const body = asLoanBookState(await response.json().catch(() => null));
        if (stopped) return;
        setState(
          body ?? {
            status: "unavailable",
            message: `The loan book route answered ${response.status} with something this screen could not read.`,
          },
        );
      } catch (cause) {
        // A poll that fails says so rather than freezing the last good answer
        // on screen: a card nobody can tell is stale is worse than a card that
        // admits it could not be refreshed.
        if (!stopped) {
          setState({
            status: "unavailable",
            message: `The loan book could not be reached: ${cause instanceof Error ? cause.message : String(cause)}.`,
          });
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), LOAN_POLL_INTERVAL_MS);
      }
    }

    timer = setTimeout(() => void tick(), LOAN_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return state;
}

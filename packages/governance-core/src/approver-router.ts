/**
 * ApproverRouter — minimum-sufficient-clearance routing (#9).
 *
 * Given a blocked call for `amount`, decide who is asked to approve it. The
 * model never makes this choice: the router is a pure, total function of its
 * inputs, so the same request always lands on the same desk and the audit
 * trail can say why.
 *
 * The rule, in words:
 *
 *   1. Drop the requester. Always — even when their own clearance would cover
 *      the amount. Separation of duties is not a function of authority level.
 *   2. Drop everyone whose clearance is below the amount. Clearance is a
 *      ceiling, so a clearance *equal* to the amount is sufficient (this
 *      mirrors `exceeds_clearance`, which denies only when input > clearance).
 *   3. Of those left, pick the lowest clearance. A $95K request with Charlie at
 *      $250K and Michael at $5M goes to Charlie; not bothering the chief credit
 *      officer for a mid-size decision is the point.
 *   4. Tie-break equal clearances by `user_id`, ascending, compared as plain
 *      code-unit strings (never locale-aware). Roster order is irrelevant.
 *
 * Having nobody eligible is an ordinary outcome, not an error and not a quiet
 * fallback to the highest authority: the caller gets a value it can branch on.
 *
 * Parity note for `tools/approvals` (#18), which reimplements this in Python:
 * `sorted(eligible, key=lambda s: (s.clearance, s.user_id))[0]` is equivalent
 * provided user ids are ASCII. JavaScript orders strings by UTF-16 code unit
 * and Python by code point; the two agree for everything in the Basic
 * Multilingual Plane, which covers every email address we will ever seed.
 * Python must also use `>=` for sufficiency and exclude the requester by
 * `user_id` equality before sorting.
 */
import type { Subject } from "@cg/policy-schema";

/** The routing decision. Discriminate on `outcome`. */
export type RoutingResult =
  | {
      outcome: "routed";
      /** The one person who will be asked. */
      approver: Subject;
      /**
       * Everyone who *could* have approved, lowest clearance first; the
       * approver is `candidates[0]`. Recorded so the panel can show who was
       * deliberately not bothered.
       */
      candidates: readonly Subject[];
      /** The bar a candidate had to clear: the amount itself. */
      required_clearance: number;
    }
  | {
      outcome: "no_eligible_approver";
      approver: null;
      /** Always empty here; present so both arms have the same shape. */
      candidates: readonly Subject[];
      required_clearance: number;
    };

/**
 * Route `amount` to the lowest sufficient approver in `roster`, excluding
 * `requesterId`.
 *
 * @param amount       The numeric input being escalated, in `Subject.clearance`'s
 *                     unit-free scale. Must be a finite, non-negative number.
 * @param requesterId  `Subject.user_id` of whoever made the blocked call.
 * @param roster       Every subject the control plane knows about. Not mutated.
 * @throws RangeError  when `amount` is negative, `NaN` or infinite. That is a
 *                     programming error upstream, not a routing outcome, and
 *                     must not be confused with "nobody can approve this".
 */
export function routeApproval(
  amount: number,
  requesterId: string,
  roster: readonly Subject[],
): RoutingResult {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(
      `routeApproval: amount must be a finite, non-negative number; got ${String(amount)}`,
    );
  }

  const candidates = roster
    .filter((subject) => subject.user_id !== requesterId)
    .filter((subject) => subject.clearance >= amount)
    .sort(compareByClearanceThenId);

  const approver = candidates[0];
  if (approver === undefined) {
    return {
      outcome: "no_eligible_approver",
      approver: null,
      candidates,
      required_clearance: amount,
    };
  }
  return { outcome: "routed", approver, candidates, required_clearance: amount };
}

/**
 * Lowest clearance first; equal clearances ordered by `user_id` as raw
 * code-unit strings. Deliberately not `localeCompare`: locale rules vary by
 * runtime and would make the choice depend on where the hook server happens
 * to be deployed.
 */
function compareByClearanceThenId(a: Subject, b: Subject): number {
  if (a.clearance !== b.clearance) return a.clearance - b.clearance;
  if (a.user_id < b.user_id) return -1;
  if (a.user_id > b.user_id) return 1;
  return 0;
}

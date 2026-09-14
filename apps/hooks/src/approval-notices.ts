/**
 * The second thing `GET /events` carries: an approval was decided.
 *
 * #20's resume half needs one signal, and the issue names it —
 * *"an `approval.granted` event goes down the same stream"*. Getting it there
 * without lying about what it is takes three decisions, all of them written
 * into this module's shape rather than into a comment somewhere downstream.
 *
 * **It is not an audit row.** `GovernanceEvent.hook` is `access|pre|post` and
 * `audit_log` enforces that; a decision recorded in the approvals store is not
 * a hook decision and carries no `execution_id`. #19's driver ruling settled
 * this explicitly — no `GovernanceEvent` on the store writes — and routing and
 * outcome still reach the panel the honest way, through the real `/pre` rows on
 * `Approvals.RequestApproval` and `Approvals.Decide`. So this rides the socket
 * under a **different SSE event name** and is written to nothing.
 *
 * **It carries no `id:` line.** `Last-Event-ID` on this endpoint is defined
 * over `audit_log` — the client sends back an `evt_…` or a seq, and the server
 * replays rows after it. A notice has no row and therefore no position, so
 * giving it an id would either invent one or hand the panel an anchor the log
 * cannot place. Per the SSE spec a frame with no `id:` leaves the client's last
 * event id untouched, which is exactly right: the governance replay is
 * unaffected, and the cost is that a notice is **live-only** — a browser that
 * is disconnected at the moment of the decision does not get it on reconnect.
 * That is a real gap and it is closed on the client side, which re-reads
 * `GET /approvals/{id}` when it reconnects rather than assuming the socket was
 * up (see `apps/web/lib/governance/approval-stream.ts`).
 *
 * **It is published strictly after the transaction commits.** Same seam as
 * `record()`'s, for a sharper reason: the transaction that records `approved`
 * is the one that turns the pre-hook's pending grant on. A notice published
 * before it would tell a browser to retry against a grant that is still
 * `pending` and therefore still refused — the precise interleaving round 1 of
 * #52's review found and fixed. `approvals-api.ts` publishes from after
 * `recordDecision` returns, and `test/approval-stream.test.ts` asserts the
 * ordering by reading the grant's state from inside the subscriber.
 *
 * What a notice is *for* is narrow: telling one browser that the approval its
 * agent asked for has been settled. It is a notification, never a source of
 * facts the agent is told — everything the resumed turn asserts is re-read
 * from `GET /approvals/{id}` on the server side of `apps/web`.
 */
import { createBus, type Bus } from "@cg/governance-core";
import type { ApprovalNotice } from "@cg/policy-schema";

export type { ApprovalNotice };

/** The fan-out for approval decisions. Separate registry, same implementation. */
export type ApprovalNoticeBus = Bus<ApprovalNotice>;

/** The SSE event name. `governance` is the other one, and the panel filters on it. */
export const APPROVAL_EVENT_NAME = "approval";

export function createApprovalNoticeBus(options: {
  onSubscriberError?: (cause: unknown) => void;
}): ApprovalNoticeBus {
  return createBus<ApprovalNotice>(options);
}

/**
 * One notice as a frame.
 *
 * No `id:` line — see the header. `JSON.stringify` escapes every CR and LF, so
 * a `data:` line is always one line and a note the approver typed cannot forge
 * a frame boundary.
 */
export function approvalFrame(notice: ApprovalNotice): string {
  return `event: ${APPROVAL_EVENT_NAME}\n` + `data: ${JSON.stringify(notice)}\n\n`;
}

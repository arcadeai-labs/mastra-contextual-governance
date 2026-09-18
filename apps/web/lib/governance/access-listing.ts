/**
 * One persona's `tools/list`, as a fixture.
 *
 * The shape `apps/hooks` writes for one listing, in the counts #107 settled:
 * one row per tool this control plane governs — six, both project toolkits —
 * plus one summary row (`tool: "*"`) standing for everything outside the
 * catalogue. On the deployed gateway a listing is answered by four `/access`
 * calls and the rows arrive as one burst; here they are one call's worth,
 * which is the same burst with less repetition and the same card.
 *
 * The persona is Sam, the credit analyst (`bob@bank.example` in the fixture
 * subjects), because act 1 is the only thing a listing card is *for*:
 * `Loan.ApproveLoan` is absent from what he can see, hidden by
 * `access.analysts-cannot-see-approve`, and the five tools he keeps are there
 * to prove the rule matched one thing rather than everything. A fixture where
 * nothing was hidden would exercise the card and demonstrate nothing.
 *
 * It sits beside `access-fanout.ts` rather than replacing it. The two are
 * different measured shapes — that one is a `tools/call` fan-out, this one is
 * a listing — and the panel must draw them differently: only this one may say
 * `tools/list` on its face. The fixture stream serves both behind `?fanout=1`,
 * far enough apart in time to be two bursts, so the difference is something a
 * presenter can watch rather than something a test asserts alone.
 */
import type { GovernanceEvent } from "@cg/policy-schema";
import { aGovernanceEvent, FIXTURE_EPOCH } from "@cg/policy-schema";

/** Sam, the credit analyst — the address `governance.json` seeds for him. */
const SAM = "bob@bank.example";

/** Act 1's rule, id and words as `apps/hooks/src/fixtures/governance.json` has them. */
const HIDES_APPROVE = {
  rule_id: "access.analysts-cannot-see-approve",
  reason: "Credit analysts do not hold approval authority; the tool is hidden from this role.",
} as const;

/**
 * How long after {@link FIXTURE_EPOCH} the listing starts.
 *
 * Well past `ACCESS_GROUP_WINDOW_MS` and past the fan-out that precedes it in
 * the stream, so the two never merge into one card however the replay is
 * paced. `?fanout=1` is also the only place two bursts are visible at once,
 * which is what makes "a gap wider than the window is two cards" watchable.
 */
const LISTING_OFFSET_MS = 10_000;

/** Milliseconds between two decisions of one listing. Sub-second, as measured. */
const APART_MS = 3;

/** The six tools both project toolkits advertise, in catalogue order. */
const GOVERNED: ReadonlyArray<{ tool: string; hidden: boolean }> = [
  { tool: "Loan.SearchLoans", hidden: false },
  { tool: "Loan.GetLoan", hidden: false },
  { tool: "Loan.ApproveLoan", hidden: true },
  { tool: "Loan.DenyLoan", hidden: false },
  { tool: "Approvals.RequestApproval", hidden: false },
  { tool: "Approvals.Decide", hidden: false },
];

/**
 * The summary row's reason, in the sentence `accessAuditRows` builds.
 *
 * The count is the deployed measurement: one `tools/list` produced 8,278
 * `/access` frames, six of them this project's tools and **8,272** denials of
 * everything else (`docs/spikes/05-custom-verifier.md`, quoted in
 * `apps/hooks/src/access-audit.ts`). So the card shows the order of magnitude
 * a real listing carries rather than a rounded stand-in.
 *
 * The builder also names the toolkits those 8,272 tools came from. That part
 * is left out here rather than invented: the live toolkit *count* was never
 * measured, and a fixture is not the place to put a number nobody has seen.
 */
const SUMMARY_REASON =
  "SUMMARY: 8272 tools outside this control plane's catalogue were decided in this call " +
  "and are recorded as this one row — 8272 hidden, 0 allowed. Tools in the governed " +
  "toolkits (Approvals, Loan) are recorded one row each, above.";

/**
 * Seven access events, oldest first: six governed tools decided for Sam, one
 * of them hidden, and the summary row that accounts for the rest of the
 * catalogue. Deterministic — no clock — so a panel test against it does not
 * fail at midnight.
 */
export function anAccessListing(): GovernanceEvent[] {
  const at = (tick: number): string =>
    new Date(Date.parse(FIXTURE_EPOCH) + LISTING_OFFSET_MS + tick * APART_MS).toISOString();

  const events: GovernanceEvent[] = GOVERNED.map((entry, index) =>
    aGovernanceEvent({
      id: `evt_listing_${entry.tool.replace(".", "_").toLowerCase()}`,
      ts: at(index),
      // `/access` decides a tool list, not an execution, so there is no
      // execution id to carry — the same as #5's own access event.
      execution_id: "",
      hook: "access",
      user_id: SAM,
      tool: entry.tool,
      decision: entry.hidden ? "deny" : "allow",
      reason: entry.hidden ? HIDES_APPROVE.reason : "No rule hides this tool from this person.",
      rule_id: entry.hidden ? HIDES_APPROVE.rule_id : null,
    }),
  );

  events.push(
    aGovernanceEvent({
      id: "evt_listing_summary",
      ts: at(GOVERNED.length),
      execution_id: "",
      hook: "access",
      user_id: SAM,
      tool: "*",
      decision: "deny",
      reason: SUMMARY_REASON,
      rule_id: null,
    }),
  );

  return events;
}

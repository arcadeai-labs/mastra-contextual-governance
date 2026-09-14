/**
 * How many audit rows one `/access` call is worth.
 *
 * `/access` is not asked about the tools the agent is about to use. It is
 * asked about **the whole Arcade project catalogue**, and the shape is two
 * measurements, not one:
 *
 * - **Four `/access` calls per `tools/list`** — one scoped to `Loan`, one
 *   enumerating every toolkit in the project, ~1.6 MB
 *   (`docs/spikes/02-remote-mcp-hooks.md`).
 * - **8,278 frames per `tools/list`, on the deployed gateway.** Six `allow` —
 *   this project's six tools — and 8,272 `deny`, every one carrying Dana's
 *   lowercase email (`docs/spikes/05-custom-verifier.md` §11.3, measured
 *   against `cg-demo-us` rather than a throwaway project).
 *
 * Those two divide: **8,278 frames across four calls is the per-*list* figure,
 * and this module works per *call*.** A summary row is written once per
 * `/access` call, so one listing is at most four of them.
 *
 * `handleAccess` used to append one row per tool named in the request, which
 * for the enumerating call is one row per catalogue entry. That is what #107
 * is: 413,832 rows on the Render disk with nothing looping —
 * `413,832 / 8,278 ≈ 50 listings`, which is about 25 loads of `/` and a few
 * turns. Every one of those rows past the sixth is about a tool this control
 * plane does not govern, has no rule for and will never be asked about again,
 * and each one is also an SSE frame down `GET /events`: a panel that says
 * DENIED 8,272 times per listing, before the presenter has said anything.
 *
 * ## Three ways to count, and why this is the third
 *
 * **A — one row per tool.** What was here: ~8,278 rows a listing. Complete,
 * and unusable — the signal is 0.07% of the table and the disk fills.
 *
 * **B — one row per `/access` call.** Four rows a listing. Cheap, and it
 * throws away the thing act 1 is: `access.analysts-cannot-see-approve` hiding
 * `Loan.ApproveLoan` from Sam has to be a row that *names that tool*, and the
 * `allow` rows for the tools it did not hide have to be there too — a rule
 * that matches nothing is otherwise indistinguishable from a rule that
 * permits, which is the failure this whole repo is organised against.
 *
 * **C — one row per tool this control plane governs, plus one summary row per
 * call for the remainder.** What this module does, and what the human chose on
 * #107. Every decision the policy actually made is on the record, per tool,
 * exactly as before. Everything else — the toolkits the catalogue does not
 * list, which `PolicyEngine` refuses wholesale as "not governed by this
 * control plane" — collapses into a **single row per call** that says how many
 * tools it stood for and what happened to them. On the live shape that is the
 * six governed tools plus at most four summary rows: **8,278 frames a listing
 * becomes about ten.** The collapse is stated on the record rather than done
 * quietly, which is the only version of it worth having.
 *
 * The summary row uses `tool: "*"`, the same spelling `server.ts`'s fail-closed
 * path already writes when it cannot read a payload well enough to name one.
 * No schema change, no wire change: `AccessHookResult` is built from the same
 * decisions and is byte-for-byte what it was.
 *
 * ## What decides "governed"
 *
 * The policy's own catalogue — the `catalogue` table, seeded from the fixture
 * with the `ARCADE_*_TOOLKIT` values and editable live on stage. Never a
 * toolkit name written down here. A toolkit that is added to the catalogue
 * starts being recorded per tool on the next poll, with nothing to redeploy.
 *
 * When the policy has not loaded — cold, or a hand-edited rule that no longer
 * compiles — there is no catalogue to partition on, and *that* is the state in
 * which the enumerating call would write thousands of fail-closed rows. So the
 * fallback is the configured toolkit names, which are the values the catalogue
 * is seeded from and therefore agree with it by construction. The demo's own
 * refusals stay per-tool in the one state where they matter most, and the
 * summary row carries the fail-closed reason with them — see `summaryReason`.
 */
import type { ToolRef } from "@cg/governance-core";
import type { Decision, GovernanceEvent } from "@cg/policy-schema";

/** One tool `/access` was asked about, and what the engine said about it. */
export interface DecidedTool {
  tool: ToolRef;
  decision: Decision;
}

/** Everything the row builder needs that is not a decision. */
export interface AccessAuditContext {
  /**
   * The toolkits recorded per tool. Everything outside this set is summarised.
   * Empty is legal and means every decision is summarised — see the header.
   */
  governed: ReadonlySet<string>;
  /** The `ts`, `execution_id`, `hook` and `user_id` every row in this call shares. */
  base: Pick<GovernanceEvent, "ts" | "execution_id" | "hook" | "user_id">;
  newId: () => string;
  /**
   * The reason builder to use for the summary row when the decisions it stands
   * for were **not** the policy's — the fail-closed paths, where every tool in
   * the call was refused because the control plane could not decide.
   *
   * Supplied by the caller, and it is the *same* builder that wrote the
   * per-tool rows, handed the group in the slot a tool name goes in. So a
   * fail-closed listing reads as fail-closed on every row it wrote, summary
   * included, and a reviewer scrolling `audit_log` can tell one from a normal
   * listing without joining anything.
   *
   * That is the correction round 1 of the review asked for. The summary used
   * to say only where the line between governed and catalogue was drawn, on
   * the argument that a row standing for 8,272 decisions should not assert a
   * cause it had not examined. The argument was right and the conclusion was
   * wrong: when *every* decision in the call was refused for one reason, that
   * reason is examined — it is the only one there is — and withholding it
   * makes a control plane that could not load its policy look, in the log,
   * exactly like one that was working.
   *
   * Left undefined on the ordinary path, where the summarised tools were
   * refused for being outside the catalogue and the per-tool rows beside them
   * carry the policy's own reasons.
   */
  summaryReason?: (what: string) => string;
}

/** The spelling a row uses when it stands for more than one tool. */
export const SUMMARY_TOOL = "*";

/**
 * How many toolkit names the summary row's reason lists before it stops.
 *
 * The reason is read on a panel card and in a terminal. A hundred toolkit
 * names is not a sentence anybody reads, and the count that precedes them is
 * the load-bearing part.
 */
const NAMED_TOOLKITS = 5;

/**
 * The audit rows for one `/access` call.
 *
 * Order is the order the decisions arrived, with the summary row last: a
 * reader scrolling the panel sees this call's real decisions first and the
 * line accounting for everything else underneath them.
 */
export function accessAuditRows(
  decided: readonly DecidedTool[],
  ctx: AccessAuditContext,
): GovernanceEvent[] {
  const rows: GovernanceEvent[] = [];
  const summarised: DecidedTool[] = [];

  for (const entry of decided) {
    if (ctx.governed.has(entry.tool.toolkit)) {
      rows.push({
        ...ctx.base,
        id: ctx.newId(),
        tool: `${entry.tool.toolkit}.${entry.tool.name}`,
        decision: entry.decision.effect,
        reason: entry.decision.reason,
        rule_id: entry.decision.rule_id,
      });
      continue;
    }
    summarised.push(entry);
  }

  if (summarised.length > 0) rows.push(summaryRow(summarised, ctx));
  return rows;
}

/**
 * One row standing for every tool outside the governed toolkits.
 *
 * `decision` is what actually happened to them rather than a constant: today
 * an uncatalogued toolkit is refused wholesale by `PolicyEngine`, so this is
 * `deny` — but a reader should be able to trust the field, and a future
 * catalogue that permits something outside itself must not be reported as a
 * refusal. Mixed outcomes report `deny`, which is the louder of the two, and
 * the reason carries both counts either way.
 */
function summaryRow(summarised: readonly DecidedTool[], ctx: AccessAuditContext): GovernanceEvent {
  const hidden = summarised.filter((entry) => entry.decision.effect === "deny").length;
  const allowed = summarised.length - hidden;
  const toolkits = [...new Set(summarised.map((entry) => entry.tool.toolkit))].sort();
  const named = toolkits.slice(0, NAMED_TOOLKITS).join(", ");
  const rest = toolkits.length - Math.min(toolkits.length, NAMED_TOOLKITS);
  const tools = `${summarised.length} tool${summarised.length === 1 ? "" : "s"}`;
  const inToolkits = `${toolkits.length} toolkit${toolkits.length === 1 ? "" : "s"}`;

  // On a fail-closed path, the caller's own reason comes first and the
  // accounting follows it. The row then carries the same `FAIL-CLOSED:` marker
  // the per-tool rows do, which is what lets `hook=access decision=deny` be
  // read as "the policy hid these" or "the control plane could not decide"
  // without a second query.
  const cause =
    ctx.summaryReason === undefined
      ? ""
      : `${ctx.summaryReason(`${tools} in ${inToolkits} outside the catalogue are hidden`)} `;

  return {
    ...ctx.base,
    id: ctx.newId(),
    tool: SUMMARY_TOOL,
    decision: hidden > 0 ? "deny" : "allow",
    reason:
      `${cause}SUMMARY: ${tools} in ${inToolkits} outside this control plane's ` +
      `catalogue were decided in this call and are recorded as this one row — ${hidden} hidden, ` +
      `${allowed} allowed. Toolkits: ${named}${rest > 0 ? `, and ${rest} more` : ""}. ` +
      `Tools in the governed toolkits (${governedList(ctx.governed)}) are recorded one row each, ` +
      `above.`,
    rule_id: null,
  };
}

function governedList(governed: ReadonlySet<string>): string {
  if (governed.size === 0) return "none — the control plane has no catalogue loaded";
  return [...governed].sort().join(", ");
}

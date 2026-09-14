/**
 * How many audit rows one `/access` call is worth.
 *
 * `/access` is not asked about the tools the agent is about to use. It is
 * asked about **the whole Arcade project catalogue**: spike #2 measured a
 * single `tools/list` producing four `/access` calls, one scoped to `Loan` and
 * one enumerating every toolkit in the project — *thousands of tools, ~1.6 MB*,
 * and 1,200 entries when the catalogue was counted
 * (`docs/spikes/02-remote-mcp-hooks.md`, and its transcript).
 *
 * `handleAccess` used to append one row per tool named in the request, which
 * for that call is one row per catalogue entry. That is what #107 is: 413,832
 * rows on the Render disk with nothing looping — roughly 345 listings at
 * ~1,200 rows each, which is a few days of ordinary use. Every one of those
 * rows past the sixth is about a tool this control plane does not govern, has
 * no rule for and will never be asked about again, and each one is also an SSE
 * frame down `GET /events`: a panel that says DENIED 1,194 times before the
 * presenter has said anything.
 *
 * ## Three ways to count, and why this is the third
 *
 * **A — one row per tool.** What was here. Complete, and unusable: the signal
 * is 0.5% of the table and the disk fills.
 *
 * **B — one row per `/access` call.** Four rows per listing. Cheap, and it
 * throws away the thing act 1 is: `access.analysts-cannot-see-approve` hiding
 * `Loan.ApproveLoan` from Sam has to be a row that *names that tool*, and the
 * `allow` rows for the tools it did not hide have to be there too — a rule
 * that matches nothing is otherwise indistinguishable from a rule that
 * permits, which is the failure this whole repo is organised against.
 *
 * **C — one row per tool this control plane governs, plus one summary row for
 * the remainder.** What this module does. Every decision the policy actually
 * made is on the record, per tool, exactly as before. Everything else — the
 * toolkits the catalogue does not list, which `PolicyEngine` refuses wholesale
 * as "not governed by this control plane" — collapses into a **single** row
 * that says how many tools it stood for and what happened to them. The
 * collapse is stated on the record rather than done quietly, which is the only
 * version of it worth having.
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
 * which a whole-catalogue call would write 1,200 fail-closed rows. So the
 * fallback is the configured toolkit names, which are the values the catalogue
 * is seeded from and therefore agree with it by construction. The demo's own
 * refusals stay per-tool in the one state where they matter most.
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

  return {
    ...ctx.base,
    id: ctx.newId(),
    tool: SUMMARY_TOOL,
    decision: hidden > 0 ? "deny" : "allow",
    reason:
      `SUMMARY: ${summarised.length} tool${summarised.length === 1 ? "" : "s"} in ` +
      `${toolkits.length} toolkit${toolkits.length === 1 ? "" : "s"} this control plane does not ` +
      `govern were decided in this call and are recorded as this one row — ${hidden} hidden, ` +
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

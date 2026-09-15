/**
 * The measured `/access` fan-out, as a fixture.
 *
 * Recorded at the #13 sitting on 2026-09-10, with retry **off** on the hook
 * extension: one `Loan.GetLoan` call through the gateway produced **three**
 * `access` audit rows, and one `Loan.ApproveLoan` produced **two**. Arcade
 * calls `/access` once per tool-schema resolution, so a single `tools/call`
 * fans out into several decisions about the same person and the same tool.
 *
 * It is here rather than in `@cg/policy-schema` because that package's
 * fixtures are deliberately domain-free — `Widgets.get_widget`, safe for a
 * forker to read — and this one is only interesting if it carries the real
 * measured shape: the bank's tool names, in the PascalCase `arcade deploy`
 * actually produces, for a persona the rest of the demo knows.
 *
 * The fixture stream serves it behind `?fanout=1`, so the grouping in
 * `grouping.ts` is something a presenter can watch happen with no backend
 * running rather than something a test asserts alone.
 */
import type { GovernanceEvent } from "@cg/policy-schema";
import { aGovernanceEvent, FIXTURE_EPOCH } from "@cg/policy-schema";

/** Alice, the protagonist — the address `governance.json` seeds. */
const DANA = "alice@bank.example";

/**
 * The two calls, in the counts they were measured at. Ordered as they arrived:
 * a call's own decisions land together, which is what makes them adjacent and
 * therefore groupable.
 */
const FANOUT: ReadonlyArray<{ tool: string; times: number }> = [
  { tool: "Loan.GetLoan", times: 3 },
  { tool: "Loan.ApproveLoan", times: 2 },
];

/** Milliseconds between two decisions of one fan-out. Sub-second, as measured. */
const APART_MS = 40;

/**
 * Five access events, oldest first: three for one `Loan.GetLoan` call and two
 * for one `Loan.ApproveLoan`. Deterministic — no clock — so a panel test
 * against it does not fail at midnight.
 */
export function anAccessFanout(): GovernanceEvent[] {
  const events: GovernanceEvent[] = [];
  let tick = 0;

  for (const { tool, times } of FANOUT) {
    for (let index = 0; index < times; index += 1) {
      events.push(
        aGovernanceEvent({
          id: `evt_access_${tool.replace(".", "_").toLowerCase()}_${index + 1}`,
          ts: new Date(Date.parse(FIXTURE_EPOCH) + tick * APART_MS).toISOString(),
          // `/access` decides a tool list, not an execution, so there is no
          // execution id to carry — the same as #5's own access event.
          execution_id: "",
          hook: "access",
          user_id: DANA,
          tool,
          decision: "allow",
          reason: "No rule hides this tool from this person.",
          rule_id: null,
        }),
      );
      tick += 1;
    }
  }

  return events;
}

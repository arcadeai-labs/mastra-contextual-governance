/**
 * The approval page, against the real control plane.
 *
 * `apps/hooks` runs as a subprocess and answers `/pre` and `/approvals` for
 * real; the only stand-in is Arcade itself, and it stands in by *calling the
 * real pre-hook* and running the tool only when the answer is `OK`. So the
 * refusal Alice sees in these tests is produced by the actual policy, not by a
 * fixture that says "denied".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalRecord } from "@cg/policy-schema";

import { ApprovalPage, Outcome, RequestDetails, UnknownRequest } from "../app/approvals/[id]/view.tsx";
import { fetchApproval, fetchRoster } from "../lib/approvals-store.ts";
import { submitDecision, type DecideResult } from "../lib/decide.ts";
import { choosePersona } from "../lib/persona.ts";
import { DANA, MORGAN, RILEY, SAM, startHarness, type Harness } from "./harness.ts";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness?.stop();
});

let request: ApprovalRecord;

beforeEach(async () => {
  request = ApprovalRecord.parse(await harness.escalate());
  harness.preCalls.length = 0;
});

const press = (userId: string, decision: "approved" | "denied", note: string | null = null) =>
  submitDecision({ userId, requestId: request.id, decision, note }, harness.config);

/** Narrows a result to the arms that carry a message, and fails loudly if not. */
const messageOf = (result: DecideResult): string => {
  if (result.state === "idle") throw new Error("expected a result, got idle");
  return result.message;
};

describe("resolving the request id", () => {
  test("one read is enough to render the page", async () => {
    // The link carries the id and nothing else, so this response has to carry
    // everything the page shows.
    const lookup = await fetchApproval(request.id, harness.config);
    expect(lookup.found).toBe(true);
    if (!lookup.found) return;

    const html = renderToStaticMarkup(<RequestDetails request={lookup.request} />);

    expect(html).toContain("Alice");
    expect(html).toContain(DANA);
    expect(html).toContain("approve_loan");
    expect(html).toContain("LN-2291");
    expect(html).toContain("$95,000");
    expect(html).toContain("pre.approve-within-clearance");
    expect(html).toContain("Eleven years in business");
    expect(html).toContain("Charlie");
    // Who was deliberately not bothered is the point being demonstrated.
    expect(html).toContain(MORGAN);
  });

  test("an id nobody recognises lands on a page that says so", async () => {
    const lookup = await fetchApproval("apr_nosuchthing", harness.config);
    expect(lookup).toEqual({ found: false, reason: "No approval request apr_nosuchthing exists." });

    const html = renderToStaticMarkup(
      <UnknownRequest id="apr_nosuchthing" reason={(lookup as { reason: string }).reason} />,
    );
    expect(html).toContain("Nothing to decide");
    expect(html).toContain("apr_nosuchthing");
  });

  test("the read is the same for everyone, because it takes no viewer", async () => {
    // The requester can read the DM she sent, so she can open the link. That
    // is expected, and it is why the decision is checked at click time.
    const first = await fetchApproval(request.id, harness.config);
    const second = await fetchApproval(request.id, harness.config);
    expect(first).toEqual(second);
  });
});

describe("pressing a button", () => {
  test("Charlie approves: the call goes through Arcade as Charlie, and it is recorded", async () => {
    const result = await press(RILEY, "approved", "Coverage checks out.");

    expect(result).toEqual({
      state: "recorded",
      decision: "approved",
      message: `Recorded as approved by ${RILEY}.`,
    });
    // As the clicking user, through the same pre-hook as any other tool call.
    expect(harness.preCalls).toEqual([{ user_id: RILEY, tool: "Approvals.Decide" }]);

    const after = await harness.read(request.id);
    expect(after).toMatchObject({ status: "approved", decided_by: RILEY, note: "Coverage checks out." });
  });

  test("Charlie denies: recorded, and the request cannot then be approved", async () => {
    expect((await press(RILEY, "denied", "Too thin.")).state).toBe("recorded");

    const second = await press(RILEY, "approved");

    expect(second.state).toBe("refused");
    expect(messageOf(second)).toContain("already been decided");
    expect(await harness.read(request.id)).toMatchObject({ status: "denied", note: "Too thin." });
  });

  test("Alice clicking her own link gets CHECK_FAILED, and the request is untouched", async () => {
    const result = await press(DANA, "approved");

    expect(result.state).toBe("refused");
    expect(messageOf(result)).toContain("separation of duties");
    // The same correlation token the agent's denial carried, so the panel can
    // join this refusal to the audit row that produced it.
    expect(messageOf(result)).toMatch(/\[ref evt_[0-9a-hj-km-np-tv-z]{10}\]$/);
    expect(await harness.read(request.id)).toMatchObject({ status: "pending", decided_by: null });
  });

  test("a clicker whose clearance does not cover the amount is refused", async () => {
    const result = await press(SAM, "approved");

    expect(result.state).toBe("refused");
    expect(messageOf(result)).toContain("approval authority of 0");
    expect(await harness.read(request.id)).toMatchObject({ status: "pending" });
  });

  test("Arcade being unreachable is a failure, not a refusal", async () => {
    // A control that appears to work while doing nothing is worse than no
    // control, so an outage must never render as "you are not allowed".
    const offline = { ...harness.config, arcadeApiUrl: "http://127.0.0.1:1" };
    const result = await submitDecision(
      { userId: RILEY, requestId: request.id, decision: "approved", note: null },
      offline,
    );

    expect(result.state).toBe("failed");
    expect(await harness.read(request.id)).toMatchObject({ status: "pending" });
  });
});

describe("the denial screen", () => {
  test("shows the hook's own words, and does not read as a crash", async () => {
    const result = await press(DANA, "approved");

    const html = renderToStaticMarkup(<Outcome result={result} />);

    expect(html).toContain("CHECK_FAILED");
    expect(html).toContain("separation of duties");
    expect(html).toContain("recorded in the audit log");
    expect(html).toContain("The request is unchanged.");
  });

  test("a fault says no control has spoken, which a refusal never says", async () => {
    const refusal = renderToStaticMarkup(<Outcome result={{ state: "refused", message: "no" }} />);
    const fault = renderToStaticMarkup(<Outcome result={{ state: "failed", message: "no" }} />);

    expect(fault).toContain("no control has spoken");
    expect(refusal).not.toContain("no control has spoken");
    expect(refusal).toContain("CHECK_FAILED");
    expect(fault).not.toContain("CHECK_FAILED");
  });

  test("nothing is shown before a button has been pressed", () => {
    expect(renderToStaticMarkup(<Outcome result={{ state: "idle" }} />)).toBe("");
  });
});

describe("acting as", () => {
  test("defaults to the routed approver, so the link works from Slack", async () => {
    const roster = await fetchRoster(harness.config);
    expect(choosePersona(undefined, roster, request.approver_id)).toBe(RILEY);
  });

  test("honours a chosen persona the control plane knows", async () => {
    const roster = await fetchRoster(harness.config);
    // Choosing the requester is not an escalation — it is the beat the demo
    // wants, and the pre-hook is what answers it.
    expect(choosePersona(DANA, roster, request.approver_id)).toBe(DANA);
  });

  test("ignores a persona the control plane has never heard of", async () => {
    const roster = await fetchRoster(harness.config);
    expect(choosePersona("attacker@example.test", roster, request.approver_id)).toBe(RILEY);
  });

  test("the whole page names the identity the call will be made under", async () => {
    const roster = await fetchRoster(harness.config);
    const html = renderToStaticMarkup(
      <ApprovalPage
        request={request}
        actingAs={DANA}
        personas={roster}
        controls={<p>controls</p>}
      />,
    );

    expect(html).toContain("Acting as");
    expect(html).toContain("Alice");
    expect(html).toContain("Approvals.Decide");
    expect(html).toContain("carries no authority");
  });
});

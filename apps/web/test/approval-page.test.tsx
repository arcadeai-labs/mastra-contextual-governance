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
import { readOpener, signInToDecideUrl, type Opener } from "../lib/approvals/opener.ts";
import { chunk, chunkName, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, type Session } from "../lib/identity/session.ts";
import { DANA, MORGAN, RILEY, SAM, SESSION_SECRET, startHarness, type Harness } from "./harness.ts";

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

  test("the audit row names the requester, and no row names the routed approver", async () => {
    // The control plane's own log, read back over `/audit`. #180's real cost
    // was never the loan — it was a row recording Charlie approving a request
    // Alice raised, at a moment Charlie was not present, which is wrong in a
    // way indistinguishable from the correct case.
    await press(DANA, "approved");

    const self = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) => JSON.stringify(row).includes("decide-not-by-the-requester"));

    // Filtered by person rather than counted, because this file shares one
    // `governance.db` across its cases and a bare count would be an assertion
    // about test order.
    const hers = self(await harness.audit({ hook: "pre", decision: "deny", user_id: DANA, tool: "Approvals.Decide" }));
    const his = self(await harness.audit({ hook: "pre", decision: "deny", user_id: RILEY, tool: "Approvals.Decide" }));

    expect(hers.length).toBeGreaterThan(0);
    expect(hers.every((row) => row.user_id === DANA)).toBe(true);
    // Charlie is never the subject of a separation-of-duties refusal on a
    // request Alice raised. He was, before #180 — as the person Alice's click
    // was attributed to.
    expect(his).toEqual([]);
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

/**
 * A browser carrying the cookies a real sign-in would have left, as
 * `next/headers`' `cookies()` hands them over.
 *
 * Sealed with the suite's own `SESSION_SECRET`, through the same `seal` and
 * `chunk` the sign-in callback writes with — so what these tests hand the page
 * is the format a browser actually carries, not a shortcut around the seal.
 */
function jarFor(session: Session | null) {
  const cookies =
    session === null
      ? Promise.resolve<Array<{ name: string; value: string }>>([])
      : seal(session, SESSION_SECRET).then((sealed) =>
          chunk(sealed).map((value, index) => ({ name: chunkName(SESSION_COOKIE, index), value })),
        );
  return cookies.then((all) => ({ getAll: () => all }));
}

const signedInAs = (email: string): Session => ({ email, signed_in_at: Date.now() });

describe("who the page is deciding as", () => {
  test("the sealed session, and nothing else", async () => {
    const opener = await readOpener(await jarFor(signedInAs(RILEY)), request.id, harness.config);
    expect(opener).toEqual({ state: "signed-in", email: RILEY });
  });

  test("a browser with no session is signed out — not the routed approver", async () => {
    // #180 in one assertion. This used to answer with `request.approver_id`,
    // which is how Alice pressed Approve as Charlie.
    const opener = await readOpener(await jarFor(null), request.id, harness.config);

    expect(opener.state).toBe("signed-out");
    expect(opener).not.toMatchObject({ email: request.approver_id });
  });

  test("the requester's own session names the requester", async () => {
    // She really is signed in, as herself. That is the beat, and it is now
    // honest: no cookie chose this, a password did.
    const opener = await readOpener(await jarFor(signedInAs(DANA)), request.id, harness.config);
    expect(opener).toEqual({ state: "signed-in", email: DANA });
  });

  test("a cookie the browser can write does not select the decider", async () => {
    // `cg_persona` is gone; a browser that still carries one — a laptop open
    // across the deploy — is simply signed out, and not Charlie.
    const stale = { getAll: () => [{ name: "cg_persona", value: RILEY }] };

    expect(await readOpener(stale, request.id, harness.config)).toEqual({
      state: "signed-out",
      signInUrl: signInToDecideUrl(request.id),
    });
  });

  test("a session sealed under a different key is signed out, not a name", async () => {
    const forged = await seal(signedInAs(RILEY), "a-different-secret-long-enough-to-pass-0123");
    const jar = { getAll: () => chunk(forged).map((value, index) => ({ name: chunkName(SESSION_COOKIE, index), value })) };

    expect((await readOpener(jar, request.id, harness.config)).state).toBe("signed-out");
  });

  test("the sign-in comes back to this link", async () => {
    // The round trip is the sign-in flow's own `next`: a same-origin path,
    // which is the only thing `safeNext` will accept.
    const url = signInToDecideUrl("apr_01HXYZ");
    expect(url).toBe("/api/auth/signin?next=%2Fapprovals%2Fapr_01HXYZ");
    expect(decodeURIComponent(new URL(url, "http://x").searchParams.get("next") ?? "")).toBe(
      "/approvals/apr_01HXYZ",
    );
  });
});

describe("what the page says about it", () => {
  const signedIn = (email: string): Opener => ({ state: "signed-in", email });
  const signedOut: Opener = { state: "signed-out", signInUrl: signInToDecideUrl("apr_x") };

  const render = async (opener: Opener) =>
    renderToStaticMarkup(
      <ApprovalPage
        request={request}
        opener={opener}
        personas={await fetchRoster(harness.config)}
        controls={<p>the buttons</p>}
      />,
    );

  test("signed in, it names the person the call will be made as", async () => {
    const html = await render(signedIn(DANA));

    expect(html).toContain("Signed in as");
    expect(html).toContain("Alice");
    expect(html).toContain(DANA);
    expect(html).toContain("Approvals.Decide");
    expect(html).toContain("carries no authority");
    expect(html).toContain("the buttons");
  });

  test("signed out, the buttons are replaced by a sign-in that returns here", async () => {
    const html = await render(signedOut);

    expect(html).toContain("Sign in to decide");
    expect(html).toContain(signedOut.state === "signed-out" ? signedOut.signInUrl.replace(/&/g, "&amp;") : "");
    // A distinct affordance, not a greyed-out Approve: a disabled Approve on a
    // governance page reads as a refusal nothing made.
    expect(html).not.toContain("the buttons");
    expect(html).not.toContain("disabled");
  });

  test("there is no way to choose who to act as", async () => {
    const html = await render(signedIn(RILEY));

    expect(html).not.toContain("Act as");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
    // The switcher listed every roster member as an option. Bob is in no field
    // of this request, so his address being gone is the switcher being gone —
    // unlike Michael's, which `RequestDetails` still prints under "Also
    // sufficient, not asked", because who was deliberately *not* bothered is
    // part of what routing is demonstrating.
    expect(html).not.toContain(SAM);
    expect(html).toContain(MORGAN);
  });

  test("signed out shows the same fields as signed in, no more and no less", async () => {
    // Held by construction — `RequestDetails` is rendered once, before the
    // branch — and asserted so it stays that way. Whether the link should
    // disclose this to an unauthenticated opener at all is a separate question
    // and not one this page answers differently per viewer.
    const fields = (html: string) => html.match(/<div style="width:11rem[^>]*>([^<]*)</g) ?? [];

    const inside = await render(signedIn(RILEY));
    const outside = await render(signedOut);

    expect(fields(outside)).toEqual(fields(inside));
    expect(fields(inside).length).toBeGreaterThan(5);
    for (const shown of [DANA, "approve_loan", "LN-2291", "$95,000", "Eleven years in business"]) {
      expect(outside).toContain(shown);
      expect(inside).toContain(shown);
    }
  });
});

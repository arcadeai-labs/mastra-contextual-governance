/**
 * Act 2, end to end, offline: prompt → deny → route → decide → resume → the
 * loan is approved, and then the grant is spent and the next retry is refused.
 *
 * ## What is real here
 *
 * Everything except the gateway and — with no `ANTHROPIC_API_KEY` — the model.
 * `apps/hooks` is a subprocess compiling the real policy and owning a real
 * `governance.db`; `apps/loan-app` is a subprocess owning a real `loans.db`, so
 * "the loan was approved" is a claim about a row. The escalation is recorded
 * through the real `POST /approvals`; the decision is recorded through the real
 * `POST /approvals/{id}/decision`, which is what #19 built and what the
 * approval page presses. `GET /events` is the real stream, read here exactly as
 * the browser reads it — over HTTP, filtering on the event name — and the
 * `event: approval` frame it delivers is what triggers the resume.
 *
 * The one thing not exercised offline is Slack: `Approvals_RequestApproval`
 * routes and records for real and then says, in its own result, that no message
 * was sent. Live Slack needs a credential no test holds.
 *
 * ## Why the assertions are where they are
 *
 * The reply itself is a claim about the *model*, so it is split: with a key,
 * the agent's own words are asserted to name the routed approver; without one,
 * the reply was written by this suite's script and the assertion moves to the
 * conversation the model was handed — the approver's name in the tool's own
 * result, chosen by the real routing rule against the real roster. A green run
 * that says `SCRIPTED` has not measured what Claude says.
 *
 * The criterion this file exists for is *"the retry passes the pre-hook because
 * a valid grant exists — verified in the audit log, not inferred"*. So the
 * retry's own audit row is read back over `GET /audit` and checked to be an
 * `allow` on `Loan.ApproveLoan` **carrying the rule id that would have denied
 * it** and naming the grant it consumed. An absent error would prove nothing:
 * a policy that had simply stopped matching would look identical.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ApprovalNotice, type ApprovalRecord } from "@cg/policy-schema";

import {
  APPROVALS_TOOLKIT,
  DANA,
  LOAN_TOOLKIT,
  OVER_LIMIT_LOAN,
  RILEY,
  STORE_TOKEN,
  startAgentHarness,
  type AgentHarness,
} from "./agent-harness.ts";
import { anthropicModel } from "../lib/agent/agent.ts";
import { approvalStatus } from "../lib/agent/approval-status.ts";
import { chat, CHAT_PATH } from "../lib/agent/handlers.ts";
import { decodeEvents, replyText, type ChatEvent } from "../lib/agent/events.ts";
import { liveModelKey, promptText, scriptedModel, type Turn } from "./model.ts";
import { writeSession, type Session } from "../lib/identity/session.ts";

const LIVE_KEY = liveModelKey();
const TURN_TIMEOUT_MS = LIVE_KEY ? 240_000 : 30_000;

const REQUEST_APPROVAL = `${APPROVALS_TOOLKIT}_RequestApproval`;
const APPROVE_LOAN = `${LOAN_TOOLKIT}_ApproveLoan`;

/** #14's prompt, on the loan act 2 is written around. */
const DEMO_PROMPT =
  "Approve the loan for $95K and double-check your work so you don't make any mistakes.";

let harness: AgentHarness;
let web: ReturnType<typeof Bun.serve>;
let currentModel: () => unknown;

beforeAll(async () => {
  harness = await startAgentHarness({ approvals: true });
  web = Bun.serve({
    port: 0,
    idleTimeout: 120,
    fetch: (request) => {
      const store = { hooksHost: harness.hooksHost, approvalsStoreToken: STORE_TOKEN };
      const { pathname } = new URL(request.url);
      // The store this harness's control plane serves, on its own port.
      if (pathname === CHAT_PATH) {
        return chat(request, { config: harness.config, model: currentModel, store });
      }
      if (pathname.startsWith("/api/approvals/")) {
        return approvalStatus(request, { config: harness.config, store });
      }
      return new Response(null, { status: 404 });
    },
  });
  console.log(
    `[act2-resume] model: ${LIVE_KEY ? `LIVE ${harness.config.agent.modelId} at temperature 0` : "SCRIPTED (ANTHROPIC_API_KEY is not set)"}`,
  );
}, 60_000);

afterAll(async () => {
  web?.stop(true);
  await harness?.stop();
});

// ---------------------------------------------------------------------------
// Driving the chat route the way a browser does
// ---------------------------------------------------------------------------

/** The cookie a browser signed in as `email` and holding a gateway token would send. */
async function browserFor(email: string): Promise<string> {
  const session: Session = {
    email,
    signed_in_at: Date.now(),
    gateway: {
      access_token: harness.tokenFor(email),
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-act2-tests",
    },
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, harness.config);
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
}

interface Turned {
  status: number;
  events: ChatEvent[];
  reply: string;
  /**
   * Everything the model was handed, flattened — tool results included.
   *
   * Empty on the live path, where there is nothing to record. On the scripted
   * path it is the only honest place to ask "did the routed approver's name
   * reach the model at all", because the reply on that path was written by this
   * suite's own fixture. Same seam #14 reads a hook's remediation text off.
   */
  prompt: string;
}

async function post(cookie: string, body: unknown, script: readonly Turn[]): Promise<Turned> {
  const scripted = scriptedModel(script);
  currentModel = LIVE_KEY
    ? () => anthropicModel({ modelId: harness.config.agent.modelId, apiKey: LIVE_KEY })
    : () => scripted.model;

  const response = await fetch(`http://localhost:${web.port}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const events = decodeEvents(await response.text());
  return {
    status: response.status,
    events,
    reply: replyText(events),
    prompt: LIVE_KEY ? "" : promptText(scripted.prompts),
  };
}

const of = <K extends ChatEvent["kind"]>(events: readonly ChatEvent[], kind: K) =>
  events.filter((event): event is Extract<ChatEvent, { kind: K }> => event.kind === kind);

// ---------------------------------------------------------------------------
// The approval stream, read the way the browser reads it
// ---------------------------------------------------------------------------

/**
 * Waits for the `event: approval` frame naming `requestId`, on a connection
 * opened **before** the decision is made.
 *
 * Opened first on purpose: the notice carries no `id:` and takes no part in the
 * replay, so a subscriber that connects afterwards has genuinely missed it.
 * That is the live-only property the server documents, exercised rather than
 * assumed.
 */
function watchForNotice(requestId: string): {
  notice: Promise<ApprovalNotice>;
  ready: Promise<void>;
  stop: () => void;
} {
  const controller = new AbortController();
  let announceReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  const notice = (async (): Promise<ApprovalNotice> => {
    const response = await fetch(`http://${harness.hooksHost}/events`, {
      headers: { accept: "text/event-stream", "cache-control": "no-cache" },
      signal: controller.signal,
    });
    if (response.body === null) throw new Error("no stream body");
    announceReady();

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the stream closed before the approval frame arrived");
      buffer += chunk.value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        // The filter the panel's adapter applies, and the one the chat's
        // watcher applies: by event name, not by guessing at the payload.
        const lines = block.split("\n");
        if (!lines.includes("event: approval")) continue;
        const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
        const parsed = ApprovalNotice.parse(JSON.parse(data));
        if (parsed.request_id !== requestId) continue;
        await reader.cancel().catch(() => undefined);
        return parsed;
      }
    }
  })();

  return { notice, ready, stop: () => controller.abort() };
}

/** The approval store, as the approval page reads and presses it (#19). */
const store = (method: string, path: string, body?: unknown) =>
  fetch(`http://${harness.hooksHost}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${STORE_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/**
 * Every `/pre` audit row for one tool, oldest first.
 *
 * The hook is part of the filter and not an afterthought: `/access` writes one
 * row per tool on every `tools/list`, so `Loan.ApproveLoan` has an `allow` row
 * from act 1's layer before any call is ever made. Reading those as decisions
 * about a call is how "the retry was allowed" would come out true for the wrong
 * reason.
 */
async function preRowsFor(tool: string): Promise<Array<Record<string, unknown>>> {
  const rows = await harness.audit();
  return rows.filter((row) => row.tool === tool && row.hook === "pre").reverse();
}

// ---------------------------------------------------------------------------
// Act 2, in order
// ---------------------------------------------------------------------------

describe("act 2, end to end", () => {
  let blocked: Turned;
  let waiting: Extract<ChatEvent, { kind: "waiting" }> | undefined;
  let request: ApprovalRecord;
  let granted: ApprovalNotice;
  let resumed: Turned;
  let cookie: string;

  beforeAll(async () => {
    cookie = await browserFor(DANA);

    // ---- the blocked turn -------------------------------------------------
    blocked = await post(
      cookie,
      { prompt: DEMO_PROMPT },
      [
        { call: `${LOAN_TOOLKIT}_SearchLoans`, input: { status: "pending", min_amount: 95000, max_amount: 95000 } },
        { call: `${LOAN_TOOLKIT}_GetLoan`, input: { loan_id: OVER_LIMIT_LOAN } },
        { call: APPROVE_LOAN, input: { loan_id: OVER_LIMIT_LOAN, amount: 95000 } },
        {
          call: REQUEST_APPROVAL,
          input: {
            action: "approve_loan",
            resource_id: OVER_LIMIT_LOAN,
            amount: 95000,
            justification: "Eleven years in business, 742 credit score, $1.4M annual revenue.",
          },
        },
        {
          say:
            "I could not approve LN-2291 myself — the control plane refused it as over my " +
            "authority — so I have requested approval from Riley Chen, VP Credit. Waiting for " +
            "their decision.",
        },
      ],
    );

    waiting = of(blocked.events, "waiting")[0];
    const lookup = await store("GET", `/approvals/${waiting?.request_id ?? "missing"}`);
    request = ((await lookup.json()) as { request: ApprovalRecord }).request;

    // ---- the decision, watched on the stream -------------------------------
    const watcher = watchForNotice(request.id);
    await watcher.ready;

    // Riley presses Approve. The page calls `Approvals.Decide` through Arcade
    // as the clicking user; here the gateway stand-in is that path, so the
    // call is governed at `/pre` exactly as it is in production.
    const decide = await post(
      await browserFor(RILEY),
      { prompt: `Approve request ${request.id}.` },
      [
        {
          call: `${APPROVALS_TOOLKIT}_Decide`,
          input: { request_id: request.id, decision: "approved", note: "Collateral verified." },
        },
        { say: "Recorded." },
      ],
    );
    expect(of(decide.events, "denied")).toHaveLength(0);

    granted = await watcher.notice;
    watcher.stop();

    // ---- the resume --------------------------------------------------------
    // Exactly what the page sends: the id it was watching, and the turn that
    // ended waiting, as context. No outcome, no approver, no amount.
    resumed = await post(
      cookie,
      {
        resume: {
          request_id: granted.request_id,
          prompt: DEMO_PROMPT,
          reply: blocked.reply,
        },
      },
      [
        { call: APPROVE_LOAN, input: { loan_id: OVER_LIMIT_LOAN, amount: 95000 } },
        { say: "Approved: LN-2291 for $95,000, on Riley Chen's approval." },
      ],
    );
  }, TURN_TIMEOUT_MS * 3);

  test("the turn ends after the escalation, naming the routed approver", () => {
    expect(blocked.status).toBe(200);

    // It ended. `done` is the last event of the stream and there is exactly
    // one of it — nothing here polled, slept or held the socket open.
    expect(blocked.events.at(-1)?.kind).toBe("done");
    expect(of(blocked.events, "done")).toHaveLength(1);

    // And it ended *after* the escalation: the last tool called is the
    // escalation, not the approval.
    const calls = of(blocked.events, "tool-call").map((event) => event.tool);
    expect(calls.at(-1)).toBe(REQUEST_APPROVAL);

    // The approver the control plane routed to, carried on the event and named
    // in the reply. Riley (clearance $250,000) is the lowest sufficient
    // approver for $95,000; Morgan ($5,000,000) is deliberately not asked.
    expect(waiting?.request_id).toMatch(/^apr_/);
    expect(waiting?.approver).toBe("Riley Chen");
    expect(request.approver_id).toBe(RILEY);
    expect(request.candidate_approver_ids[0]).toBe(RILEY);

    if (LIVE_KEY) {
      // The criterion as written: the agent's own words name the approver. Only
      // a real completion can be asked this.
      expect(blocked.reply).toContain("Riley Chen");
    } else {
      // Not measurable without a real completion — the reply on this path was
      // written by this suite's script, and asserting on it would be asserting
      // on the fixture. What the scripted run does prove is that the routed
      // approver's name reached the model's prompt, in the tool's own result,
      // having been chosen by the real routing rule against the real roster.
      expect(blocked.prompt).toContain("Riley Chen");
      expect(blocked.prompt).toContain(request.id);
    }

    // The `/pre` row for the escalation says who was routed to and who was
    // not bothered — the routing beat, on the panel, from a real hook decision
    // rather than a synthetic event.
    expect(request.status).toBe("pending");
  });

  test("the escalation was reached by the hook's own remediation text, not by a prompt", () => {
    const denial = of(blocked.events, "denied").find((event) => event.tool === APPROVE_LOAN);
    expect(denial?.reason).toContain("exceeds your approval authority of 50000");
    // The rule names the escalation tool. Which spelling it uses is #89's
    // call — asserted here as "it names it", so this test does not have to
    // move when that lands.
    expect(denial?.reason).toContain("RequestApproval");
    expect(denial?.ref).toMatch(/^evt_[0-9a-hj-km-np-tv-z]{10}$/);
  });

  test("`approval.granted` reaches the stream naming the request and the requester", () => {
    expect(granted.kind).toBe("approval.granted");
    expect(granted.request_id).toBe(request.id);
    // The two fields the browser matches on before it resumes anything.
    expect(granted.requester_id).toBe(DANA);
    expect(granted.decided_by).toBe(RILEY);
    expect(granted.grants_activated).toBe(1);
  });

  test("the resumed turn opens with the fact it was resumed on, and no instruction", () => {
    const opened = resumed.events[0];
    expect(opened?.kind).toBe("resumed");
    const event = opened as Extract<ChatEvent, { kind: "resumed" }>;
    expect(event.request_id).toBe(request.id);
    expect(event.decision).toBe("approved");
    expect(event.decided_by).toBe(RILEY);

    // A statement of fact: who, what, how much, when. And nothing telling the
    // model what to do about it — `DESIGN.md` → Determinism, and the whole
    // reason the hook's remediation text exists.
    expect(event.message).toContain(request.id);
    expect(event.message).toContain("approve_loan on LN-2291 for 95000");
    expect(event.message).toContain("was approved by Riley Chen");
    for (const imperative of ["retry", "proceed", "you may now", "go ahead", "try again"]) {
      expect(event.message.toLowerCase()).not.toContain(imperative);
    }
  });

  test("the retry passes /pre because a grant exists — read off the audit log", async () => {
    const rows = await preRowsFor("Loan.ApproveLoan");
    // Two calls on this loan: the one that was refused, and the retry.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const refused = rows[0];
    expect(refused?.decision).toBe("deny");
    expect(refused?.rule_id).toBe("pre.approve-within-clearance");

    const retry = rows[1];
    expect(retry?.decision).toBe("allow");
    // The claim, and the reason this is read from the log rather than inferred
    // from the absence of an error: the row names the rule that *would* have
    // denied it. A policy that had simply stopped matching would have written
    // `rule_id: null` and `No rule matched.` here, and the turn would look
    // identical on screen.
    expect(retry?.rule_id).toBe("pre.approve-within-clearance");
    expect(String(retry?.reason)).toContain("Covered by an active grant (grn_");
    expect(String(retry?.reason)).toContain(`issued against approval request ${request.id}`);
    expect(retry?.user_id).toBe(DANA);
  });

  test("the loan book records the approval, attributed to Dana", async () => {
    const loan = await harness.loan(OVER_LIMIT_LOAN, DANA);
    expect(loan.status).toBe("approved");
    const decisions = loan.decisions as Array<Record<string, unknown>>;
    const last = decisions.at(-1);
    expect(last?.decision).toBe("approved");
    expect(last?.amount).toBe(95_000);
    // The actor the loan API derived from the bearer, never from a parameter.
    expect(last?.decided_by).toBe(DANA);
  });

  test("the grant is consumed: a second retry is denied", async () => {
    const second = await post(
      cookie,
      { prompt: "Approve LN-2291 for $95,000 again." },
      [
        { call: APPROVE_LOAN, input: { loan_id: OVER_LIMIT_LOAN, amount: 95000 } },
        { say: "It was refused: my authority has not changed." },
      ],
    );

    const denial = of(second.events, "denied").find((event) => event.tool === APPROVE_LOAN);
    expect(denial).toBeDefined();
    expect(denial?.reason).toContain("exceeds your approval authority of 50000");

    const rows = await preRowsFor("Loan.ApproveLoan");
    const last = rows.at(-1);
    expect(last?.decision).toBe("deny");
    expect(last?.rule_id).toBe("pre.approve-within-clearance");
    // The grant is not merely absent from the decision — the row says it was
    // looked at and had nothing left, which is the difference between a
    // control that fired and a table that happened to be empty.
    expect(String(last?.reason)).toMatch(/did not apply|not considered/);
  }, TURN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The denial path
// ---------------------------------------------------------------------------

describe("a denied approval resumes the agent with the denial", () => {
  let resumed: Turned;
  let notice: ApprovalNotice;
  let request: ApprovalRecord;
  let cookie: string;
  let approveCallsBefore: number;

  beforeAll(async () => {
    cookie = await browserFor(DANA);
    approveCallsBefore = harness.calls.filter((call) => call.tool === APPROVE_LOAN).length;

    // A fresh escalation, on a second loan so the first one's settled state is
    // not in the way.
    const blocked = await post(
      cookie,
      { prompt: "Approve LN-2299 for $88,000." },
      [
        { call: APPROVE_LOAN, input: { loan_id: "LN-2299", amount: 88000 } },
        {
          call: REQUEST_APPROVAL,
          input: {
            action: "approve_loan",
            resource_id: "LN-2299",
            amount: 88000,
            justification: "Refinance at a lower rate; DSCR 1.6.",
          },
        },
        { say: "Requested approval from Riley Chen, VP Credit." },
      ],
    );
    const waiting = of(blocked.events, "waiting")[0];
    const lookup = await store("GET", `/approvals/${waiting?.request_id ?? "missing"}`);
    request = ((await lookup.json()) as { request: ApprovalRecord }).request;

    const watcher = watchForNotice(request.id);
    await watcher.ready;
    const decide = await post(
      await browserFor(RILEY),
      { prompt: `Deny request ${request.id}.` },
      [
        {
          call: `${APPROVALS_TOOLKIT}_Decide`,
          input: {
            request_id: request.id,
            decision: "denied",
            note: "Concentration risk in this sector this quarter.",
          },
        },
        { say: "Recorded." },
      ],
    );
    expect(of(decide.events, "denied")).toHaveLength(0);
    notice = await watcher.notice;
    watcher.stop();

    resumed = await post(
      cookie,
      { resume: { request_id: request.id, prompt: "Approve LN-2299 for $88,000.", reply: blocked.reply } },
      [{ say: "Riley Chen denied it: concentration risk in this sector this quarter." }],
    );
  }, TURN_TIMEOUT_MS * 3);

  test("the denial comes down the same stream, activating nothing", () => {
    expect(notice.kind).toBe("approval.denied");
    expect(notice.status).toBe("denied");
    expect(notice.grants_activated).toBe(0);
  });

  test("the resume carries the denial and the approver's note", () => {
    const event = resumed.events[0] as Extract<ChatEvent, { kind: "resumed" }>;
    expect(event.kind).toBe("resumed");
    expect(event.decision).toBe("denied");
    expect(event.message).toContain("was denied by Riley Chen");
    expect(event.message).toContain("Concentration risk in this sector this quarter.");
  });

  test("and the agent does not retry", () => {
    // No tool call at all on the resumed turn, and nothing reached the
    // gateway: the count of `ApproveLoan` calls is exactly the one this
    // describe made before the escalation.
    expect(of(resumed.events, "tool-call")).toHaveLength(0);
    expect(harness.calls.filter((call) => call.tool === APPROVE_LOAN).length).toBe(
      approveCallsBefore + 1,
    );

    // And the loan book is untouched.
    expect(of(resumed.events, "denied")).toHaveLength(0);
  });

  test("the loan stays pending", async () => {
    const loan = await harness.loan("LN-2299", DANA);
    expect(loan.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// What a resume may not do
// ---------------------------------------------------------------------------

describe("the catch-up read, for a browser whose stream was down", () => {
  /** What the page asks on every reconnect, over real HTTP with a cookie jar. */
  const status = (id: string, cookie: string) =>
    fetch(`http://localhost:${web.port}/api/approvals/${encodeURIComponent(id)}/status`, {
      headers: { cookie, accept: "application/json" },
    });

  test("it answers the requester with the status, and nothing else", async () => {
    const created = await store("POST", "/approvals", {
      requester_id: DANA,
      action: "approve_loan",
      resource_id: "LN-2292",
      amount: 15_500,
      justification: "Within authority; recorded for the audit trail.",
      approver_id: RILEY,
      candidate_approver_ids: [RILEY],
      required_clearance: 15_500,
    });
    const request = ((await created.json()) as { request: ApprovalRecord }).request;
    const cookie = await browserFor(DANA);

    const pending = await status(request.id, cookie);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ request_id: request.id, status: "pending" });

    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });
    const decided = await status(request.id, cookie);
    // A status, not a record: everything the resume asserts is read from the
    // store by the resume itself, and this says only whether there is now
    // something to resume on.
    expect(await decided.json()).toEqual({ request_id: request.id, status: "approved" });
  });

  test("somebody else's request is a 404, the same answer an unknown id gets", async () => {
    const created = await store("POST", "/approvals", {
      requester_id: DANA,
      action: "approve_loan",
      resource_id: "LN-2292",
      amount: 15_500,
      justification: "Within authority; recorded for the audit trail.",
      approver_id: RILEY,
      candidate_approver_ids: [RILEY],
      required_clearance: 15_500,
    });
    const request = ((await created.json()) as { request: ApprovalRecord }).request;

    const mine = await status(request.id, await browserFor("morgan.ellis@bank.example"));
    const nobodys = await status("apr_doesnotexist", await browserFor("morgan.ellis@bank.example"));
    expect(mine.status).toBe(404);
    expect(nobodys.status).toBe(404);
    // One answer for both — the same status and the same sentence, differing
    // only in the id the caller itself supplied. A caller cannot learn which
    // ids exist from the difference between them.
    expect(await mine.json()).toEqual({
      error: `No approval request ${request.id} for this browser.`,
    });
    expect(await nobodys.json()).toEqual({
      error: "No approval request apr_doesnotexist for this browser.",
    });
  });

  test("an unsigned-in browser gets 401", async () => {
    const response = await fetch(
      `http://localhost:${web.port}/api/approvals/apr_anything/status`,
      { headers: { accept: "application/json" } },
    );
    expect(response.status).toBe(401);
  });
});

describe("a resume asserts nothing the store does not say", () => {
  test("a request that is still pending is a fault, not a turn", async () => {
    const cookie = await browserFor(DANA);
    const created = await store("POST", "/approvals", {
      requester_id: DANA,
      action: "approve_loan",
      resource_id: "LN-2292",
      amount: 15_500,
      justification: "Within authority; recorded for the audit trail.",
      approver_id: RILEY,
      candidate_approver_ids: [RILEY],
      required_clearance: 15_500,
    });
    const request = ((await created.json()) as { request: ApprovalRecord }).request;

    const result = await post(cookie, { resume: { request_id: request.id, prompt: "", reply: "" } }, []);

    expect(result.status).toBe(200);
    const fault = of(result.events, "fault")[0];
    expect(fault?.message).toContain(request.id);
    expect(fault?.message).toContain('reads "pending"');
    // Not a denial. Nothing refused anything here, and a control surface that
    // said otherwise would be claiming a decision the control plane never made.
    expect(of(result.events, "denied")).toHaveLength(0);
    expect(of(result.events, "resumed")).toHaveLength(0);
  });

  test("one persona cannot resume another's turn", async () => {
    const created = await store("POST", "/approvals", {
      requester_id: DANA,
      action: "approve_loan",
      resource_id: "LN-2292",
      amount: 15_500,
      justification: "Within authority; recorded for the audit trail.",
      approver_id: RILEY,
      candidate_approver_ids: [RILEY],
      required_clearance: 15_500,
    });
    const request = ((await created.json()) as { request: ApprovalRecord }).request;
    await store("POST", `/approvals/${request.id}/decision`, {
      decision: "approved",
      note: null,
      decided_by: RILEY,
    });

    // Morgan's browser, with Dana's request id. The turn would otherwise run —
    // as Morgan, on Dana's approval.
    const result = await post(
      await browserFor("morgan.ellis@bank.example"),
      { resume: { request_id: request.id, prompt: "", reply: "" } },
      [],
    );

    const fault = of(result.events, "fault")[0];
    expect(fault?.message).toContain(DANA);
    expect(fault?.message).toContain("morgan.ellis@bank.example");
    expect(of(result.events, "resumed")).toHaveLength(0);
  });

  test("a request id that names nothing is a fault", async () => {
    const result = await post(
      await browserFor(DANA),
      { resume: { request_id: "apr_doesnotexist", prompt: "", reply: "" } },
      [],
    );
    const fault = of(result.events, "fault")[0];
    expect(fault?.message).toContain("apr_doesnotexist");
    expect(of(result.events, "resumed")).toHaveLength(0);
  });
});

/**
 * The turn ends on the escalation — round 1 of #110's review, as a test.
 *
 * The finding: `runTurn` emitted `waiting` and kept consuming the model stream,
 * so a model that called `Loan_ApproveLoan` straight after
 * `Approvals_RequestApproval` got that call executed, against a control plane
 * that had no grant yet. The reviewer reproduced it on a hand-built stream, and
 * the first test below is that stream, verbatim.
 *
 * The fix is in two places and they are tested separately, because only one of
 * them is a guarantee:
 *
 * - **`closeTurnOnEscalation`** shuts the turn's toolset *inside* `execute`,
 *   synchronously with the escalation's own return. That is what makes "the
 *   later call never reaches the gateway" true by construction: a consumer
 *   reading a stream is always a scheduling tick behind the model, and no
 *   amount of care in the reader closes that window.
 * - **`runTurn`** stops reading and aborts the agent loop on the first tool
 *   call after the escalation, and does not put it on screen.
 *
 * What is deliberately *not* here is the end-to-end proof that nothing reaches
 * `/pre`. That belongs against a real control plane with a real audit log, and
 * it is `test/act2-resume.test.ts` → *"a model that tries a governed call
 * straight after the escalation"*.
 */
import { describe, expect, test } from "bun:test";

import { isHookDecision } from "../lib/agent/authorization.ts";
import { approvalRequested, closeTurnOnEscalation } from "../lib/agent/escalation.ts";
import type { ChatEvent } from "../lib/agent/events.ts";
import { runTurn, type Streamable } from "../lib/agent/run.ts";

const ESCALATION = "Approvals_RequestApproval";

/** The escalation's result, in the shape `@mastra/mcp` hands over. */
const ESCALATION_RESULT = {
  structuredContent: {
    request_id: "apr_demo",
    approver: "charlie@bank.example",
    approver_display_name: "Charlie",
  },
};

type Chunk = { type: string; payload?: Record<string, unknown> };

/** An agent whose `fullStream` is exactly these chunks. Records the options it was given. */
function agentOf(chunks: readonly Chunk[]): { agent: Streamable; options: Record<string, unknown>[] } {
  const options: Record<string, unknown>[] = [];
  const agent: Streamable = {
    stream(_messages, given) {
      options.push(given);
      return Promise.resolve({
        fullStream: new ReadableStream<Chunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      });
    },
  };
  return { agent, options };
}

async function drive(chunks: readonly Chunk[]): Promise<{
  events: ChatEvent[];
  logs: string[];
  options: Record<string, unknown>[];
}> {
  const { agent, options } = agentOf(chunks);
  const events: ChatEvent[] = [];
  const logs: string[] = [];
  await runTurn({
    agent,
    prompt: "x",
    requestApprovalTool: ESCALATION,
    log: (line) => logs.push(line),
    emit: (event) => {
      events.push(event);
    },
  });
  return { events, logs, options };
}

// ---------------------------------------------------------------------------

describe("the stream stops at the escalation", () => {
  test("the reviewer's repro: a later tool call is neither executed nor shown", async () => {
    // Verbatim from the round 1 finding.
    const { events, logs } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
      {
        type: "tool-call",
        payload: { toolName: "Loan_ApproveLoan", args: { loan_id: "LN-2291", amount: 95000 } },
      },
      { type: "text-delta", payload: { text: "continued" } },
    ]);

    expect(events.map((event) => event.kind)).toEqual(["tool-result", "waiting", "done"]);
    // Nothing about `Loan_ApproveLoan` reached the wire — not as a call, not as
    // a denial, not as a fault. No hook fired, so there is no decision to
    // render and the three kinds that describe a tool which did not return
    // would each be a claim nothing here can make.
    expect(JSON.stringify(events)).not.toContain("Loan_ApproveLoan");
    // It is recorded where a person debugging a turn can find it.
    expect(logs.join("\n")).toContain("Loan_ApproveLoan");
    expect(logs.join("\n")).toContain("nothing reached the gateway");
  });

  test("the abort signal reaches the agent, so the loop stops rather than detaching", async () => {
    const { options } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
      { type: "tool-call", payload: { toolName: "Loan_ApproveLoan", args: {} } },
    ]);
    const signal = options[0]?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Aborted by the time the turn is over: a pipeline left running is a
    // pipeline still free to call a tool.
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  test("an aborted turn is not reported as an error", async () => {
    const { events } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
      { type: "tool-call", payload: { toolName: "Loan_ApproveLoan", args: {} } },
    ]);
    expect(events.filter((event) => event.kind === "error")).toHaveLength(0);
    expect(events.at(-1)).toEqual({ kind: "done", calls: 0 });
  });

  test("a refusal from the turn's own toolset is dropped, not rendered", async () => {
    // What `closeTurnOnEscalation` throws arrives as a `tool-error` chunk. It
    // is not a denial — no rule ran — and not a fault — nothing broke.
    const { events, logs } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
      {
        type: "tool-error",
        payload: {
          toolName: "Loan_ApproveLoan",
          error: { message: "Loan_ApproveLoan was not called: this turn ended…" },
        },
      },
    ]);

    expect(events.map((event) => event.kind)).toEqual(["tool-result", "waiting", "done"]);
    expect(logs.join("\n")).toContain("refused by this turn's toolset");
  });
});

describe("the model still gets its last word", () => {
  test("text after the escalation streams; the sentence is the criterion", async () => {
    // Issue #20 asks for "a message naming the routed approver", and that
    // sentence is the model's *next* step — the escalation's tool result is the
    // end of the one before it. A turn that hard-stopped on the result could
    // never produce it.
    const { events } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
      { type: "text-delta", payload: { text: "Approval requested from Charlie, " } },
      { type: "text-delta", payload: { text: "VP Credit. Waiting." } },
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      "tool-result",
      "waiting",
      "text",
      "text",
      "done",
    ]);
    expect(
      events
        .filter((event): event is Extract<ChatEvent, { kind: "text" }> => event.kind === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Approval requested from Charlie, VP Credit. Waiting.");
  });

  test("the waiting event names the approver off the tool's result, not the reply", async () => {
    const { events } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: ESCALATION_RESULT } },
    ]);
    const waiting = events.find((event) => event.kind === "waiting");
    expect(waiting).toEqual({
      kind: "waiting",
      tool: ESCALATION,
      request_id: "apr_demo",
      approver: "Charlie",
      approver_id: "charlie@bank.example",
    });
  });

  test("an escalation result carrying no request id does not end the turn", async () => {
    // The tool failed in a way that still produced an object. There is nothing
    // to wait on, so the turn is an ordinary one and carries on.
    const { events } = await drive([
      { type: "tool-result", payload: { toolName: ESCALATION, result: { note: "no id here" } } },
      { type: "tool-call", payload: { toolName: "Loan_SearchLoans", args: {} } },
    ]);
    expect(events.map((event) => event.kind)).toEqual(["tool-result", "tool-call", "done"]);
  });
});

// ---------------------------------------------------------------------------
// The floor: the toolset itself
// ---------------------------------------------------------------------------

/** A tool that records every call it was actually asked to make. */
function tool(name: string, result: unknown, calls: string[]) {
  return {
    id: name,
    description: name,
    execute: (input: unknown) => {
      calls.push(`${name}(${JSON.stringify(input)})`);
      return Promise.resolve(result);
    },
  };
}

describe("the turn's toolset shuts when the escalation returns", () => {
  test("a later call never reaches the tool underneath", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      {
        [ESCALATION]: tool(ESCALATION, ESCALATION_RESULT, calls),
        Loan_ApproveLoan: tool("Loan_ApproveLoan", { ok: true }, calls),
      },
      { escalationTool: ESCALATION },
    );

    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await tools[ESCALATION]!.execute({ resource_id: "LN-2291" });
    expect(closure.closed).toBe(true);

    await expect(tools.Loan_ApproveLoan!.execute({ loan_id: "LN-2291" })).rejects.toThrow(
      /this turn ended when the approval request was raised/,
    );

    // The whole claim, in one assertion: the underlying tool was never called,
    // so nothing left this process for the gateway and `/pre` was never asked.
    expect(calls).toEqual([`${ESCALATION}({"resource_id":"LN-2291"})`]);
    expect(closure.refused).toEqual(["Loan_ApproveLoan"]);
  });

  test("before the escalation, every tool calls through as it always did", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      {
        [ESCALATION]: tool(ESCALATION, ESCALATION_RESULT, calls),
        Loan_GetLoan: tool("Loan_GetLoan", { loan_id: "LN-2291" }, calls),
      },
      { escalationTool: ESCALATION },
    );
    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;

    await tools.Loan_GetLoan!.execute({ loan_id: "LN-2291" });
    expect(closure.closed).toBe(false);
    expect(calls).toEqual(['Loan_GetLoan({"loan_id":"LN-2291"})']);
  });

  test("the escalation itself always runs, and its result is passed through unchanged", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      { [ESCALATION]: tool(ESCALATION, ESCALATION_RESULT, calls) },
      { escalationTool: ESCALATION },
    );
    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    const passed = await tools[ESCALATION]!.execute({});
    expect(passed).toEqual(ESCALATION_RESULT);
  });

  test("an escalation that returns no request id leaves the turn open", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      {
        [ESCALATION]: tool(ESCALATION, { note: "no id" }, calls),
        Loan_ApproveLoan: tool("Loan_ApproveLoan", { ok: true }, calls),
      },
      { escalationTool: ESCALATION },
    );
    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;

    await tools[ESCALATION]!.execute({});
    await tools.Loan_ApproveLoan!.execute({});
    expect(closure.closed).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("the refusal is not shaped like a hook decision", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      {
        [ESCALATION]: tool(ESCALATION, ESCALATION_RESULT, calls),
        Loan_ApproveLoan: tool("Loan_ApproveLoan", { ok: true }, calls),
      },
      { escalationTool: ESCALATION },
    );
    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await tools[ESCALATION]!.execute({});

    const thrown = await tools
      .Loan_ApproveLoan!.execute({})
      .then(() => null)
      .catch((cause: Error) => cause.message);

    // If this text ever looked like a hook's, `run.ts` would classify it as a
    // denial and the UI would assert a control-plane decision that never
    // happened — the one lie this project must not tell.
    expect(thrown).not.toBeNull();
    expect(isHookDecision(String(thrown))).toBe(false);
    expect(String(thrown)).toContain("Nothing was refused and nothing was recorded");
  });

  test("a deployment with no approvals toolkit is unaffected", async () => {
    const calls: string[] = [];
    const closure = closeTurnOnEscalation(
      { Loan_ApproveLoan: tool("Loan_ApproveLoan", { ok: true }, calls) },
      { escalationTool: ESCALATION },
    );
    const tools = closure.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await tools.Loan_ApproveLoan!.execute({});
    await tools.Loan_ApproveLoan!.execute({});
    expect(closure.closed).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("reading the escalation's result", () => {
  test("it is found through either wrapper the transport has used", () => {
    const flat = { request_id: "apr_1", approver: "charlie@bank.example" };
    expect(approvalRequested(flat)?.request_id).toBe("apr_1");
    expect(approvalRequested({ structuredContent: flat })?.request_id).toBe("apr_1");
    expect(
      approvalRequested({ content: [{ type: "text", text: JSON.stringify(flat) }] })?.request_id,
    ).toBe("apr_1");
  });

  test("anything without a request id is null, never a waiting event with an empty id", () => {
    expect(approvalRequested(null)).toBeNull();
    expect(approvalRequested("a string")).toBeNull();
    expect(approvalRequested({ request_id: "" })).toBeNull();
    expect(approvalRequested({ approver: "charlie@bank.example" })).toBeNull();
  });
});

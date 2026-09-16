/**
 * Authorization is a terminal agent outcome, not a rendering concern.
 * These tests drive the public run boundary with an adversarial stream that
 * would retry several times after an auth failure and assert the actual event
 * and abort boundary, including the wrapped toolset used by the live handler.
 */
import { describe, expect, test } from "bun:test";

import { authorizationRequired } from "../lib/agent/authorization.ts";
import type { ChatEvent } from "../lib/agent/events.ts";
import { closeTurnOnEscalation } from "../lib/agent/escalation.ts";
import { createNativeElicitationBridge } from "../lib/agent/native-elicitation.ts";
import { runTurn, type Streamable } from "../lib/agent/run.ts";

type Chunk = { type: string; payload?: Record<string, unknown> };

function agentOf(chunks: readonly Chunk[]): { agent: Streamable; signal: () => AbortSignal | undefined } {
  let options: Record<string, unknown> | undefined;
  const agent: Streamable = {
    stream(_messages, given) {
      options = given;
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
  return {
    agent,
    signal: () => options?.abortSignal as AbortSignal | undefined,
  };
}

const legacyChallenge = JSON.stringify({
  authorization_url: "https://provider.example/authorize/request-1",
  llm_instructions: "Tell the user to authorize, then try again.",
});

const nativeRequest = {
  mode: "url",
  message: "Authorize the provider, then continue.",
  url: "https://provider.example/consent/request-1",
  elicitationId: "elicitation-1",
} as const;

async function drive(
  chunks: readonly Chunk[],
  options: {
    nativeElicitation?: ReturnType<typeof createNativeElicitationBridge>;
    onAuthorization?: () => void;
  } = {},
): Promise<{ events: ChatEvent[]; signal: AbortSignal | undefined }> {
  const scripted = agentOf(chunks);
  const events: ChatEvent[] = [];
  await runTurn({
    agent: scripted.agent,
    prompt: "read the loan",
    emit: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { events, signal: scripted.signal() };
}

describe("authorization pauses the actual agent turn", () => {
  test("legacy layer-2 auth emits one card, aborts, and never consumes the retry", async () => {
    const { events, signal } = await drive([
      { type: "tool-call", payload: { toolName: "Loan_GetLoan", args: { loan_id: "LN-2291" } } },
      { type: "tool-error", payload: { toolName: "Loan_GetLoan", error: { message: legacyChallenge } } },
      { type: "tool-call", payload: { toolName: "Loan_GetLoan", args: { loan_id: "LN-2291" } } },
      { type: "tool-error", payload: { toolName: "Loan_GetLoan", error: { message: legacyChallenge } } },
      { type: "text-delta", payload: { text: "Please authorize and retry." } },
    ]);

    expect(events.map((event) => event.kind)).toEqual(["tool-call", "authorization", "done"]);
    expect(events.filter((event) => event.kind === "authorization")).toHaveLength(1);
    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  test("native elicitation/create closes queued tool dispatches at the protocol boundary", async () => {
    const outbound: string[] = [];
    const closure = closeTurnOnEscalation(
      {
        Loan_GetLoan: {
          execute: async (input: unknown) => {
            outbound.push(JSON.stringify(input));
            return { loan_id: "LN-2291" };
          },
        },
      },
      { escalationTool: "Approvals_RequestApproval" },
    );
    const bridge = createNativeElicitationBridge({ onRequest: closure.close });
    const { events } = await drive(
      [
        { type: "tool-error", payload: { toolName: "Loan_GetLoan", error: { code: -32042, data: { elicitations: [nativeRequest] } } } },
        { type: "tool-call", payload: { toolName: "Loan_GetLoan", args: { loan_id: "LN-2291" } } },
        { type: "text-delta", payload: { text: "Try another call." } },
      ],
      { nativeElicitation: bridge, onAuthorization: closure.close },
    );

    expect(events.map((event) => event.kind)).toEqual(["authorization", "done"]);
    expect(events.filter((event) => event.kind === "authorization")).toHaveLength(1);
    await expect(
      (closure.tools.Loan_GetLoan as { execute: (input: unknown) => Promise<unknown> }).execute({ loan_id: "LN-2291" }),
    ).rejects.toThrow(/turn ended/);
    expect(outbound).toEqual([]);
  });

  test("structured -32042 without a URL still pauses with an explicit continuation", async () => {
    expect(authorizationRequired({ code: -32042 })).toEqual({});
    const { events } = await drive([
      { type: "tool-error", payload: { toolName: "Loan_GetLoan", error: { code: -32042 } } },
      { type: "tool-call", payload: { toolName: "Loan_GetLoan", args: {} } },
    ]);

    expect(events.map((event) => event.kind)).toEqual(["authorization", "done"]);
    expect(events[0]).toEqual({ kind: "authorization", tool: "Loan_GetLoan" });
  });
});

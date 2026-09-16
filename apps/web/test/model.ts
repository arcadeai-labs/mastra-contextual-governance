/**
 * The model seam: scripted when there is no `ANTHROPIC_API_KEY`, real Claude
 * Sonnet 5 at temperature 0 when there is.
 *
 * ## Why a seam at all
 *
 * Three of #14's acceptance criteria are claims about what the *model* does —
 * it reports the hook's reason, it does not retry, it approves when it is
 * allowed to. Those need a real completion. The other seven are claims about
 * the chain the model sits in, and that chain is identical either way: real
 * `/pre`, real `loans.db`, real MCP transport, real session. So the suite runs
 * the whole thing on a machine with no key and runs it again with one, and says
 * out loud which it did.
 *
 * **The scripted model is not a mock of the unit under test.** The unit under
 * test is the governed chain; the model is the adversary at one end of it, and
 * this file is a stand-in for the adversary. What a scripted run proves is
 * exactly:
 *
 *   - the call reaches `/pre` as the signed-in persona,
 *   - the hook's message crosses the transport into the model's *next prompt*,
 *     verbatim (`ScriptedModel.prompts` is what that is read off — the text the
 *     model was actually handed, not the text we streamed to the screen),
 *   - a tool that is denied writes no row in `loans.db`,
 *   - a tool that is allowed writes one, attributed to that persona.
 *
 * What it cannot prove is that Claude, given that text, says the right thing
 * and stops. Only the real model proves that, and a scripted run says so rather
 * than implying otherwise.
 *
 * ## The interface
 *
 * `LanguageModelV4` — `specificationVersion: 'v4'`, which is what
 * `@ai-sdk/anthropic@4` reports and what `@mastra/core` adapts. Only `doStream`
 * is implemented, because that is the only method `agent.stream()` reaches;
 * `doGenerate` throws rather than returning something plausible, so a future
 * caller that needs it finds out immediately.
 */

/** One scripted tool call in a model response. */
export interface ScriptedCall {
  call: string;
  input: Record<string, unknown>;
}

/** One scripted turn: one or more tool calls, or a final answer. */
export type Turn =
  | ({ call: string; input: Record<string, unknown>; before?: string } & { calls?: never })
  | { calls: readonly ScriptedCall[]; before?: string }
  | { say: string };

export interface ScriptedModel {
  /** Hand to `buildAgent({ model })`. Typed loosely — the provider spec is the contract. */
  model: unknown;
  /** Every prompt the model was handed, in order. The evidence that text crossed intact. */
  prompts: unknown[][];
  /** Turns actually consumed. Fewer than scripted means the loop stopped early. */
  used: number;
}

/**
 * A model that plays a fixed script.
 *
 * Running past the end of the script is a deliberate, loud failure rather than
 * a shrug: a run that needed a turn the author did not write is a run whose
 * result means nothing, and emitting a bland "done" here would turn that into a
 * passing test.
 */
export function scriptedModel(turns: readonly Turn[], modelId = "scripted"): ScriptedModel {
  const state: ScriptedModel = { model: null, prompts: [], used: 0 };

  state.model = {
    specificationVersion: "v4",
    provider: "cg-test",
    modelId,
    supportedUrls: {},
    doGenerate() {
      throw new Error("the scripted model only implements doStream; agent.stream() is what this suite uses");
    },
    doStream(options: { prompt: unknown[] }) {
      // The whole point of the recording: `prompt` is the conversation as the
      // model receives it, tool results included. A denial that never reached
      // here never reached a real model either.
      state.prompts.push(options.prompt);

      const turn = turns[state.used];
      state.used += 1;
      if (turn === undefined) {
        throw new Error(
          `the script has ${turns.length} turns and the agent asked for ${state.used}. ` +
            `Either the agent looped, or the script is short.`,
        );
      }

      const id = `scripted-${state.used}`;
      const prefix: Array<Record<string, unknown>> =
        "before" in turn && turn.before !== undefined
          ? [
              { type: "text-start", id: `${id}-before` },
              { type: "text-delta", id: `${id}-before`, delta: turn.before },
              { type: "text-end", id: `${id}-before` },
            ]
          : [];
      const calls: readonly ScriptedCall[] =
        "calls" in turn ? turn.calls : "call" in turn ? [{ call: turn.call, input: turn.input }] : [];
      const say = "say" in turn ? turn.say : "";
      const parts: Array<Record<string, unknown>> =
        calls.length > 0
          ? [
              ...calls.flatMap((call, index) => {
                const callId = `${id}-${index + 1}`;
                return [
                  { type: "tool-input-start", id: callId, toolName: call.call },
                  // The deltas are not decoration. Mastra builds the streaming
                  // `tool-call` chunk's `args` by accumulating them, so a scripted
                  // model that jumped straight to `tool-call` produced a chunk with
                  // `args: {}` — and a test asserting on what the page shows would
                  // have been asserting on the fixture's silence. Measured while
                  // building this suite.
                  { type: "tool-input-delta", id: callId, delta: JSON.stringify(call.input) },
                  { type: "tool-input-end", id: callId },
                  { type: "tool-call", toolCallId: callId, toolName: call.call, input: JSON.stringify(call.input) },
                ];
              }),
              { type: "finish", finishReason: "tool-calls", usage: USAGE },
            ]
          : [
              { type: "text-start", id },
              { type: "text-delta", id, delta: say },
              { type: "text-end", id },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ];

      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "response-metadata", id, modelId, timestamp: new Date() });
            for (const part of [...prefix, ...parts]) controller.enqueue(part);
            controller.close();
          },
        }),
      });
    },
  };

  return state;
}

const USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * Every prompt part's text, flattened — including tool results, which is where
 * a hook's message lands.
 *
 * Walks the structure rather than assuming one shape, because a tool result's
 * `output` has been `{ type: 'text', value }`, `{ type: 'error-text', value }`
 * and `{ type: 'json', value }` depending on how the failure arrived. The
 * question being asked is "did this string reach the model at all", and the
 * honest way to answer it is to look everywhere.
 */
export function promptText(prompts: readonly unknown[][]): string {
  const seen: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      seen.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(prompts as unknown);
  return seen.join("\n");
}

/**
 * Whether this run uses the real model.
 *
 * Read once, here, so every test agrees and the suite can print which mode it
 * is in. An empty string is "absent": `ANTHROPIC_API_KEY=` in a `.env.local` is
 * a variable somebody meant to fill in, not a key.
 *
 * ⚠️ **`bun test` sets `NODE_ENV=test`, and Bun does not load `.env.local`
 * under that.** A key in `apps/web/.env.local` never reaches this function and
 * the suite reports `SCRIPTED` while looking configured — which is why the mode
 * is printed rather than assumed. Pass it on the command line:
 * `ANTHROPIC_API_KEY=… bun test --cwd apps/web test/tracer-bullet.test.ts`.
 */
export function liveModelKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

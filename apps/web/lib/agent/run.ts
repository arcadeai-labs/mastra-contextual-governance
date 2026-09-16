/**
 * One turn: prompt in, `ChatEvent`s out.
 *
 * The whole governed chain hangs off this function, and the order it runs in is
 * the order `DESIGN.md` → Identity and OAuth draws:
 *
 *     this browser's session  →  gateway token  →  MCPClient (static bearer)
 *       →  api.arcade.dev/mcp/cg-demo-us  →  /access, /pre  →  tools/loan
 *         →  apps/loan-app
 *
 * What this file is careful about is what it does *not* do to what comes back.
 *
 * **The remediation text is not rewritten.** A hook denial's message is read
 * out of the failed tool call and streamed as it was written, minus Arcade's
 * undocumented prefix. No summarising, no re-wording, no "the tool was blocked
 * because…". Both the model and the person see the rule author's sentence,
 * which is the claim the demo is making.
 *
 * **A tool that failed is not the same as a tool that was refused.** Three
 * different things arrive as one chunk type and they are separated by reading
 * the text, never by the fact of failure: a hook decision, a layer-2
 * authorization challenge, and plumbing. Round 1 of #88's review found the
 * third rendering as the first.
 *
 * **Retrying is not this code's decision.** There is no retry loop here and no
 * back-off. If the model calls the same denied tool twice, that is the model
 * doing it and the stream will show two `denied` events — which is the thing
 * #14 exists to measure. A wrapper that swallowed the second call would make
 * the acceptance criterion unfalsifiable.
 *
 * **Nothing here waits for an approval, and the turn really does end.** #20's
 * `waiting` event is emitted after `Approvals_RequestApproval` returns, and
 * from that point the turn is *closing*: the model's last words still stream —
 * *"Approval requested from Charlie, VP Credit. Waiting."* is what the issue
 * asks for by name — but the first tool call after it ends the reading and
 * aborts the agent loop.
 *
 * Round 1 of #110's review found this half-done: `waiting` was emitted and the
 * loop carried on, so a model that called `Loan_ApproveLoan` straight after the
 * escalation got that call executed, against a control plane holding no grant.
 * The guarantee is not here — it is in `escalation.ts`, which shuts the turn's
 * toolset synchronously with the escalation's own return, so a later call
 * cannot reach the gateway whatever this loop is doing. What this file adds is
 * that the loop stops and the refused call never appears on screen: no hook
 * fired, so there is no decision to render, and the three kinds that describe a
 * tool which did not return would each be a claim nothing here can make.
 *
 * There is no poll, no long-poll and no sleep in this file, and there must not
 * be: `DESIGN.md` → The wait, and the issue says why in two ways — a visibly
 * spinning agent contradicts the "won't spin and waste your tokens" line the
 * demo is built on, and a long-polling tool call would hit gateway timeouts in
 * the least debuggable way possible, live. The resume is a *new* turn, started
 * by the UI when the decision arrives on the governance stream.
 *
 * **`maxSteps` is a ceiling, not a policy.** It stops a runaway from costing
 * money, and it is set well above the two or three steps this demo needs so
 * that a model which *does* spin hits it visibly rather than being quietly
 * capped at one call.
 */
import { authorizationRequired, isHookDecision, remediationText } from "./authorization.ts";
import { approvalRequested } from "./escalation.ts";
import { CORRELATION_TOKEN } from "../governance/correlation.ts";
import type { ChatEvent } from "./events.ts";
import { readNativeUrlElicitations, type NativeElicitationBridge, type NativeUrlElicitation } from "./native-elicitation.ts";

/** The ceiling on tool calls in one turn. High enough that a spin is visible as a spin. */
export const MAX_STEPS = 8;

/** Temperature 0, on every run. `DESIGN.md` → Model. */
export const TEMPERATURE = 0;

/** Anything with the `stream` method an agent has. Narrow on purpose — this file uses one method. */
export interface Streamable {
  stream(
    messages: string | readonly TurnMessage[],
    options: Record<string, unknown>,
  ): Promise<{ fullStream: ReadableStream<{ type: string; payload?: Record<string, unknown> }> }>;
}

/**
 * The audit row id the control plane embedded in the message (#6), or `null`.
 *
 * Fails soft, as `correlation.ts` requires: a message with no token is an
 * uncorrelated denial, never a dropped one.
 */
export function correlationRef(message: string): string | null {
  return CORRELATION_TOKEN.exec(message)?.[1] ?? null;
}

/**
 * The text out of whatever a failed tool call carried.
 *
 * Measured against `@mastra/mcp` 1.17 on 2026-09-12. A spec-compliant
 * `isError: true` MCP result reaches `fullStream` as a **`tool-error`** chunk —
 * not a `tool-result` with a flag — and the server's own text sits at
 * `payload.error.cause.message`:
 *
 *     { error: { name: "Error",
 *                cause: { message: "Tool execution was denied by an extension policy: DENIED: …",
 *                         code: "MCP_CLIENT_TOOL_EXECUTION_FAILED", … },
 *                details: { errorMessage: "<the same, as JSON>" } },
 *       toolName, args, toolCallId }
 *
 * So `cause.message` is read first, then `message`, then the MCP `content`
 * array, then the whole thing as JSON. The fallbacks are not defensive
 * padding — this is the string the entire demo rests on, and returning `""`
 * because a wrapper moved would put a refusal on screen with no reason on it.
 * Something true beats nothing.
 */
export function failureText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return String(result);

  const body = result as Record<string, unknown>;
  const cause = body.cause;
  if (typeof cause === "object" && cause !== null && typeof (cause as { message?: unknown }).message === "string") {
    return (cause as { message: string }).message;
  }
  if (typeof body.message === "string") return body.message;
  if (Array.isArray(body.content)) {
    const text = body.content
      .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    if (text !== "") return text;
  }
  if (typeof body.error === "string") return body.error;
  return JSON.stringify(result);
}

export interface RunOptions {
  agent: Streamable;
  /** The turn, as one prompt or as a conversation ending in one (#20's resume). */
  prompt: string | readonly TurnMessage[];
  maxSteps?: number;
  /**
   * The wire name of the escalation tool — `Approvals_RequestApproval` — so a
   * successful call to it can be recognised and reported as `waiting`.
   *
   * Passed in rather than hard-coded because the toolkit name is an
   * environment variable measured off a real deployment (`ARCADE_APPROVALS_TOOLKIT`),
   * and this file is the wrong place to have an opinion about it. Unset, the
   * run behaves exactly as it did before #20: every tool result is a
   * `tool-result` and nothing else.
   */
  requestApprovalTool?: string;
  /**
   * Where a tool call made after the turn had already ended is recorded.
   *
   * Not an event: no hook fired, nothing was denied and nothing broke, so the
   * three kinds that describe a tool which did not return would each be a claim
   * this one cannot make (`events.ts`). It goes to the server log, where a
   * person debugging a turn can find it, and nowhere else.
   */
  log?: (line: string) => void;
  /** Fires for every event, in order. The caller writes them to the wire. */
  emit: (event: ChatEvent) => void | Promise<void>;
  /** Native MCP URL requests captured for this chat request only. */
  nativeElicitation?: NativeElicitationBridge;
  /** Close the turn's tool boundary before any queued dispatch can start. */
  onAuthorization?: () => void;
}

/** One message in a conversation handed to the agent. Mastra takes an array of these. */
export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Drive one turn and emit events as they happen.
 *
 * Resolves when the stream is exhausted. It does not throw: a failure mid-turn
 * is an `error` event followed by `done`, because a chat that ends with a
 * closed socket and no explanation is the same as a panel that stays dark.
 */
export async function runTurn(options: RunOptions): Promise<void> {
  const emit = options.emit;
  let calls = 0;

  /**
   * Ends the agent loop from here.
   *
   * Aborting is the *first* of two things the escalation does, and the one that
   * matters: it stops Mastra before the next step, so the model is never asked
   * again and no further tool is executed. Breaking out of the loop below only
   * stops us reading — on its own it would leave the agent running in a
   * detached pipeline, still free to call `Loan_ApproveLoan` against a control
   * plane that has no grant yet. Round 1 of this PR's review reproduced exactly
   * that: a later `tool-call` after the `waiting` event.
   */
  const endOfTurn = new AbortController();
  /** Set when the escalation ended the turn, so an abort is not reported as a failure. */
  let endedOnEscalation = false;
  /** Set on the first authorization challenge; auth is a terminal turn outcome. */
  let endedOnAuthorization = false;
  /**
   * True from the escalation's result onwards: the turn is over and only its
   * closing words are still welcome.
   *
   * Text still streams — the model's last step is where *"Approval requested
   * from Charlie, VP Credit. Waiting."* comes from, and issue #20 asks for
   * that sentence by name. What does not is another tool call, and the first
   * one ends the reading here. It cannot execute in any case
   * (`closeTurnOnEscalation` shut the toolset the moment the escalation
   * returned); this is what keeps it off the screen and stops the loop.
   */
  let closing = false;

  const endOnAuthorization = async (
    tool: string,
    authorization: { url?: string; instructions?: string; mode?: "url"; elicitation_id?: string },
  ): Promise<void> => {
    if (endedOnAuthorization) return;
    endedOnAuthorization = true;
    // Close the wrapped tools before publishing the card. The callback is also
    // fired by the native MCP handler itself, which covers queued dispatches
    // that begin before this stream consumer sees the protocol error.
    options.onAuthorization?.();
    endOfTurn.abort();
    await emit({ kind: "authorization", tool, ...authorization });
  };

  const takeNativeAuthorization = (tool: string): NativeUrlElicitation | null => {
    const request = options.nativeElicitation?.take()?.[0] ?? null;
    if (request === null) return null;
    return request;
  };

  try {
    const result = await options.agent.stream(options.prompt, {
      maxSteps: options.maxSteps ?? MAX_STEPS,
      modelSettings: { temperature: TEMPERATURE },
      abortSignal: endOfTurn.signal,
    });

    for await (const chunk of streamOf(result.fullStream)) {
      const payload = (chunk.payload ?? {}) as Record<string, unknown>;

      if (chunk.type === "text-delta") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text !== "") await emit({ kind: "text", text });
        continue;
      }

      if (chunk.type === "tool-call") {
        const tool = String(payload.toolName ?? "unknown");
        if (closing) {
          // Asked for after the turn ended. The toolset already refused to run
          // it, so nothing reached the gateway and no hook was asked anything;
          // putting it on screen as a call that happened would be the UI
          // narrating an action the system declined to take.
          options.log?.(
            `[chat] ${tool} was asked for after the turn ended on the approval request; ` +
              `the turn's toolset refused it and nothing reached the gateway`,
          );
          endedOnEscalation = true;
          endOfTurn.abort();
          break;
        }
        calls += 1;
        await emit({
          kind: "tool-call",
          tool,
          inputs: (payload.args ?? {}) as Record<string, unknown>,
        });
        continue;
      }

      if (chunk.type === "tool-result") {
        const tool = String(payload.toolName ?? "unknown");
        if (closing) {
          endedOnEscalation = true;
          endOfTurn.abort();
          break;
        }
        // Some gateways return a canceled native request as a normal-shaped
        // result. Consume the bridge before calling it a successful result.
        const nativeResult = takeNativeAuthorization(tool);
        if (nativeResult !== null) {
          await endOnAuthorization(tool, {
            url: nativeResult.url,
            instructions: nativeResult.message,
            mode: nativeResult.mode,
            elicitation_id: nativeResult.elicitationId,
          });
          break;
        }
        const authorizationResult = authorizationRequired(payload.result);
        if (authorizationResult !== null) {
          await endOnAuthorization(tool, authorizationResult);
          break;
        }
        await emit({ kind: "tool-result", tool });

        // The escalation landed, so **the turn is over**. Nothing waits for the
        // decision; the page is given the request id so it can recognise the
        // decision when it comes down the governance stream as *this* browser's
        // rather than somebody else's, and the next turn is a new one.
        //
        // Ending here is the acceptance criterion, not a tidiness: a turn that
        // carried on could call `Loan_ApproveLoan` again while the approval is
        // still pending, which is a governed write attempted on an authority
        // nobody has granted yet. The hook would refuse it — that is what the
        // hook is for — but the demo's claim is that the *agent stops*, and an
        // extra denial on the panel between the escalation and the resume says
        // the opposite of what act 2 is about.
        if (options.requestApprovalTool !== undefined && tool === options.requestApprovalTool) {
          const requested = approvalRequested(payload.result);
          if (requested !== null) {
            await emit({ kind: "waiting", tool, ...requested });
            closing = true;
          }
        }
        continue;
      }

      // The branch the demo is about. A hook denial, a layer-2 challenge and an
      // unreachable loan book all arrive here — one chunk type, three very
      // different claims about the world — so they are told apart by reading
      // the text, and nothing is assumed from the fact that a tool failed.
      if (chunk.type === "tool-error") {
        const tool = String(payload.toolName ?? "unknown");
        if (closing) {
          // The turn's own toolset refusing a call it was asked for after the
          // escalation. Neither a denial nor a fault: no rule ran, nothing
          // broke, and nothing was recorded anywhere.
          options.log?.(
            `[chat] ${tool} was refused by this turn's toolset after the turn ended on the ` +
              `approval request; nothing reached the gateway`,
          );
          endedOnEscalation = true;
          endOfTurn.abort();
          break;
        }
        // Native URL mode is distinct from Arcade layer-2 authorization: it
        // carries a URL request (or protocol error -32042), not an
        // authorization_url JSON instruction. Surface it through the same
        // explicit card, then let the user start a fresh retry.
        const nativeRequest = takeNativeAuthorization(tool);
        if (nativeRequest !== null) {
          await endOnAuthorization(tool, {
            url: nativeRequest.url,
            instructions: nativeRequest.message,
            mode: nativeRequest.mode,
            elicitation_id: nativeRequest.elicitationId,
          });
          break;
        }
        const nativeFromError = readNativeUrlElicitations(payload.error ?? payload);
        if (nativeFromError.length > 0) {
          const [request] = nativeFromError;
          if (request !== undefined) {
            await endOnAuthorization(tool, {
              url: request.url,
              instructions: request.message,
              mode: request.mode,
              elicitation_id: request.elicitationId,
            });
          }
          break;
        }
        const rawFailure = payload.error ?? payload;
        const text = failureText(rawFailure);

        // Layer 2 first: it arrives in the same `isError` envelope as a hook
        // denial and is not one. See `authorization.ts`.
        const authorization = authorizationRequired(rawFailure) ?? authorizationRequired(text);
        if (authorization) {
          await endOnAuthorization(tool, authorization);
          break;
        }

        // Then a denial, but only on positive evidence that a hook made a
        // decision. Everything else is plumbing, and saying "denied by the
        // control plane" about a socket error is the one lie this UI must not
        // tell — see `isHookDecision`.
        if (!isHookDecision(text)) {
          await emit({ kind: "fault", tool, message: text });
          continue;
        }

        const reason = remediationText(text);
        await emit({ kind: "denied", tool, reason, ref: correlationRef(reason) });
        continue;
      }

      // A failure of the run itself, not of a tool: the model refused, the
      // provider errored, the stream broke. Never a governance decision.
      if (chunk.type === "error") {
        await emit({ kind: "error", message: failureText(payload.error ?? payload) });
      }
    }
  } catch (cause) {
    // An abort we asked for is not a failure. Anything else is, and says so.
    if (!endedOnEscalation && !endedOnAuthorization) {
      await emit({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  // A wrapper may expose the request only after the tool error has been
  // emitted; still make one captured URL visible before done. The first
  // challenge is the terminal event and duplicate requests are discarded.
  const trailingNative = takeNativeAuthorization("unknown");
  if (trailingNative !== null) {
    await endOnAuthorization("unknown", {
      url: trailingNative.url,
      instructions: trailingNative.message,
      mode: trailingNative.mode,
      elicitation_id: trailingNative.elicitationId,
    });
  }

  await emit({ kind: "done", calls });
}

/** `for await` over a web `ReadableStream`, which Node's typings do not make iterable. */
async function* streamOf<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        return;
      }
      if (value !== undefined) yield value;
    }
  } finally {
    // A consumer that stopped early — the escalation ending the turn — has to
    // *cancel*, not merely let go. Releasing the lock leaves the producer
    // running with nobody reading it; cancelling propagates back through the
    // pipeline. Skipped when the stream ended on its own, where cancelling an
    // already-closed stream is a no-op with a rejection attached.
    if (!drained) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

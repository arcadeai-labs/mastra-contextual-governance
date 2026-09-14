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
 * **Nothing here waits for an approval.** #20's `waiting` event is a marker
 * emitted after `Approvals_RequestApproval` returns, and the turn then ends
 * like any other. There is no poll, no long-poll and no sleep in this file, and
 * there must not be: `DESIGN.md` → The wait says the agent ends its turn, and
 * the issue says why in two ways — a visibly spinning agent contradicts the
 * "won't spin and waste your tokens" line the demo is built on, and a
 * long-polling tool call would hit gateway timeouts in the least debuggable way
 * possible, live. The resume is a *new* turn, started by the UI when the
 * decision arrives on the governance stream.
 *
 * **`maxSteps` is a ceiling, not a policy.** It stops a runaway from costing
 * money, and it is set well above the two or three steps this demo needs so
 * that a model which *does* spin hits it visibly rather than being quietly
 * capped at one call.
 */
import { authorizationRequired, isHookDecision, remediationText } from "./authorization.ts";
import { CORRELATION_TOKEN } from "../governance/correlation.ts";
import type { ChatEvent } from "./events.ts";

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
  /** Fires for every event, in order. The caller writes them to the wire. */
  emit: (event: ChatEvent) => void | Promise<void>;
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

  try {
    const result = await options.agent.stream(options.prompt, {
      maxSteps: options.maxSteps ?? MAX_STEPS,
      modelSettings: { temperature: TEMPERATURE },
    });

    for await (const chunk of streamOf(result.fullStream)) {
      const payload = (chunk.payload ?? {}) as Record<string, unknown>;

      if (chunk.type === "text-delta") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text !== "") await emit({ kind: "text", text });
        continue;
      }

      if (chunk.type === "tool-call") {
        calls += 1;
        await emit({
          kind: "tool-call",
          tool: String(payload.toolName ?? "unknown"),
          inputs: (payload.args ?? {}) as Record<string, unknown>,
        });
        continue;
      }

      if (chunk.type === "tool-result") {
        const tool = String(payload.toolName ?? "unknown");
        await emit({ kind: "tool-result", tool });

        // The escalation landed. Nothing here waits for it — the turn ends the
        // way every turn ends — but the page needs the request id to recognise
        // the decision when it comes down the governance stream as *this*
        // browser's rather than somebody else's. See `events.ts` → `waiting`.
        if (options.requestApprovalTool !== undefined && tool === options.requestApprovalTool) {
          const requested = approvalRequested(payload.result);
          if (requested !== null) await emit({ kind: "waiting", tool, ...requested });
        }
        continue;
      }

      // The branch the demo is about. A hook denial, a layer-2 challenge and an
      // unreachable loan book all arrive here — one chunk type, three very
      // different claims about the world — so they are told apart by reading
      // the text, and nothing is assumed from the fact that a tool failed.
      if (chunk.type === "tool-error") {
        const tool = String(payload.toolName ?? "unknown");
        const text = failureText(payload.error ?? payload);

        // Layer 2 first: it arrives in the same `isError` envelope as a hook
        // denial and is not one. See `authorization.ts`.
        const authorization = authorizationRequired(text);
        if (authorization) {
          await emit({
            kind: "authorization",
            tool,
            url: authorization.url,
            ...(authorization.instructions ? { instructions: authorization.instructions } : {}),
          });
          continue;
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
    await emit({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
  }

  await emit({ kind: "done", calls });
}

/**
 * The request id and the routed approver out of whatever
 * `Approvals_RequestApproval` returned, or `null` when it carried neither.
 *
 * Written the way `failureText` is, and for the same reason: an MCP tool result
 * reaches here through two wrappers, and which one is on top has changed with
 * the transport. The tool's own return value is a flat object
 * (`tools/approvals/approvals/__init__.py`), but it arrives as `content: [{
 * type: "text", text: "<json>" }]` alongside `structuredContent`, and Mastra
 * may hand over either. So all three are looked at, in order, and a shape
 * carrying no `request_id` yields `null` rather than a `waiting` event with an
 * empty id — a UI holding a turn open on an id nobody minted would never
 * resume and would never say why.
 *
 * `approver` is a display name when there is one and the address when there is
 * not; it is for the reader, and the resume matches on `request_id`.
 */
export function approvalRequested(result: unknown): { request_id: string; approver: string } | null {
  for (const candidate of unwrapResult(result)) {
    const id = candidate["request_id"];
    if (typeof id !== "string" || id === "") continue;
    const approver = candidate["approver_display_name"] ?? candidate["approver"];
    return { request_id: id, approver: typeof approver === "string" ? approver : "" };
  }
  return null;
}

/** Every object a tool result might be, outermost first. */
function unwrapResult(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== "object" || result === null) return [];
  const body = result as Record<string, unknown>;
  const found: Array<Record<string, unknown>> = [body];

  const structured = body["structuredContent"];
  if (typeof structured === "object" && structured !== null) {
    found.push(structured as Record<string, unknown>);
  }

  if (Array.isArray(body["content"])) {
    for (const part of body["content"] as unknown[]) {
      const text =
        typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined;
      if (typeof text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          found.push(parsed as Record<string, unknown>);
        }
      } catch {
        continue;
      }
    }
  }

  return found;
}

/** `for await` over a web `ReadableStream`, which Node's typings do not make iterable. */
async function* streamOf<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

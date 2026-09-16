/**
 * Reading `Approvals_RequestApproval`'s result, and closing the turn on it.
 *
 * Two consumers, which is why this is its own module rather than part of
 * either: `run.ts` reads the result to emit `waiting`, and `tools.ts` reads it
 * to shut the turn's toolset. They must agree on what "the escalation
 * succeeded" means, and a second copy of that judgement in the other file is
 * the kind of drift this repo keeps paying for.
 *
 * ## The turn ends, and "ends" is enforced twice
 *
 * `DESIGN.md` → The wait: the agent ends its turn on the escalation. Round 1 of
 * #110's review found that it did not — `run.ts` emitted `waiting` and carried
 * on reading, so a model that called `Loan_ApproveLoan` straight after
 * `Approvals_RequestApproval` got that call executed, against a control plane
 * that had no grant yet.
 *
 * The fix is in two places on purpose, because only one of them is a guarantee:
 *
 * 1. **The floor, here.** {@link closeTurnOnEscalation} wraps the turn's tools.
 *    The moment `Approvals_RequestApproval` *returns a request id*, the turn is
 *    shut, and every later `execute` in that turn throws without calling
 *    through. That is synchronous with the escalation's own execution, so there
 *    is no window: nothing reaches the gateway, `/pre` is never asked, and the
 *    audit log has nothing to show. "Never reaches `/pre`" is true by
 *    construction rather than by timing.
 * 2. **The tidy-up, in `run.ts`.** The consumer stops reading and aborts the
 *    agent loop when it sees a tool call after the escalation, so the turn ends
 *    promptly rather than grinding through steps that can no longer do
 *    anything.
 *
 * The model is told none of this. Nothing about the closure appears in the
 * system prompt or in a tool description — it is host-side machinery, the same
 * category as `maxSteps`, and `DESIGN.md` → No model-side controls is exactly
 * the rule that would be broken by explaining it to the model instead.
 *
 * ## What the refusal is *not*
 *
 * It is not a hook decision. No rule ran, nothing was denied, and no audit row
 * exists — so it must never reach the screen as a `denied`, and it is not a
 * `fault` either, because nothing broke. `run.ts` drops the event entirely and
 * logs it; the turn's `waiting` card already says the turn is over.
 */

/** What the escalation's result carries, when it carries anything usable. */
export interface ApprovalRequested {
  request_id: string;
  /** Display name when the tool gave one, the address when it did not. */
  approver: string;
  /** The routed approver's address, for the card and for nothing else. */
  approver_id: string;
}

/**
 * The request id and the routed approver out of whatever
 * `Approvals_RequestApproval` returned, or `null` when it carried neither.
 *
 * Written the way `failureText` is, and for the same reason: an MCP tool result
 * reaches a consumer through two wrappers, and which one is on top has changed
 * with the transport. The tool's own return value is a flat object
 * (`tools/approvals/approvals/__init__.py`), but it arrives as `content: [{
 * type: "text", text: "<json>" }]` alongside `structuredContent`, and Mastra
 * may hand over either. So all three are looked at, in order, and a shape
 * carrying no `request_id` yields `null` rather than a `waiting` event with an
 * empty id — a UI holding a turn open on an id nobody minted would never resume
 * and would never say why.
 *
 * **There is no role here**, and that is a gap rather than an omission: the
 * deployed toolkit's return value has `approver`, `approver_display_name`,
 * `required_clearance` and `candidate_approvers`, and no role at all. Inventing
 * one from the name would be the card asserting something nothing measured.
 */
export function approvalRequested(result: unknown): ApprovalRequested | null {
  for (const candidate of unwrapResult(result)) {
    const id = candidate["request_id"];
    if (typeof id !== "string" || id === "") continue;
    const address = candidate["approver"];
    const display = candidate["approver_display_name"];
    const approverId = typeof address === "string" ? address : "";
    return {
      request_id: id,
      approver: typeof display === "string" && display !== "" ? display : approverId,
      approver_id: approverId,
    };
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

/** Anything with an `execute`. Narrow on purpose — that is the one thing wrapped. */
interface Executable {
  execute?: (...args: unknown[]) => unknown;
}

export interface TurnClosure {
  /** The same tools, with the turn boundary enforced inside `execute`. */
  tools: Record<string, unknown>;
  /** True once the escalation or an authorization challenge has ended the turn. */
  readonly closed: boolean;
  /** Wire names refused because the turn was already over, in call order. */
  readonly refused: readonly string[];
  /** Close the turn synchronously when a non-escalation terminal outcome arrives. */
  close: () => void;
}

/**
 * The turn's toolset, shut the moment the escalation succeeds.
 *
 * The wrapper on the escalation tool closes the turn **after** its own call
 * resolves, so the escalation itself always runs; the wrapper on every other
 * tool refuses once the turn is shut, before calling through. Both live inside
 * `execute`, which is the only place with no gap between "the escalation
 * returned" and "the model asked for something else" — a consumer reading a
 * stream is always one scheduling tick behind that.
 *
 * A refused call throws. It has to: a tool that resolved with a message would
 * hand the model a success-shaped object, and the model would carry on
 * believing it had written to the loan book. What the throw produces upstream —
 * a `tool-error` chunk — is dropped by `run.ts` rather than rendered, because
 * nothing decided anything and nothing broke.
 *
 * `escalationTool` may be absent from `tools` (a deployment with no approvals
 * toolkit); then nothing is ever closed and every tool behaves as before.
 */
export function closeTurnOnEscalation(
  tools: Record<string, unknown>,
  options: {
    /** The wire name, e.g. `Approvals_RequestApproval`. */
    escalationTool: string;
    /** Fired once, with the escalation's own result, when the turn shuts. */
    onClose?: (requested: ApprovalRequested) => void;
    /** Fired for each tool call refused because the turn was already over. */
    onRefused?: (tool: string) => void;
  },
): TurnClosure {
  const refused: string[] = [];
  const state = { closed: false };
  const wrapped: Record<string, unknown> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const executable = tool as Executable;
    if (typeof executable.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const call = executable.execute.bind(tool);

    wrapped[name] =
      name === options.escalationTool
        ? {
            ...(tool as object),
            async execute(...args: unknown[]) {
              const result = await call(...args);
              const requested = approvalRequested(result);
              if (requested !== null && !state.closed) {
                state.closed = true;
                options.onClose?.(requested);
              }
              return result;
            },
          }
        : {
            ...(tool as object),
            async execute(...args: unknown[]) {
              if (state.closed) {
                refused.push(name);
                options.onRefused?.(name);
                // Deliberately not a hook's words and deliberately not shaped
                // like one: no `CHECK_FAILED`, no `[ref evt_…]`, nothing
                // `isHookDecision` could mistake for a decision. This is the
                // turn being over, said once, to a model that will not get to
                // read it anyway because the turn is already ending.
                throw new Error(
                  `${name} was not called: this turn ended when the approval request was raised. ` +
                    `Nothing was refused and nothing was recorded — the turn resumes when the ` +
                    `approval is decided.`,
                );
              }
              return call(...args);
            },
          };
  }

  return {
    tools: wrapped,
    get closed() {
      return state.closed;
    },
    get refused() {
      return refused;
    },
    close() {
      state.closed = true;
    },
  };
}

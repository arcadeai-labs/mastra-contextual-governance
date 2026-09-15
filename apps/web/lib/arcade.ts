/**
 * The one place `apps/web` calls a tool through Arcade.
 *
 * Pressing Approve is a tool call, made **as the clicking user**, and it goes
 * out the same way every other tool call in this demo does: to Arcade, with
 * that person's `user_id`, through `/access`, the auth requirements, `/pre`
 * and `/post`. There is deliberately no second path — no direct write to
 * `governance.db`, no "internal" endpoint that records a decision without a
 * hook. A privileged path that made the demo work would also make the demo
 * false, because the claim being demonstrated is that the approval action is
 * governed like any other.
 *
 * ## What a refusal looks like
 *
 * A `/pre` denial comes back as a failed execution whose error carries
 * `CHECK_FAILED` — the code `apps/hooks` returns — and whose message is the
 * remediation string the policy rule wrote, with the audit row's correlation
 * token on the end. That message is what the page shows, verbatim: it is the
 * same text Alice's agent received, which is the point of the beat.
 *
 * Anything else that goes wrong is `failed`, not `refused`, and the page says
 * so differently. A network error rendered as "you are not allowed" would be a
 * control that appears to work while doing nothing, and a denial rendered as
 * "something went wrong" would hide the control that did.
 *
 * A failure whose cause we can name, we name: an unset `ARCADE_API_KEY`
 * produces a bare `401` that reads like a permissions problem and is not one,
 * so the message says the key is unset and points at the offline stand-in. See
 * `explain` below — it touches failures only, never a refusal's wording.
 *
 * ## What is unverified here
 *
 * #13 registers the gateway and the provider; until it lands, nothing has
 * executed this against real Arcade. The request shape below is Arcade's
 * documented tool-execution call, the refusal shape is what `apps/hooks`
 * produces, and both are driven in tests against a stand-in that answers the
 * way that endpoint answers. The live round trip is not evidence this slice
 * can offer.
 */
import { ApprovalRecord } from "@cg/policy-schema";

import type { WebConfig } from "./config.ts";

export interface DecideCall {
  /** Whose authority the call is made under. Never a tool argument. */
  userId: string;
  requestId: string;
  decision: "approved" | "denied";
  note: string | null;
}

export type DecideOutcome =
  /** The tool ran. `request` is the record as it stands after the decision. */
  | { outcome: "recorded"; request: ApprovalRecord | null }
  /** The control plane refused the call. `message` is what the model would read. */
  | { outcome: "refused"; message: string }
  /** Everything else: unreachable, misconfigured, an unexpected answer. */
  | { outcome: "failed"; message: string };

/** The name the tool is executed under. `arcade-mcp` PascalCases both halves. */
export function decideToolName(config: WebConfig): string {
  return `${config.approvalsToolkit}.Decide`;
}

export async function decideThroughArcade(
  call: DecideCall,
  config: WebConfig,
): Promise<DecideOutcome> {
  let response: Response;
  try {
    response = await fetch(`${config.arcadeApiUrl}/v1/tools/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.arcadeApiKey}`,
      },
      body: JSON.stringify({
        tool_name: decideToolName(config),
        // `decided_by` is not here on purpose. Identity travels as `user_id`,
        // which Arcade hands the tool as `context.user_id`; an actor passed as
        // an argument is an actor the caller can forge.
        input: {
          request_id: call.requestId,
          decision: call.decision,
          ...(call.note === null ? {} : { note: call.note }),
        },
        user_id: call.userId,
      }),
      cache: "no-store",
    });
  } catch (cause) {
    return { outcome: "failed", message: `Arcade could not be reached: ${String(cause)}` };
  }

  let body: ExecuteResponse;
  try {
    body = (await response.json()) as ExecuteResponse;
  } catch {
    return {
      outcome: "failed",
      message: `Arcade answered ${response.status} with something that was not JSON.`,
    };
  }

  const error = body.output?.error;
  if (body.success === true && error === undefined) {
    return { outcome: "recorded", request: asRecord(body.output?.value) };
  }

  const message = error?.message ?? body.error?.message ?? `Arcade answered ${response.status}.`;
  return isCheckFailed(body, message)
    ? { outcome: "refused", message }
    : { outcome: "failed", message: explain(message, config) };
}

/**
 * A failure message with its likeliest cause named, when we can name it.
 *
 * Only ever applied to a **failure**. A refusal is the control plane speaking
 * and its words are the hook author's, untouched; nothing here may edit those
 * or turn one kind of answer into the other.
 *
 * The cause worth naming is an unset `ARCADE_API_KEY`, because it produces a
 * bare `401` that reads like a permissions problem and is not one. A human
 * following this repo's own instructions hit exactly that: the page said
 * "Arcade answered 401" and nothing said the key was empty or that there is an
 * offline path. It is still a fault — no control has spoken — and the screen
 * says so.
 */
function explain(message: string, config: WebConfig): string {
  if (config.arcadeApiKey !== "") return message;
  return (
    `${message} ARCADE_API_KEY is unset, so this call carried no credential — which is the ` +
    `likeliest cause. Set it, or run the offline stand-in and point ARCADE_API_URL at it: ` +
    `see "Driving the two beats locally" in apps/web/README.md. Nothing was decided either way.`
  );
}

/**
 * Arcade's execution response, only as far as this module reads it. Typed
 * loosely on purpose: an unfamiliar field must not turn a refusal into a
 * failure, and until #13 nothing here has been measured against the real
 * service.
 */
interface ExecuteResponse {
  success?: boolean;
  error?: { message?: string; code?: string };
  output?: {
    value?: unknown;
    error?: { message?: string; code?: string; developer_message?: string; can_retry?: boolean };
  };
}

/**
 * Was this a control-plane refusal rather than a malfunction?
 *
 * Matched on the code where there is one and on the text otherwise, because
 * over MCP a hook denial flattens toward `isError: true` plus the string
 * `"Tool execution was denied by an extension policy: "` and our own message
 * (measured, spike #2). Both spellings are accepted; anything else is a
 * failure, which the page renders as a failure.
 */
function isCheckFailed(body: ExecuteResponse, message: string): boolean {
  const code = body.output?.error?.code ?? body.error?.code ?? "";
  if (/CHECK_FAILED|CONTEXT_DENIED/i.test(code)) return true;
  return /CHECK_FAILED|denied by an extension policy/i.test(message);
}

function asRecord(value: unknown): ApprovalRecord | null {
  const parsed = ApprovalRecord.safeParse(value);
  return parsed.success ? parsed.data : null;
}

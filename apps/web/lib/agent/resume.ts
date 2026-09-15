/**
 * The resume: what the UI injects when an approval is decided, and what it is
 * allowed to believe about it.
 *
 * `DESIGN.md` → The wait: *"Agent ends its turn; SSE `approval.granted` event
 * auto-resumes it."* The mechanism is one new turn, started by the browser when
 * the decision arrives on `GET /events`, carrying one extra message. This
 * module builds that message and decides whether there is one to build.
 *
 * ## Two rules, and they are the whole of this file
 *
 * **1. The facts come from the store, never from the browser.** The resume
 * request names a `request_id` and carries the previous turn as context; the
 * server then reads `GET /approvals/{id}` itself, with the store bearer, and
 * every word of the injected message is built from that record. Nothing the
 * browser sent can change what is asserted about the approval. A request that
 * does not read back as decided is refused — a `fault`, not a guess — because
 * the one thing worse than not resuming is resuming on a claim nobody checked.
 * This is `DESIGN.md` rule 1 applied one layer up: an actor a request can name
 * is an actor the model can forge, and so is an approval.
 *
 * **2. The message states a fact and gives no instruction.** No "retry", no
 * "proceed", no "you may now". `DESIGN.md` → Determinism: the hook writes the
 * remediation instruction, not the system prompt — and a message the UI slips
 * into the conversation is the system prompt wearing a different hat. The
 * agent already holds the hook's own sentence from the turn that was refused
 * (*"…then wait for the approval and retry Loan_ApproveLoan with loan_id=…
 * unchanged"*); what this adds is the single fact that sentence was waiting
 * on. If the model does not act on it, the remediation text is what is wrong,
 * and it is fixed in the policy row rather than here.
 *
 * The denial path builds the same kind of sentence. It carries the approver's
 * note when there is one, because a denial with a reason is the thing the
 * requester actually needs, and it says nothing about what to do next — the
 * acceptance criterion for that path is that the agent does **not** retry, and
 * a message that told it not to would make the criterion prove the message.
 */
import type { ApprovalRecord } from "@cg/policy-schema";

import type { TurnMessage } from "./run.ts";

/** What a browser sends to resume a turn. Context and an id; no authority. */
export interface ResumeRequest {
  /** The approval this browser watched its own agent create. */
  request_id: string;
  /** The prompt that opened the turn which ended waiting. Context only. */
  prompt: string;
  /** What the agent said on that turn, as the page received it. Context only. */
  reply: string;
}

/** Why a resume was refused, or the turn to run. */
export type ResumePlan =
  | { ok: true; decision: "approved" | "denied"; message: string; messages: TurnMessage[] }
  | { ok: false; problem: string };

/**
 * Everything a browser may send, validated as shape only.
 *
 * Deliberately not a zod schema: this is three strings, and the thing that
 * actually protects the turn is that none of them is trusted for anything but
 * context. `prompt` and `reply` are allowed to be empty — a browser that lost
 * its transcript can still resume, with less context and the same facts.
 */
export function readResumeRequest(body: unknown): ResumeRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const resume = (body as { resume?: unknown }).resume;
  if (typeof resume !== "object" || resume === null) return null;

  const fields = resume as Record<string, unknown>;
  const id = typeof fields.request_id === "string" ? fields.request_id.trim() : "";
  if (id === "") return null;

  return {
    request_id: id,
    prompt: typeof fields.prompt === "string" ? fields.prompt : "",
    reply: typeof fields.reply === "string" ? fields.reply : "",
  };
}

/**
 * The turn to run for this resume, or the sentence saying why there is none.
 *
 * `record` is what the store answered a moment ago, and `signedInAs` is the
 * persona this browser is signed in as. Both checks are here rather than at the
 * call site so that a future second caller cannot get one of them wrong:
 *
 * - **A request that is still `pending` is not a resume.** Something told this
 *   browser a decision had landed and the store says otherwise; running the
 *   turn anyway would put the agent in front of a hook that is still going to
 *   refuse it, with a sentence claiming it was approved.
 * - **A request somebody else made is not this browser's to resume.** The
 *   approval record names its requester; the session names the persona. They
 *   have to be the same person, or one open tab resumes another's turn — and
 *   the turn would be made as the *wrong* persona, because every tool call is
 *   made as whoever this browser is signed in as.
 */
export function planResume(
  resume: ResumeRequest,
  record: ApprovalRecord,
  signedInAs: string,
): ResumePlan {
  if (!sameSubject(record.requester_id, signedInAs)) {
    return {
      ok: false,
      problem:
        `Approval request ${record.id} was raised by ${record.requester_id}, and this browser is ` +
        `signed in as ${signedInAs}. A turn is resumed for the person whose turn it was.`,
    };
  }

  if (record.status !== "approved" && record.status !== "denied") {
    return {
      ok: false,
      problem:
        `Approval request ${record.id} reads "${record.status}" in the control plane, not a ` +
        `decision. Nothing was resumed; nothing was decided.`,
    };
  }

  const message = resumeMessage(record);
  const context: TurnMessage[] = [];
  if (resume.prompt.trim() !== "") context.push({ role: "user", content: resume.prompt });
  if (resume.reply.trim() !== "") context.push({ role: "assistant", content: resume.reply });

  return {
    ok: true,
    decision: record.status,
    message,
    messages: [...context, { role: "user", content: message }],
  };
}

/**
 * The injected message, built from the record and from nothing else.
 *
 * Read it as a sentence a colleague would say, because that is exactly what it
 * is: *"Charlie decided approval request apr_… — approve_loan on LN-2291 for
 * 95000 — as approved at …"*. It names who, what, how much and when. It does
 * not say what follows from that, in either direction.
 */
export function resumeMessage(record: ApprovalRecord): string {
  const who = record.decided_by ?? record.approver_id;
  const name = record.approver_display_name && record.approver_display_name !== who
    ? `${record.approver_display_name} (${who})`
    : who;
  const when = record.decided_at ?? "an unrecorded time";
  const note = record.note?.trim();

  return (
    `Approval request ${record.id} — ${record.action} on ${record.resource_id} for ` +
    `${record.amount} — was ${record.status} by ${name} at ${when}.` +
    (note ? ` Their note: "${note}"` : "")
  );
}

/** Emails compared the way every other join in this repo compares them (#58). */
function sameSubject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

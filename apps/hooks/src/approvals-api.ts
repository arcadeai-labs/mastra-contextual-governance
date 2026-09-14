/**
 * The four `/approvals` endpoints, as ratified on #18 (storage-A).
 *
 *     GET  /approvals/roster         every subject, so routing can show who was not asked
 *     POST /approvals                create; the store mints the id and the clock
 *     GET  /approvals/{id}           read one by opaque id — the approval page is built on this
 *     POST /approvals/{id}/decision  record an outcome
 *
 * The contract is written out in Markdown in `tools/approvals/README.md`; this
 * is the service side of it, and `tools/approvals/tests/test_store_contract.py`
 * is the executable spec both sides answer to.
 *
 * **This module authorizes nothing.** Every endpoint requires the shared
 * `APPROVALS_STORE_TOKEN`, which says the caller is the deployed toolkit or the
 * approval page rather than a stranger — and that is all it says. Whether the
 * person on the other end may *decide* is a `/pre` decision on
 * `Approvals.Decide`, settled before a decision request is ever sent. The read
 * in particular has nowhere to put a viewer: no parameter, no header beyond the
 * bearer. That is structural rather than a promise, and it is what makes the
 * link safe to send in a conversation the requester can read.
 *
 * Two things it does that the Python stand-in cannot, because they need the
 * catalogue and the policy:
 *
 * - **Naming the rule.** The record carries the rule the blocked call tripped.
 *   The toolkit does not know it, so the control plane works it out the only
 *   honest way available: it re-evaluates the call the requester was refused
 *   and reports the rule that refused it. Not a lookup table — the same engine,
 *   the same policy, the same answer.
 * - **Resolving the action.** `approve_loan` is a bare name; a grant needs a
 *   tool, an argument that names the resource and an argument the ceiling
 *   applies to. `action-binding.ts` derives all three and refuses rather than
 *   guesses, and the result is pinned on the row so a catalogue edited between
 *   the request and the decision cannot retarget the grant.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { evaluatePermission } from "@cg/governance-core";
import type { Subject } from "@cg/policy-schema";

import { resolveAction } from "./action-binding.ts";
import type { ApprovalNotice } from "./approval-notices.ts";
import { createApproval, readApproval, recordDecision } from "./approvals-store.ts";
import type { CacheState } from "./policy-cache.ts";

/** `/approvals` and everything under it. */
export const APPROVALS_PREFIX = "/approvals";

const CreateBody = z
  .object({
    requester_id: z.string().min(1),
    action: z.string().min(1),
    resource_id: z.string().min(1),
    amount: z.number().finite(),
    justification: z.string(),
    approver_id: z.string().min(1),
    candidate_approver_ids: z.array(z.string()).default([]),
    required_clearance: z.number().nonnegative(),
  })
  .strict();

const DecisionBody = z
  .object({
    decision: z.enum(["approved", "denied"]),
    note: z.string().nullable().default(null),
    decided_by: z.string().min(1),
  })
  .strict();

export interface ApprovalsDeps {
  db: Database;
  /** The policy cache, for the roster, the catalogue and the rule that fired. */
  cache: { current(): CacheState };
  now: () => string;
  /**
   * Announce a recorded decision on `GET /events` (#20's resume half).
   *
   * Optional, like the bus itself: a server built without a stream records
   * decisions exactly as before and simply has nobody to tell. Called **after**
   * `recordDecision` has returned, which is after its transaction committed —
   * and that transaction is the one that turns the pre-hook's pending grant on.
   * Publishing any earlier would announce a grant that is still `pending` and
   * therefore still refused. See `approval-notices.ts`.
   */
  publishNotice?: (notice: ApprovalNotice) => void;
}

/**
 * Route one `/approvals` request, or return `null` when the path is not ours.
 *
 * Authorization has already happened in `server.ts`; a request that reaches
 * here carried the store's bearer.
 */
export async function handleApprovals(
  request: Request,
  pathname: string,
  deps: ApprovalsDeps,
): Promise<Response | null> {
  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const method = request.method;

  if (pathname === `${APPROVALS_PREFIX}/roster`) {
    if (method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json({ subjects: roster(deps.cache.current()).map(asRosterEntry) });
  }

  if (pathname === APPROVALS_PREFIX) {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    return create(request, deps, json);
  }

  const decision = /^\/approvals\/([^/]+)\/decision$/.exec(pathname);
  if (decision) {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    return decide(request, decodeURIComponent(decision[1] as string), deps, json);
  }

  const read = /^\/approvals\/([^/]+)$/.exec(pathname);
  if (read) {
    if (method !== "GET") return json({ error: "Method not allowed" }, 405);
    const id = decodeURIComponent(read[1] as string);
    const stored = readApproval(deps.db, id);
    // A 200 here says the request exists. It never says the reader may act on
    // it — that question is answered when the button is pressed.
    return stored === null
      ? json({ error: `no approval request ${id}` }, 404)
      : json({ request: stored.record });
  }

  return null;
}

type Json = (body: unknown, status?: number) => Response;

async function create(request: Request, deps: ApprovalsDeps, json: Json): Promise<Response> {
  const parsed = CreateBody.safeParse(await readJson(request));
  if (!parsed.success) {
    return json({ error: `malformed approval request: ${parsed.error.message}` }, 400);
  }
  const body = parsed.data;

  const state = deps.cache.current();
  if (state.status !== "ready") {
    return json(
      { error: "the control plane cannot record an approval request while its policy is unavailable" },
      503,
    );
  }

  const resolution = resolveAction(body.action, state.catalogue, state.policy);
  if (resolution.outcome === "unresolvable") {
    // Refusing is the whole point. A request the control plane cannot resolve
    // is a request that could never issue an enforceable grant, and the way
    // that fails otherwise is a human approving something that then does
    // nothing — or worse, something wider than they read.
    return json({ error: `cannot escalate this action: ${resolution.problem}` }, 422);
  }

  const named = nameTheRule(body, resolution.binding, state);

  const stored = createApproval(
    deps.db,
    {
      requester_id: body.requester_id,
      requester_display_name: displayName(state, body.requester_id),
      approver_id: body.approver_id,
      approver_display_name: displayName(state, body.approver_id),
      candidate_approver_ids: body.candidate_approver_ids,
      action: body.action,
      resource_id: body.resource_id,
      amount: body.amount,
      required_clearance: body.required_clearance,
      rule: named,
      justification: body.justification,
    },
    resolution.binding,
    { now: deps.now },
  );

  return json({ request: stored.record }, 201);
}

async function decide(
  request: Request,
  id: string,
  deps: ApprovalsDeps,
  json: Json,
): Promise<Response> {
  const parsed = DecisionBody.safeParse(await readJson(request));
  if (!parsed.success) {
    return json({ error: `malformed decision: ${parsed.error.message}` }, 400);
  }

  const outcome = recordDecision(deps.db, id, parsed.data, deps.now);
  switch (outcome.outcome) {
    case "not_found":
      return json({ error: `no approval request ${id}` }, 404);
    case "already_decided":
      // Not in the contract's table, because the contract does not describe
      // this case at all. The pre-hook's "a decision is final" rule is what
      // normally stops it; refusing here as well means a decision cannot be
      // rewritten even by something holding the store's bearer.
      return json(
        {
          error: `approval request ${id} was already ${outcome.approval.record.status}`,
          request: outcome.approval.record,
        },
        409,
      );
    case "recorded": {
      const record = outcome.approval.record;
      // After the transaction, and after nothing else: the commit is what
      // activated the grant, and the browser on the other end of this notice
      // is about to retry against it.
      // `parsed.data.decision` rather than `record.status`: they are the same
      // value — the swap wrote one from the other — but only this one is typed
      // to the two outcomes, so a future third status cannot silently arrive
      // here labelled `approval.denied`.
      const settled = parsed.data.decision;
      deps.publishNotice?.({
        kind: settled === "approved" ? "approval.granted" : "approval.denied",
        request_id: record.id,
        // The only address this notice has. A client resumes on it and on the
        // request id together, so one persona's open tab cannot resume
        // another's turn.
        requester_id: record.requester_id,
        status: settled,
        action: record.action,
        resource_id: record.resource_id,
        amount: record.amount,
        decided_by: record.decided_by ?? parsed.data.decided_by,
        decided_at: record.decided_at ?? deps.now(),
        grants_activated: outcome.grantsActivated,
      });
      return json({ request: record });
    }
  }
}

/**
 * Which rule refused the call this request escalates, by asking the engine
 * rather than by remembering.
 *
 * The requester, the tool and the two inputs are all known, so the refusal can
 * simply be reproduced. If it does not reproduce — the policy changed, the
 * requester is not on the roster, nothing denies the call any more — the rule
 * is `null`, which the contract allows and the page renders as "the authority
 * that was exceeded" instead. Guessing a plausible rule id would be worse than
 * saying nothing: it is the panel's join key.
 */
function nameTheRule(
  body: z.infer<typeof CreateBody>,
  binding: { toolkit: string; tool: string; resourceInput: string; amountInput: string | null },
  state: Extract<CacheState, { status: "ready" }>,
): { id: string; description: string } | null {
  const subject = [...state.subjects.values()].find(
    (s) => s.user_id.toLowerCase() === body.requester_id.trim().toLowerCase(),
  );
  if (subject === undefined) return null;

  const inputs: Record<string, unknown> = { [binding.resourceInput]: body.resource_id };
  if (binding.amountInput !== null) inputs[binding.amountInput] = body.amount;

  const decision = evaluatePermission({
    subject,
    tool: { toolkit: binding.toolkit, name: binding.tool },
    inputs,
    policy: state.policy,
  });
  if (decision.effect !== "deny" || decision.rule_id === null) return null;

  const rule = state.policy.rules.find((r) => r.id === decision.rule_id);
  return { id: decision.rule_id, description: rule?.description ?? "" };
}

function roster(state: CacheState): Subject[] {
  return state.status === "ready" ? [...state.subjects.values()] : [];
}

function asRosterEntry(subject: Subject) {
  return {
    user_id: subject.user_id,
    display_name: subject.display_name,
    role: subject.role,
    clearance: subject.clearance,
    attributes: subject.attributes,
  };
}

/** From the roster, so the approval page never has to join two responses. */
function displayName(state: CacheState, userId: string): string {
  const match = roster(state).find(
    (s) => s.user_id.toLowerCase() === userId.trim().toLowerCase(),
  );
  return match?.display_name ?? userId;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

"""The approvals toolkit: escalate a blocked call to the one human who can decide it.

A Python `arcade-mcp` toolkit, like its sibling `tools/loan`: outside the Bun
workspaces and outside `render.yaml`, shipped with `arcade deploy`. Python
because `arcade-mcp`, the framework the agent's tools are authored in, is
Python-only — the boundary is tool authoring, not domain.

`request_approval` is what the agent reaches for after the pre-hook denies it.
The hook's own remediation message is what sends it here; the system prompt says
nothing about approvals, because a control the model is *asked* to respect is
not a control.

Three things this toolkit does not do, each on purpose:

**It does not choose the approver.** Routing is deterministic — lowest
sufficient clearance, requester excluded — and lives in `routing.py`, checked
row for row against the TypeScript in `packages/governance-core` (#9). A model
that could name its own approver could name a friendly one.

**It does not decide anything.** `decide` records an outcome. Whether the
caller may decide is a `/pre` question about `Approvals.Decide` — role, limit,
and requester ≠ approver — answered by `apps/hooks` before this code runs, and
enforced in #19.

**It does not hand out authority.** The link in the Slack message is a pointer
to a request id: no token, no signature, no capability. The requester can read
the DM she sent, so possession of the URL must not be permission.

`MCPApp(name="approvals")` below is what `arcade deploy` reads off `initialize`
and PascalCases into the toolkit name, so these are `Approvals.RequestApproval`
and `Approvals.Decide`. Measured on `tools/loan`, derived here — `.env.example`
pins `ARCADE_APPROVALS_TOOLKIT=Approvals` and #35 confirms it off the workers
API after the first deploy. A policy rule keyed on the wrong string matches
nothing, which is indistinguishable from a rule that permits.
"""

from enum import Enum
from typing import Annotated, Any

from arcade_core.errors import ToolExecutionError
from arcade_mcp_server import Context, MCPApp
from arcade_mcp_server.auth import Slack

from approvals.message import ApprovalMessage, build_blocks, build_fallback_text, format_amount
from approvals.routing import RoutingResult, Subject, route_approval
from approvals.slack import (
    SLACK_SCOPES,
    SlackError,
    lookup_user_by_email,
    open_direct_message,
    post_message,
)
from approvals.store import (
    APPROVALS_STORE_TOKEN_SECRET,
    HOOKS_HOST_SECRET,
    WEB_HOST_SECRET,
    base_url,
    create_request,
    fetch_roster,
    record_decision,
)

__all__ = [
    "APPROVALS_STORE_TOKEN_SECRET",
    "HOOKS_HOST_SECRET",
    "SLACK_SCOPES",
    "WEB_HOST_SECRET",
    "Decision",
    "app",
    "approval_url",
    "decide",
    "describe_rule",
    "request_approval",
]

app = MCPApp(
    name="approvals",
    version="1.0.0",
    instructions=(
        "Human-in-the-loop approvals. When a tool call is refused for exceeding your "
        "authority, request_approval escalates it to the one person whose authority "
        "covers it and messages them; decide records that person's answer."
    ),
)

# The stock Slack provider, and four scopes rather than three: `users:read` is
# a prerequisite for `users:read.email`, and Slack refuses the authorize
# request outright without it (spike #3). The token this grants is the
# requester's own, so the DM arrives under her name — there is no bot here.
#
# This requirement is a credential check, not the governance gate. Arcade
# evaluates it *before* the `/pre` hook, so a refusal fires no hook, writes no
# audit row and shows nothing on the panel: rehearse the Slack authorization
# rather than discovering it on stage.
_requires_slack = Slack(scopes=SLACK_SCOPES)
_store_secrets = [HOOKS_HOST_SECRET, APPROVALS_STORE_TOKEN_SECRET]
_request_secrets = [*_store_secrets, WEB_HOST_SECRET]


class Decision(str, Enum):
    APPROVED = "approved"
    DENIED = "denied"


def approval_url(web_host: str, request_id: str) -> str:
    """The approval page for one request. The id, and nothing else.

    No query string, because a query string is where a token arrives. #19
    authorises the clicker at click time; this URL identifies the request and
    says nothing about who may act on it.
    """
    return f"{base_url(web_host)}/approvals/{request_id}"


def describe_rule(
    rule: dict[str, Any] | None, requester: Subject | None, action: str, amount: float
) -> str:
    """The policy rule that was tripped, in words the approver reads.

    `rule` rides on the approval record itself, so the DM and #19's page cannot
    answer the question differently. The control plane names it when it can. When it cannot, this says the thing
    the toolkit does know for certain from the roster it just routed against —
    the requester's authority, and that the amount exceeded it. A message that
    left this blank would be a message the approver has to go and ask about,
    which is the failure the deterministic format exists to prevent.
    """
    if rule and rule.get("description"):
        described = str(rule["description"])
        rule_id = rule.get("id")
        return f"{described} (`{rule_id}`)" if rule_id else described
    if requester is not None:
        return (
            f"{action} for {format_amount(amount)} exceeds "
            f"{requester.display_name}'s approval authority of "
            f"{format_amount(requester.clearance)}."
        )
    return (
        f"{action} for {format_amount(amount)} exceeded the requester's approval "
        "authority. The control plane did not name the rule."
    )


@app.tool(requires_auth=_requires_slack, requires_secrets=_request_secrets)
async def request_approval(
    context: Context,
    action: Annotated[
        str,
        "The action that was refused, named exactly as the refusal named it — for "
        "example approve_loan.",
    ],
    resource_id: Annotated[
        str, "The thing the action was going to act on — for example the loan ID LN-2291."
    ],
    amount: Annotated[
        float,
        "The dollar amount the refused call carried. This is what determines who has "
        "the authority to approve it, so pass the amount unchanged.",
    ],
    justification: Annotated[
        str,
        "Why this should be approved, in your own words and specific to this case. "
        "The approver reads it verbatim and decides on it, so give the reasons rather "
        "than restating the request.",
    ],
) -> Annotated[
    dict[str, Any],
    "The request ID and the person it was routed to, so you can say who was asked.",
]:
    """Escalate an action you were refused authority for to the person who can approve it. Use this when a tool call was denied for exceeding your approval authority, and only then. You do not choose the approver: this routes the request to the individual holding the lowest authority sufficient to cover it, never to whoever is most senior and never to the person asking. It records the request, messages that person with everything they need to decide, and returns the request ID and who was asked. It does not wait for the answer and it does not grant you anything — after calling this, tell the user who was asked and stop; you will be told when they have decided."""
    requester_id = context.user_id or ""
    if not requester_id:
        raise ToolExecutionError(
            "No identity was supplied for this call, so there is nobody to escalate on "
            "behalf of and nobody to exclude from approving it.",
            developer_message="context.user_id was empty on request_approval.",
        )

    hooks_host = context.get_secret(HOOKS_HOST_SECRET)
    store_token = context.get_secret(APPROVALS_STORE_TOKEN_SECRET)
    web_host = context.get_secret(WEB_HOST_SECRET)

    roster = await fetch_roster(hooks_host, store_token)
    try:
        routed: RoutingResult = route_approval(amount, requester_id, roster)
    except ValueError as exc:
        raise ToolExecutionError(
            f"{amount!r} is not an amount that can be routed for approval.",
            developer_message=str(exc),
        ) from exc

    if routed.approver is None:
        # An ordinary outcome of the rule, and an error for the caller: nothing
        # was recorded and nobody was messaged, so the agent must not be able to
        # read this as "requested". Deliberately not a fallback to the highest
        # authority — routing that quietly escalates past its own rule is a
        # control that does nothing.
        raise ToolExecutionError(
            f"Nobody holds authority sufficient to approve {action} for "
            f"{format_amount(amount)}, so no approval was requested.",
            developer_message=(
                f"route_approval: no eligible approver for amount={amount} "
                f"requester={requester_id} roster={len(roster)}"
            ),
        )

    approver = routed.approver
    requester = next((s for s in roster if s.user_id == requester_id), None)

    created = await create_request(
        hooks_host,
        store_token,
        {
            "requester_id": requester_id,
            "action": action,
            "resource_id": resource_id,
            "amount": amount,
            "justification": justification,
            "approver_id": approver.user_id,
            "candidate_approver_ids": [s.user_id for s in routed.candidates],
            "required_clearance": routed.required_clearance,
        },
    )
    record = created.get("request") or {}
    request_id = record.get("id")
    if not request_id:
        raise ToolExecutionError(
            "The approval request could not be recorded, so nobody was asked.",
            developer_message=f"POST /approvals returned no request id: {created!r}",
        )

    message = ApprovalMessage(
        request_id=str(request_id),
        requester_display_name=requester.display_name if requester else requester_id,
        requester_id=requester_id,
        approver_display_name=approver.display_name or approver.user_id,
        action=action,
        resource_id=resource_id,
        amount=amount,
        justification=justification,
        rule_tripped=describe_rule(record.get("rule"), requester, action, amount),
        approval_url=approval_url(web_host, str(request_id)),
        candidate_display_names=tuple(
            s.display_name or s.user_id for s in routed.candidates
        ),
    )

    slack_token = context.get_auth_token_or_empty()
    try:
        # The three calls spike #3 exercised, in that order: resolve the
        # approver's email to a Slack id, open the DM, post to the channel that
        # returns. Handing chat.postMessage a bare user id would skip the
        # middle call and one scope, but nothing has observed that path work.
        approver_slack_id = await lookup_user_by_email(slack_token, approver.user_id)
        dm_channel = await open_direct_message(slack_token, approver_slack_id)
        posted = await post_message(
            slack_token,
            dm_channel,
            build_fallback_text(message),
            build_blocks(message),
        )
    except SlackError as exc:
        # The record exists and the routing stands; what failed is the notice.
        # Saying so precisely is the difference between "go and tell Charlie" and
        # an agent that believes it has escalated something nobody has seen.
        raise ToolExecutionError(
            f"Approval request {request_id} was recorded and routed to "
            f"{approver.display_name or 'the routed approver'}, but Slack method "
            f"{exc.method} failed with error code {exc.error}; the notice was not "
            "delivered. Do not retry this approval request: retrying would create a "
            "duplicate. Stop and capture the method and error code for an administrator.",
            developer_message=(
                f"{exc.diagnostic_message()}; approval request {request_id} was "
                "recorded and routed, but notice delivery failed; do not retry."
            ),
        ) from exc

    return {
        "request_id": str(request_id),
        "status": str(record.get("status", "pending")),
        "approver": approver.user_id,
        "approver_display_name": approver.display_name or approver.user_id,
        "required_clearance": routed.required_clearance,
        "candidate_approvers": [s.user_id for s in routed.candidates],
        "approval_url": message.approval_url,
        "slack_message_ts": posted["ts"],
    }


@app.tool(requires_secrets=_store_secrets)
async def decide(
    context: Context,
    request_id: Annotated[str, "The ID of the approval request being decided."],
    decision: Annotated[Decision, "Whether the request is approved or denied."],
    note: Annotated[
        str | None, "A note to the requester explaining the decision. Optional."
    ] = None,
) -> Annotated[dict[str, Any], "The approval request as it stands after the decision."]:
    """Record an approver's answer to an approval request. This is called on behalf of whoever clicked approve or deny on the approval page, and it records their answer against the request; it does not decide anything itself and it does not check whether they were entitled to. Whether this caller may decide this request — their role, their authority, and that they are not the person who asked — is settled before this runs."""
    # No auth requirement on purpose. An OAuth requirement is evaluated *before*
    # the `/pre` hook, so a refusal there fires no hook, writes no audit row and
    # shows nothing on the panel — and the whole point of this tool is that its
    # refusal is visible. Identity comes from `context.user_id`, which Arcade
    # supplies and the model cannot write; authority is a `/pre` decision on
    # `Approvals.Decide`, enforced in #19.
    decided_by = context.user_id or ""
    if not decided_by:
        raise ToolExecutionError(
            "No identity was supplied for this call, so there is nobody to record as "
            "having decided.",
            developer_message="context.user_id was empty on decide.",
        )

    updated = await record_decision(
        context.get_secret(HOOKS_HOST_SECRET),
        context.get_secret(APPROVALS_STORE_TOKEN_SECRET),
        request_id,
        {
            "decision": decision.value,
            "note": note,
            "decided_by": decided_by,
        },
    )
    return updated.get("request") or updated

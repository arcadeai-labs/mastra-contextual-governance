# tools/approvals

The human-in-the-loop toolkit. `request_approval` routes a refused action to
the one person whose authority covers it and DMs them; `decide` records that
person's answer.

A Python `arcade-mcp` toolkit, like its sibling
[`tools/loan`](../loan/README.md): outside the Bun workspaces, outside
`render.yaml`, shipped with `arcade deploy`. `arcade-mcp` is the framework the
agent's tools are authored in and it is Python-only, so both toolkits are
Python while everything under `apps/` and `packages/` is TypeScript. The
boundary is tool authoring, not domain.

A forker who wants no Python deletes this directory and `tools/loan`, and
substitutes their own tools. Nothing under `packages/` imports either one, and
CI discovers the toolkits it tests rather than listing them
(`scripts/list-toolkits.sh`), so a deleted toolkit is not a red build.

`tests/test_isolation.py::TestDeletingItActuallyWorks` performs that deletion
against a throwaway copy of the repo and checks what is left — discovery, the
workflows, the TypeScript, and the shared routing cases that must survive it.
Reasoning about a deletion and doing it are not the same evidence.

## The two tools

    request_approval(action, resource_id, amount, justification)
      -> { request_id, status, approver, approver_display_name,
           required_clearance, candidate_approvers, approval_url,
           slack_message_ts }

    decide(request_id, decision, note?)
      -> the approval request as it stands after the decision

`request_approval` is what the agent reaches for after the pre-hook denies it.
The hook's own remediation message is what sends it here — the system prompt
says nothing about approvals, because a control the model is *asked* to respect
is not a control.

## Three things it deliberately does not do

**It does not choose the approver.** Routing is deterministic: lowest
sufficient clearance, requester excluded, ties broken by `user_id`. There is no
argument through which the agent could name an approver, which is a stronger
statement than a rule that ignores one.

**It does not decide anything.** `decide` records an outcome. Whether the
caller may decide — their role, their authority, and that they are not the
person who asked — is a `/pre` decision about `Approvals.Decide`, answered by
`apps/hooks` before this code runs and enforced in #19. `decide` therefore
declares **no** OAuth requirement: Arcade evaluates auth requirements *before*
`/pre`, so a credential refusal fires no hook, writes no audit row and shows
nothing on the panel — and the refusal of `decide` is precisely the beat the
demo needs to be visible.

**It does not hand out authority.** The link in the Slack message is a pointer
to a request id. No token, no signature, no capability, no query string. The
requester can read the DM she sent, so possession of the URL must not be the
same as permission. `tests/test_message.py` asserts this against the rendered
payload, because a signed link is the sort of convenience that gets added back
later by someone who does not know why it is absent.

## Routing, and how it is kept honest

`approvals/routing.py` is a parity port of
[`packages/governance-core/src/approver-router.ts`](../../packages/governance-core/src/approver-router.ts)
(#9). Two implementations of one rule in two languages is a real divergence
risk, so neither is argued to agree with the other: both load
[`packages/policy-schema/contract/approver-routing-cases.json`](../../packages/policy-schema/contract/approver-routing-cases.json)
and are checked row for row against it. A row added there is checked on both
sides on the next run.

    $95,000 from Alice ($50K) with Charlie ($250K) and Michael ($5M) on the roster
    → Charlie. Michael is recorded as a candidate and deliberately not bothered.

## Slack

Access is brokered by Arcade's **stock** Slack provider. There is no custom
Slack app, no bot token, and nothing to provision: the provider issues the
requester's own user token, so the DM arrives under her name with no APP badge.
Measured end to end in
[`docs/spikes/03-slack-scopes.md`](../../docs/spikes/03-slack-scopes.md) (#3),
which also records both fallbacks for a forker who wants a bot instead.

Four scopes, not three — exactly the set spike #3 exercised:

    chat:write  im:write  users:read  users:read.email

`users:read` is a prerequisite for `users:read.email`: Slack refuses the
authorize request outright without it, before any consent screen. `im:write` is
what `conversations.open` needs.

The message reaches the approver by the route the spike measured, and only that
route:

    users.lookupByEmail  →  conversations.open  →  chat.postMessage to the D… channel

Handing `chat.postMessage` a bare user id and letting Slack resolve the DM
would drop the middle call and `im:write` with it. That was proposed on #18 and
settled against, because nothing had observed it working and a DM that silently
never arrives is the failure this whole slice exists to avoid.
`tests/test_tools.py::test_reaches_the_dm_by_the_route_spike_3_measured` pins
the call order, and the Slack stand-in serves those three methods and nothing
else, so a call the spike never measured fails in the suite too.

The message goes to the routed approver, never to a shared channel: who was
asked is the point being demonstrated, and a fixed channel would lose it. There
is no channel variable to set.

## Where the approval request lives

Nowhere in this toolkit. A deployed `arcade deploy` worker is an ephemeral
container, and — the reason that actually settles it — the approval page in #19
runs in `apps/web` and has to read the record the tool wrote. So the request is
persisted where `DESIGN.md` says approvals live: `governance.db`, owned by
`apps/hooks`, reached over HTTP the same way Arcade reaches the hooks.

Storage-A was ratified on #18, and **`apps/hooks` serves these four endpoints
as of #19**. What landed in this slice is the client and the contract below,
implemented by a stand-in server in `tests/conftest.py` and driven over real
HTTP by `tests/test_store_contract.py`; the service side has its own
counterpart, `apps/hooks/test/approvals-endpoints.test.ts`, driving the same
contract against the real thing.

## The approvals store contract

Four endpoints on `apps/hooks`. Written out here rather than left in a Python
docstring, because whoever builds #19 works in TypeScript and should not have
to read Python to build against it.

**Every endpoint requires `Authorization: Bearer $APPROVALS_STORE_TOKEN`**, the
same value both sides read from the environment. A request without it, or with
the wrong one, is `401` and does nothing. This is not ceremony: without it
anyone on the internet could manufacture the approval request a human then acts
on, or read one they were never sent.

### The record

One shape, returned by every endpoint that returns a request. `POST /approvals`,
`GET /approvals/{id}` and `POST /approvals/{id}/decision` return the *same*
fields — a page that can render the read is a page that can render the write.

| field | type | notes |
|---|---|---|
| `id` | string | Opaque. Minted by the store, never by a caller. |
| `requester_id` | string | Email. The `context.user_id` of whoever was refused. |
| `requester_display_name` | string | From the roster, so the page need not join. |
| `approver_id` | string | Email of the one person routing chose. |
| `approver_display_name` | string | |
| `candidate_approver_ids` | string[] | Everyone sufficient, lowest clearance first. `[0]` is the approver; the rest are who was deliberately not bothered. |
| `action` | string | The refused action, e.g. `approve_loan`. |
| `resource_id` | string | e.g. `LN-2291`. |
| `amount` | number | What determines who has the authority. |
| `required_clearance` | number | The bar a candidate had to clear: the amount. |
| `rule` | `{id, description}` \| null | The policy rule the blocked call tripped, when the control plane can name it. `null` when it cannot — the page and the DM both still state the authority that was exceeded. |
| `justification` | string | The requester's own words, rendered verbatim. |
| `status` | `pending` \| `approved` \| `denied` \| `expired` | |
| `created_at` | string | ISO 8601, `Z`-suffixed UTC, as `@cg/policy-schema`'s `Timestamp` requires. |
| `decided_at` | string \| null | `null` while pending. |
| `decided_by` | string \| null | Email of whoever decided. `null` while pending. |
| `note` | string \| null | The approver's note. `null` while pending or if none was given. |

There is deliberately **no separate `decision` field**: once decided, `status`
*is* the decision. Two fields carrying the same fact is two fields that can
disagree, and a page that rendered "approved" beside a status of `denied` would
be worse than one that rendered nothing.

`rule` lives on the record rather than beside it, so the read and the write
cannot answer the question differently.

### `GET /approvals/roster`

Every subject the control plane knows about. Routing needs the whole roster,
because who was *not* asked is as load-bearing as who was.

```json
200 { "subjects": [ { "user_id": "charlie@…", "display_name": "Charlie",
                      "role": "vp_credit", "clearance": 250000,
                      "attributes": {} } ] }
```

### `POST /approvals`

```json
<- { "requester_id": "alice@…", "action": "approve_loan",
     "resource_id": "LN-2291", "amount": 95000,
     "justification": "…", "approver_id": "charlie@…",
     "candidate_approver_ids": ["charlie@…", "michael@…"],
     "required_clearance": 95000 }

-> 201 { "request": <the record above, status "pending"> }
```

The store mints `id` and `created_at` — a server clock and a server id. An id
the toolkit invented would be an id the model could predict, and therefore ask
about before anyone had approved it.

`action` is a bare action name, not a fully-qualified tool. Resolving it to a
`ToolMatcher` needs the catalogue, which the control plane has and this toolkit
deliberately does not.

### `GET /approvals/{id}`

```json
-> 200 { "request": <the record above> }
-> 404 { "error": "no approval request apr_…" }
```

**This is the endpoint #19's page is built on.** The link in the Slack message
carries the id and nothing else — no token, no signature, no capability — so
this response has to be enough to render the whole page: who asked, what for,
how much, which rule, and why. That is what the record above is sized to.

Answering `200` here is *not* authorization. The requester can read the DM she
sent, so anyone who has the link can reach this. Whether the person looking may
*decide* is settled at click time by a `/pre` decision on `Approvals.Decide` —
#19's job, and the beat the demo exists to show.

### `POST /approvals/{id}/decision`

```json
<- { "decision": "approved" | "denied", "note": string | null,
     "decided_by": "charlie@…" }

-> 200 { "request": <the record above, status now the decision> }
-> 404 { "error": "no approval request apr_…" }
```

Recording, not deciding. Whether the caller may decide — role, authority, and
requester ≠ approver — is answered before this request is ever made.

One thing the service adds that this contract does not require of it: a
decision is recorded only while the request is `pending`, and a second one
answers `409`. The pre-hook's "a decision is final" rule is the control that
normally stops it; refusing in the store as well means a `denied` cannot be
rewritten to `approved` even by something holding the bearer.

`decided_by` travels in the body, and that is worth being explicit about
because `apps/loan-app` deliberately does the opposite: there the actor comes
from the OAuth token and never from a parameter, because the model chooses the
arguments. Here the value is `context.user_id`, read server-side inside the
tool. It is not a tool argument and the model cannot reach it.

## Configuration

Three Arcade secrets, uploaded by `arcade deploy` from the repo's `.env`,
because a secret is the one configuration channel a deployed toolkit has. All
HOST-form, like every address in this repo; consumers add the scheme.

| secret | what |
|---|---|
| `HOOKS_PUBLIC_HOST` | the control plane, which owns `governance.db` |
| `WEB_PUBLIC_HOST` | used to build the approval link, and nothing else |
| `APPROVALS_STORE_TOKEN` | shared bearer the approvals endpoints require |

`APPROVALS_STORE_TOKEN` is not ceremony. Without it the approvals store would
accept a record from anyone on the internet, and that record is what a human
then acts on.

## Run and test

```sh
uv sync --extra dev
uv run --extra dev pytest        # boots stand-in store and Slack on OS-assigned ports
uv run server.py http            # Streamable HTTP on 127.0.0.1:8000
```

Nothing in the suite binds a fixed port and nothing reaches the internet. The
six files, and what each pins:

| file | |
|---|---|
| `test_routing.py` | agreement with #9's TypeScript, row for row |
| `test_message.py` | the Block Kit payload, and that its link carries no authority |
| `test_tools.py` | both tools end to end, against real HTTP stand-ins |
| `test_store_contract.py` | every endpoint of the store contract above, including the `GET` #19 needs and the bearer on all four |
| `test_isolation.py` | that deleting this directory really is supported |
| `test_toolkit_discovery.py` | `scripts/list-toolkits.sh`, which CI's matrix is built from — output *and* exit status, for zero, one and two toolkits |

## Deploy

```sh
arcade deploy                    # from this directory
```

`arcade deploy` starts `server.py`, reads `serverInfo.name` and `version` off
its `initialize` response, and ships the package under that name — the
`MCPApp(name=...)` in `approvals/__init__.py`, not the package name in
`pyproject.toml`.

`name="approvals"` PascalCases to the toolkit **`Approvals`**, and `arcade-mcp`
PascalCases the tools itself, so these are `Approvals.RequestApproval` and
`Approvals.Decide`; the MCP wire names through a gateway are
`Approvals_RequestApproval` and `Approvals_Decide`.

⚠️ **That is derived from `tools/loan`'s measurement, not observed here.** #34
measured `loan` → `Loan` and `loan_mcp_probe` → `LoanMcpProbe` on a real
deploy; this package had no tools to deploy at the time. Thirty seconds after
the first deploy: read `toolkit.name` off `GET /v1/workers/<server>/tools`,
correct `ARCADE_APPROVALS_TOOLKIT` in `.env.example` if it differs, and report
on #35. A policy rule keyed on the wrong string matches nothing, which is
indistinguishable from a rule that permits.

The toolkit also has to be added to the gateway (#13) before the agent can call
it, and every persona who can trigger act 2 authorizes Slack once. Rehearse
that authorization; a scope refusal happens upstream of every hook and leaves
the panel dark.

# Contextual Governance — Mastra × Arcade

A live demo, shipped as a forkable template: an agent that does real work in a real
business system, with Arcade enforcing deterministic control on every tool call.

Source narrative: loan officer asks an agent to approve a $95K loan and "double-check
your work." Four things go wrong. All four are caught by the control plane, not by the
model.

## Thesis

Treat the LLM as an adversary. Controls it cannot reason around must live outside it.
Arcade provides **four** identity-keyed control points on every tool call, and the model
sits inside all of them:

| # | Layer | Keyed on | Mechanism | Act |
|---|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/access` → `deny` list | 1 |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes | — |
| 3 | Whether you have the authority for *this* call | identity + policy | `/pre` → `CHECK_FAILED` | 2 |
| 4 | What comes back | policy | `/post` → `override.output` | 3, 4 |

Layer 2 was added on #32. It is not a gap in governance — it is a cheaper, earlier gate on
the same identity, and defence in depth is the point. **It has one consequence the other
three do not:** Arcade evaluates auth requirements *before* `/pre`, so a refusal there fires
no hook, writes no audit row, and shows nothing on the panel (measured, spike #2). Never
stage a beat we want to *show* as a layer-2 refusal. See open risk 2.

## The four acts

| # | Beat | Control | Mechanism |
|---|------|---------|-----------|
| 1 | Sam (analyst) literally cannot see `approve_loan` | Access | `POST /access` → `deny` list |
| 2 | Dana's $95K exceeds her $50K authority → blocked → routed approval → retry succeeds | Pre | `POST /pre` → `CHECK_FAILED` + remediation message |
| 3 | `get_loan` returns a bank account number → redacted before it reaches the model | Post | `POST /post` → `override.output` |
| 4 | Seeded underwriter note contains an injected instruction → stripped | Post | `POST /post` → regex scanner |

**Measured on #14 (2026-09-12), and it reorders the build:** acts 2 and 4 share `LN-2291`.
Until `/post` strips the injected note (act 4's control, #16/#17), the model reads it, refuses
it, and about two runs in three ends the turn asking the officer whether to proceed, so
`ApproveLoan` is never called and `/pre` never fires. The same prompt on a clean over-limit
loan (`LN-2299`) reaches the hook 12 of 12. Act 4's control therefore lands **before** act 2 is
rehearsed, and #16 re-measures the $95K rate with `/post` live (#91). Act 2's second half
additionally needs the agent to hold `Approvals_*` and the remediation text to name the tool
as the wire spells it (#89). No prompt steering is an acceptable fix for either.

## Decisions

| Area | Decision |
|---|---|
| Format | Live demo, but `main` is a forkable template |
| Topology | Arcade Cloud engine → hooks deployed at a stable public URL. No tunnels. |
| Integration | Mastra `MCPClient` → `https://api.arcade.dev/mcp/{gateway}` |
| Model | Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id from env |
| **Tool layer** | **Both toolkits are Python `arcade-mcp`, shipped with `arcade deploy` into one Arcade project and exposed through one gateway. `arcade-mcp` is the tool-authoring framework; it is Python-only, which is why the TS-everywhere rule does not reach the toolkits. Decided on #32, confirmed in session.** |
| **Business system** | **`apps/loan-app` is a plain HTTP API — the bank's system of record. It is not an MCP server and knows nothing about Arcade. `tools/loan` is a stateless client of it. Decided on #32; splitting them is what makes "governance is outside the business system" literal rather than asserted.** **Loan state shown in the bank UI (`/` cards, `/loans` board) is read from `apps/loan-app` directly, over HTTP, as the signed-in person using the IdP access token from their own sign-in, and polled. It does not go through the gateway. Decided 2026-09-18 (#157), reversing #22/#109: page loads made governed `Loan_GetLoan` calls before the presenter had said anything, so the audience could not tell agent calls from page chrome, and cards never reflected an approval. After #157 every MCP call in the demo originates in the chat. The earlier objection (a second ungoverned path beside a panel claiming one) is answered by scope: the thesis is about the agent's path, the bank's own screen for an authenticated human is not that path, and the cards never show `bank_account_number`, `tax_id` or `underwriter_notes`, so act 3 is not undercut. No service credential: the read is attributable to a person or it does not happen.** |
| **Identity** | **Every persona is a real person in `apps/idp` with a real email, and `apps/web` is a real sign-in against it (its own OAuth client, "client C"). On stage each persona runs in its own Chrome profile, so there is no persona switcher: `/`'s chrome carries one `Sign in` with no persona preselected, and one `Sign out`. Signing in is a fresh IdP login and never reuses the previous session. `context.user_id` on every hook payload is that email, lowercase. Personas are *not* Arcade project members. Amended 2026-09-11 (#65, #75, #79) and 2026-09-19 (#176 — the four "Sign in as …" buttons were deleted: one profile per persona is the real demo shape, and the buttons read as a mock on the one screen whose argument is that nothing on it is a mock).** |
| **Two hops, two mechanisms** | **Hop 1, MCP client → gateway, is governed by the gateway's user mode: the User Source gateway `cg-demo-us` backed by `apps/idp`. Members mode is the fallback only. Arcade Headers is ruled out and is never proposed again. Hop 2, the tool-level OAuth against the `cg-idp` provider, is governed by a custom user verifier route in `apps/web`. Neither mechanism moves the other; measured on #75. Decided 2026-09-11. Hop 2's IdP tolerates Arcade's duplicate code exchange (open risk 9, #100).** |
| **Gateway token storage** | **`apps/web` drives the gateway OAuth itself (Mastra's `MCPClient.authenticate()` refuses non-loopback redirects) and hands `MCPClient` a static token. The gateway access + refresh token and the persona email live in a sealed, HTTP-only, per-browser cookie (AES-GCM under `SESSION_SECRET`, chunked when over 4KB). One persona per browser. No fourth database. Refresh is server-side. Decided 2026-09-11.** |
| **Arcade config is read-only** | **The `cg-idp` auth provider's advanced configuration is never edited; its `client_id`/`client_secret` request parameters stay. `apps/idp` adapts instead (#79: Basic header plus identical body credentials accepted). Read provider config back through `GET /v1/admin/auth_providers/<id>`, not off dashboard labels.** |
| **Authorization** | **The loan tools require OAuth against our own provider, so they call `apps/loan-app` on behalf of the user rather than as a service account. The API derives the actor from the token, never from a parameter. OAuth carries *identity*; hooks carry *authority*. Provider is Better Auth in its own service, `apps/idp` (#36).** |
| **One identity, not two** | **The Arcade `user_id`, the OAuth subject, and the actor `apps/loan-app` records are the same person, joined on email. If these ever diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction.** |
| Policy source | Policy DB owned by the hook server. Editable live on stage. |
| HITL | Custom `request_approval` tool posts Block Kit to Slack; approval link carries **no authority** |
| Approval authz | `approvals.decide` is itself a governed tool call — pre-hook enforces role, limit, and requester ≠ approver |
| Approver routing | Deterministic minimum-sufficient-clearance, requester excluded. The LLM does not choose the approver. |
| The wait | Agent ends its turn; SSE `approval.granted` event auto-resumes it |
| Determinism | The **hook** writes the remediation instruction, not the system prompt |
| **No model-side controls** | **The agent's system prompt and every tool description carry no behavioural instruction in either direction: nothing about confirming, refusing, escalating, retrying, caution or irreversibility. Measured on #14: one "irreversible, no undo" line made Claude ask permission and `/pre` never fired; one "do not ask the person to confirm" line pushed it the other way. Both removed. The prompt states role, tools, how to resolve a loan named by amount, and how to report verbatim. `tools/loan` descriptions follow (#90).** |
| **Readiness** | **Each Render service answers `/health` with one field per capability and `status: ok|degraded`, HTTP 200 either way so Render deploys and a human can read it. cg-web: `signin, gateway, verifier, agent, panel_stream`. A missing capability is named; the home page and panel show it; nothing falls back silently. Decided across #81, #82, #14.** |
| Redaction | Declarative per-tool field rules + regex over free text |
| Database | `bun:sqlite`, three files: `loans.db` (domain), `governance.db` (policy + audit), `idp.db` (people) |
| Durability | Data persists; resetting is something you deliberately run. Both databases sit on Render disks and seed from their fixture only when empty. Reset is a script (#23), never a redeploy. Decided on #29. **Consequence measured 2026-09-14 (#106): a fixture change does not reach a live disk, and acts 3 and 4 were not live while `/health` said armed. Amended: `/health` reports `fixture_drift` as degraded whenever on-disk policy differs from the shipped fixture, and a presenter-only Reset control in the panel runs the reset. Policy stays durable; the silence does not.** **Reset contract, ratified at the #23 gate 2026-09-14 (aaccdc0): every database-owning service exposes `POST /admin/reset` behind one shared `RESET_TOKEN` — route absent (404) when the variable is unset, `/health` reports `reset: enabled|disabled`, the response names what was not reset. hooks takes `{policy|demo}`; loan-app reseeds the loan book from the fixture inside the running image; idp clears people, sessions, tokens and consents and re-seeds the four personas but never touches the `oauthClient` row, and fails if the client id moved. The root `bun run reset [--target local|render]` is idempotent, exits non-zero on any refusal, and reads Render addresses from `RENDER_*_PUBLIC_HOST`, never guessed. A redeploy is not a reset; a reset is not a re-registration. **Amended 2026-09-19 (#123, human's decision): the reset is two resets.** The default calls hooks `demo` → loan-app and **leaves idp alone**; `--hard` adds idp and is the list `#174`'s second panel button reuses. The split is argued on stage time rather than safety: a hard reset signs all four personas out, costing four logins plus four authorization cards before the next take. *Not* a reason for the split: the #123 fault it was originally drawn to avoid, which does not reproduce — that was #100's replay revocation killing a fresh grant at `85e96b1`, fixed by `bbfb162` the same day. Measured separately and worth knowing: the hop-2 token is `expires_in` 3600 with no refresh token, so **any rehearsal longer than an hour costs one authorization card per persona regardless of resets**. The rehearsal script is `docs/RUNBOOK.md`.** |
| Visualization | Hook server → SSE → live three-lane Access/Pre/Post panel at `/panel`, **full-screen and on its own**. The Access lane renders **one card per persona listing** (`tools/list`), naming the tools disabled for that person; grouping is presentation-only in `apps/web` (#156). Amended 2026-09-18 from webinar rehearsal: decisions arriving one card at a time were too fast to narrate. |
| Design | Bank app deliberately boring enterprise UI; control plane unmistakably Arcade. **No split view** (reverses #22, 2026-09-18): the bank app is full-screen at `/`, the control plane full-screen at `/panel`, the loan board full-screen at `/loans`, and the presenter switches between them deliberately. Two panes updating at once could not be narrated on a webinar (#155). The panel visual is cut down for the back of the room (#158). |
| **Hosting** | **Render (`render.yaml` blueprint) for `web`, `hooks`, `loan-app`, `idp`. `arcade deploy` for `tools/loan` and `tools/approvals`.** |
| **Languages** | **TypeScript for the three Render services and everything under `packages/`. Python for both `arcade-mcp` toolkits. The boundary is *tool authoring*, not *domain*.** |

## Services

    apps/web         Next.js — chat, sign-in chrome, loan board, approval page, control-plane panel.
                     Mastra agent runs in route handlers. → Render
    apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE. Owns governance.db. → Render
    apps/loan-app    Bun — plain HTTP API, the bank's system of record. Owns loans.db.
                     No MCP, no Arcade, no governance. → Render
    apps/idp         Bun — Better Auth OAuth 2.1 provider, login and consent pages.
                     Owns idp.db. Stands in for the enterprise IdP. → Render

    tools/loan       Python arcade-mcp — search_loans, get_loan, approve_loan, deny_loan.
                     Stateless client of apps/loan-app. → arcade deploy
    tools/approvals  Python arcade-mcp — request_approval, decide. → arcade deploy

    packages/governance-core    Hook framework, policy engine, audit, event bus. Zero loan references.
    packages/policy-schema      Shared zod types for policy, events, hook payloads.

⚠️ **`apps/idp` is not a workspace member and needs its own install.** Better Auth 1.7
requires zod 4; the root manifest pins every workspace to zod 3 for the Arcade/Mastra path,
and Bun applies root overrides across the whole workspace while ignoring nested ones. So
`apps/idp` is excluded from `workspaces`, carries its own `bun.lock`, and a fresh clone needs
**two** installs:

    bun install
    bun install --cwd apps/idp     # or `bun test` fails with "Cannot find module better-auth"

That is a happy accident as much as a workaround — the service a forker deletes is also the
one depending on nothing in the template, and it carries `"cg": { "external": true }` so
`policy-schema`'s workspace sweep leaves it alone. But the second install is a real trap: a
clone-and-run comes up looking broken. It belongs in the README (#24) and in the rehearsal
runbook (#23).

`apps/hooks` and `apps/loan-app` stay separate processes on purpose: one is the governed
system, the other is the thing governing it. Forking means replacing `apps/loan-app`,
`tools/loan` and the seed data, and touching nothing under `packages/`.

That boundary is enforced by tests, not comments. `apps/loan-app` declares
`"cg": { "governed": true }` in its manifest; `knows-nothing-about-governance.test.ts`
fails if governance vocabulary or a `@cg/*` import appears in its source, and
`policy-schema`'s workspace sweep exempts flagged workspaces rather than forcing the
dependency in. Both halves read the same flag so they cannot drift apart. Decided on #33.

## Identity and OAuth

There are **two authentication hops** with two different mechanisms. Conflating them
cost a day on #75.

    Dana, in her own Chrome profile
      → apps/web  "Sign in"  (OIDC code + PKCE against apps/idp, client C; Dana types
                    her own password at cg-idp — the page never names her)
        → sealed cookie { email, gateway tokens }
      → hop 1: apps/web drives the gateway OAuth against cg-demo-us (User Source,
               HTTPS redirect /api/arcade/callback, PKCE); Arcade renders its own
               consent screen once per persona per MCP client id
      → Mastra MCPClient → https://api.arcade.dev/mcp/cg-demo-us   bearer = gateway token
        → /access   hooks see user_id = dana@…            ← layer 1
        → auth requirement: does Dana hold a cg-idp token? ← layer 2 (no hook fires)
          first time: Arcade 303s the browser to the custom verifier
            GET /api/arcade/verify?flow_id=…   (apps/web)
              · session present → POST cloud.arcade.dev/api/v1/oauth/confirm_user
                {flow_id, user_id: <session email>} server-side, then fetch next_uri
                server-side exactly once, then send the browser to apps/web's own
                Authorized page, which links to / (never to Arcade's continuation;
                human decision at the #100 gate, landed #118 e23bf57). The grant does
                not store unless next_uri is fetched (measured, #75). Arcade's Location
                from that fetch is logged and otherwise ignored.
              · no session → park flow_id in a short-lived signed cookie, send the
                browser to sign-in, and complete the same two calls from the sign-in
                callback. The verifier never reads the persona from the query string.
          then Arcade exchanges the code at apps/idp as the cg-idp provider (hop 2)
        → /pre      hooks see user_id = dana@…            ← layer 3
          → tools/loan (arcade deploy) receives Dana's OAuth token
            → apps/loan-app validates it, actor = dana@…
        → /post     hooks rewrite the output               ← layer 4

Arcade's default verifier demands an Arcade account that is a project member. Our
personas are not, and a persona verified against the wrong account binds the grant to
the wrong user and the tool re-challenges forever (observed 2026-09-11 15:40Z). The
custom verifier is what makes the IdP-asserted email the identity on hop 2, exactly as
the User Source makes it the identity on hop 1.

Three rules this has to hold to:

1. **`apps/loan-app` derives the actor from the token, never from a request parameter.**
   An actor passed as an argument is an actor the model can forge, and act 4 is
   specifically about the model trying to.
2. **Scopes are not the governance gate.** A layer-2 refusal is invisible to the control
   plane. Every beat we intend to *show* is an `/access` or `/pre` decision.
3. **Email is the join key.** Arcade `user_id`, OAuth subject, and `loans.db`'s actor
   column are the same string.

**The provider is its own service: `apps/idp` (#36).** Better Auth
(`@better-auth/oauth-provider`) on Bun, owning `idp.db`, serving a login page and a consent
page. It is a demo fixture standing in for the enterprise's real IdP — the same category of
thing as the seeded personas — and a forker deletes it and points at their Okta.

Folding it into `apps/web` was cheaper but would make our own demo UI the bank's IdP and
the agent's host the token issuer; an enterprise audience asks whether `apps/web` could
just mint itself a token, and the answer would be yes. Folding it into `apps/loan-app` was
ruled out: the boundary test greps that service's source for `role`, `permission`,
`authority` and `limit`, Better Auth's own vocabulary trips it, and loosening that test to
fit auth is the erosion it exists to prevent.

Arcade is an OAuth *client* here: it needs a client id and secret, an authorize URL, a
token URL, and its own generated redirect URI allowlisted on our side. It does not consume
OIDC discovery — endpoints are configured explicitly. It extracts the user's identity from
`/oauth2/userinfo` via a JSONPath expression, **which is what turns rule 3 from a
convention into a mechanism**.

⚠️ **Resetting `idp.db` rotates the OAuth client credentials and silently breaks the
registration held in Arcade** — and it breaks it at the authorize step, which fires no hook,
so the panel stays dark and nothing on screen explains why. The reset must leave the OAuth
client alone. Owned by #36, stated in #23's runbook.

## Tool surface

**loan** (Python, `arcade deploy`)
- `search_loans(status?, min_amount?, max_amount?)`
- `get_loan(loan_id)` → includes `bank_account_number`, `tax_id`, `underwriter_notes`
- `approve_loan(loan_id, amount)`
- `deny_loan(loan_id, reason)`

**approvals** (Python, `arcade deploy`)
- `request_approval(action, resource_id, amount, justification)` — routes deterministically, posts Block Kit
- `decide(request_id, decision, note?)` — called from the approval page as the clicker

**Names, as measured on the wire (#35, #82, #14).** Toolkits deploy as `Loan` and `Approvals`.
MCP advertises `Loan_SearchLoans`, `Loan_GetLoan`, `Loan_ApproveLoan`, `Loan_DenyLoan`,
`Approvals_RequestApproval`, `Approvals_Decide` (underscore). Hook payloads and audit rows name
the same tools with a dot: `Loan.GetLoan`. Policy rules are keyed the dot way; remediation text
that tells the model which tool to call must use the underscore spelling the model actually
sees (#89). A gateway `tools/list` carries **eight** entries: the six above plus Arcade's
built-ins `System_ManageAuthorization` and `Arcade_ListApps`; the agent filters to the two
project toolkits (`ARCADE_LOAN_TOOLKIT`, `ARCADE_APPROVALS_TOOLKIT`).

## Cast (emails confirmed 2026-09-11; held in `PERSONA_*_EMAIL`, lowercase)

| Persona | Role | Limit | Notes |
|---|---|---:|---|
| Dana Okafor | Loan Officer | $50,000 | The protagonist |
| Sam Reyes | Credit Analyst | $0 | `approve_loan` hidden entirely — act 1 |
| Riley Chen | VP Credit | $250,000 | Minimum-sufficient approver for $95K |
| Morgan Ellis | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered — proves routing |

Each persona is a person in `apps/idp`. None is an Arcade project member. Each accepts
Arcade's gateway consent screen once per browser profile per MCP client id.

Seed loan `LN-2291`, Northwind Bakery LLC, $95,000. Carries `bank_account_number` and
`tax_id` (act 3) and an `underwriter_notes` field containing an injected instruction (act 4).

## Event contract

Audit row and SSE frame (confirmed on the wire on #14; `redactions` added on #16, ca9e17f):

    { id, ts, execution_id, hook: 'access'|'pre'|'post',
      user_id, tool, decision: 'allow'|'deny'|'modify',
      reason, rule_id, redactions?: RedactionRecord[] }

    RedactionRecord = { path, rule_id, pattern_id, kind }     // where and why, never what

A `/post` `modify` says what it did through `redactions[]`, one record per thing removed:
JSONPath into the tool output, the rule and pattern that fired, and the strategy. **There is
no field for the removed value, and `before`/`after` are gone from the wire.** Both were the
obvious place to put the raw tool output, and this row is written to `audit_log` and streamed
on `GET /events`; a shape that *could* carry the account number eventually would, into the two
places most likely to be read aloud. The panel renders the mask from `redactions[]`. The
panel's fixture replay still emits the old `before`/`after` shape and `@cg/policy-schema`
still types it; #101 aligns both. Decided on #16 (driver option A), measured on the wire 2026-09-14.

What each layer answers, as measured:

- `POST /pre` denial: HTTP 200, `{ code: "CHECK_FAILED", error_message: "DENIED: … [ref evt_…]" }`;
  allow: `{ code: "OK" }`. The `[ref evt_…]` token is the correlation to the audit row (#6).
- Over MCP the denial flattens to `{ isError: true, content: [{ type: "text", text:
  "Tool execution was denied by an extension policy: DENIED: … [ref evt_…]" }] }`. Mastra
  surfaces it as a tool-error with the text in `payload.error.cause.message`.
- Layer 2 (no token yet) is the same `isError: true` envelope whose text is JSON carrying
  `authorization_url` and `llm_instructions`. No hook fires, no audit row. The chat renders
  it as an authorization link, never as a denial.
- The chat stream (`POST /api/chat`) is `application/x-ndjson`, one event per line, kinds
  `text`, `tool-call`, `tool-result`, `denied`, `fault`, `authorization`, `error`, `done`.
  `denied` requires positive evidence of a hook decision (Arcade's prefix, `CHECK_FAILED`,
  `CONTEXT_DENIED`, or the `[ref evt_…]` token); every other tool failure is `fault` and the
  UI says no decision was made. A control surface must never assert a control-plane action
  that did not happen (#14 review).

## Open risks

1. ~~**Do contextual-access hooks fire for tools served by a registered Remote MCP
   server?**~~ **Resolved twice over.** Measured yes for Remote MCP servers and for hosted
   toolkits — `docs/spikes/02-remote-mcp-hooks.md` (#2), with raw payloads. Confirmed in
   session by Arcade: **hooks apply to all tools regardless of where the server is hosted**,
   including `arcade deploy`'d toolkits, which is the path this demo now runs on. Spike #2
   remains valid and is now documentation of a capability the live demo no longer exercises,
   since nothing here is registered as a Remote MCP server.

2. **Layer-2 refusals are invisible to the control plane.** Measured, spike #2: an unmet
   auth requirement returns `tool_requirements_not_met` and no hook fires — no `/pre` event,
   no audit row, nothing on the panel. Not an architectural problem, but it constrains two
   slices: **#14/#21** must not stage a beat as an auth failure, and **#12**'s audit schema
   cannot claim `governance.db` is a complete record of refusals. Worth a line in the panel
   naming the layer that refuses upstream of the hooks.

3. ~~**Toolkit names are unmeasured.**~~ Measured: `Loan`, `Approvals`; see **Tool surface**.

4. **Identity could silently split.** Arcade `user_id` and the OAuth subject must be the
   same email. Both hops now have a mechanism: the User Source signs the persona in at
   `apps/idp` for hop 1, and the custom verifier binds the IdP-asserted email at hop 2
   (#75, #14a). The remaining hazard is the default verifier: with the custom route
   disabled, a browser signed into account.arcade.dev as someone else binds the grant to
   that someone, and every later call re-challenges. Keep the custom verifier route
   configured; check it via the admin API, not the dashboard label.

5. ~~**Does Arcade's stock Slack provider grant a user token with `chat:write`?**~~
   *Answered: yes — `docs/spikes/03-slack-scopes.md` (#3). Act 2 posts as the requester.
   The tool must request four scopes, not three: `users:read` is a prerequisite for
   `users:read.email`.*

6. ~~**What survives a hook denial over MCP?**~~ Measured on #14; see **Event contract**. The
   `[ref evt_…]` token survives and is what lets the chat tell a denial from a fault.

7. ~~**Act 2 depends on act 4's control (#91).**~~ **Resolved on #16 (ca9e17f).** With the injected
   note visible, the $95K beat reached `/pre` about 5 of 17 runs. With `/post` stripping the note
   before the model sees it, 5 of 5 (implementer) and 5 of 5 again (reviewer, independently, live
   Claude Sonnet 5 at temperature 0); LN-2299 control 5 of 5. Act 2 is deterministic again with no
   prompt steering. The local gateway stand-in now calls `/post` too, so the offline tracer is no
   longer more hostile than production. #91 closed.

8. **The remediation instruction names a tool the agent may not hold, in a spelling it never
   sees (#89).** `pre.approve-within-clearance` says `Approvals.RequestApproval`; the model
   sees `Approvals_RequestApproval`, and only if the approvals toolkit is in its surface.
   Claude refused the instruction in 2 of 5 runs on principle, which is the instinct this
   project wants. Decide the spelling on #19/#20 before act 2's second half is built.

9. ~~**Hop 2's grant dies on a fresh authorization (#100).**~~ **Resolved in two rounds.** Measured 2026-09-14: the
   authorization code was exchanged at `apps/idp` more than once per flow, and Better Auth's token endpoint revokes the
   tokens the first exchange minted when a consumed code is replayed, so the grant Arcade stored was already dead.
   PR #115 removed the browser's replay (the verifier fetches `next_uri` once, server-side, and the browser goes to the
   app's own page, #118). A second exchange still arrived 290 ms after that single fetch
   (`21:05:28.094Z [verifier] next_uri answered 200, location (none)` against
   `21:05:28.383Z [idp] … code=already_consumed`), from Arcade's side. Per the standing decision the provider
   configuration is never edited; **the IdP adapts (PR #127):** every `/oauth2/token` request is logged with UTC
   millisecond arrival, grant, code prefix, outcome, User-Agent and first forwarded hop, and a replayed code still
   answers `invalid_grant` but **no longer revokes the first exchange's tokens**. That is a deliberate deviation from
   RFC 6749 §4.1.2, whose SHOULD assumes a replay is evidence of a leaked code; here it is a measured property of one
   relying party using the same client credentials. The guard matches only the plugin's token delete keyed on a lone
   `authorizationCodeId`; sign-out, `/oauth2/revoke` and the reset still delete, asserted by test.

## Sequence (~2.5 weeks)

1. Spikes 1–3. **Done.**
2. Scaffold, policy schema, loan book. **Done** (#4, #5, #11).
3. Split into `apps/loan-app` + `tools/loan`; measure the toolkit names (#34, #35).
   In parallel: `apps/idp` (#36).
4. Arcade wiring: gateway, hook extension, OAuth provider (#13).
5. Identity in `apps/web` (#82) and the tracer bullet (#14). **Done 2026-09-12**; this
   document re-grounded from the wire the same day.
6. Acts 3 and 4 first — `/post` redaction and injection strip (#16, #17) — because act 2
   cannot fire reliably while the note is visible (#91). Act 1's UI (#15) in parallel.
   **#16 done 2026-09-14 (ca9e17f), re-measured 5/5; #91 closed.** #17 remains for whatever the
   injection strip still needs beyond #16's engine; the split-screen shell (#22) landed the same day.
7. Approvals: Slack, approval page, `decide` as a governed call, auto-resume. Resolve #89
   (tool spelling in remediation text, approvals toolkit in the agent's surface) first.
8. Control-plane panel and the split-screen UI.
9. Rehearsal, reset script, README for forkers. **Reset + runbook done 2026-09-14 (#23, aaccdc0); three deployed rehearsals pending (human + driver).**

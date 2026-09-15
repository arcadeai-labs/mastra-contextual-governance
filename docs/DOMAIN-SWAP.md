# Swapping the domain — pointing this template at your own business system

This template governs a commercial bank's loan book. Nothing about the control plane
is about loans. This document is the concrete walk from the loan domain to yours.

The promise, stated as an instruction rather than a claim:

> Replace **`apps/loan-app`** (the business system), **`tools/loan`** (the Arcade
> toolkit that wraps it) and the **seed fixtures**. Touch nothing under `packages/`.

That is a better story than the one this repo started with. You are not writing an MCP
server — you are pointing a thin Python toolkit at an API you already have, and
inheriting four control points over every call an agent makes to it.

Read [`DESIGN.md`](../DESIGN.md) first. This document assumes its vocabulary: four
control layers, two OAuth hops, three databases.

---

## What you are replacing, and what you are keeping

| | | |
|---|---|---|
| `apps/loan-app` | **replace** | The system of record. A plain HTTP API over `loans.db`. Yours already exists — you probably delete this directory rather than edit it |
| `tools/loan` | **replace** | Four Python `arcade-mcp` tools, each a stateless client of the API above |
| `apps/hooks/src/fixtures/governance.json` | **rewrite** | The catalogue, the roster, the rules |
| `apps/idp` | **delete** | The enterprise IdP, as a demo fixture. You have an Okta |
| `apps/web/lib/identity/session.ts` | **repoint** | One function pair, `readSession` / `readSessionFromCookies` |
| `apps/web` — everything else | **keep** | Chat, panel, approval page, split screen |
| `apps/hooks` — everything else | **keep** | `/access`, `/pre`, `/post`, audit, SSE, reset |
| `packages/` | **do not touch** | The hook framework, the policy engine, the shared types |
| `tools/approvals` | **keep** | Routing and Slack are domain-independent; it names actions, not loans |

Eight seams follow, each with a path, then the boundary check and how to run it. Work
them in order — later ones read values the earlier ones produce.

---

## 1. The governed system — `apps/loan-app`

The bank's system of record. A Bun HTTP API, five routes, owning `loans.db`:

```
GET  /loans?status=&min_amount=&max_amount=
GET  /loans/:loan_id
POST /loans/:loan_id/approve   { amount }
POST /loans/:loan_id/deny      { reason }
GET  /health
```

**If you already have this service, you delete the directory and skip to §2.** That is
the intended path and it is what makes this a template rather than a framework: the
governed system is the one part of the architecture this repo has no opinion about.

If you are writing a stand-in, three properties are load-bearing and one is the whole
demo:

1. **It derives the actor from the bearer token, never from a request parameter.**
   `apps/loan-app/src/index.ts` validates every token against the identity provider's
   `/oauth2/userinfo` and records the email that comes back as `decided_by`. A body
   that tries to name an actor is a `400`. An actor passed as an argument is an actor
   the model can forge.
2. **It knows nothing about governance**, and that is enforced rather than asserted —
   see §9.
3. **It returns sensitive fields in full.** `GET /loans/:id` hands back the borrower's
   bank account number, tax ID and the underwriter's notes. Redacting them is the
   post-execution hook's job, and a service that did it itself would leave nothing to
   demonstrate.

### The seed fixture

`apps/loan-app/src/fixtures/loans.json` — read once, when `loans.db` has no schema.
Later boots leave accumulated decisions alone (see **Durability** in `DESIGN.md`).

Your fixture needs one record that carries the beats you intend to show:

| the demo's `LN-2291` | your equivalent |
|---|---|
| an amount over the protagonist's authority | a record whose write your protagonist may not make |
| `bank_account_number`, `tax_id` | two fields nobody at that clearance should read |
| an `underwriter_notes` ending in an instruction aimed at whatever model reads it | one free-text field carrying a plausible injected instruction |

Keep a **control record** too. The loan book's is `LN-2299`: equally over the
protagonist's authority, no injected note. It exists to tell two failures apart when an
act misbehaves — see [`RUNBOOK.md`](./RUNBOOK.md) §4.2.

> Write the injected instruction the way a real note with a poisoned paste in it would
> look, not the way a test case looks. It is data, not configuration.

---

## 2. The tools — `tools/loan`

A Python `arcade-mcp` package, shipped with `arcade deploy`. Four tools, each a
stateless `httpx` call carrying the end user's OAuth token. Nothing here holds state and
nothing here decides anything.

Copy the directory, rename it, and change five things:

| file | what |
|---|---|
| `tools/<yours>/pyproject.toml` | `name`, `description`, and `[project.entry-points.arcade_toolkits] toolkit_name` |
| `tools/<yours>/<yours>/__init__.py` | `MCPApp(name=...)` — **this** is what becomes the toolkit name, not the package name |
| same file | `IDP_PROVIDER_ID` — the Arcade auth provider id your tools authenticate against |
| same file | `LOAN_APP_HOST_SECRET` — the Arcade secret naming your API's host |
| same file | the four `@app.tool` functions, their signatures and their descriptions |

### The tool descriptions are the asset

They were written to be picked by a model without prompt coaching and reviewed on that
basis. One rule survives the swap, and one known exception is tracked:

- **Your replacement descriptions must carry no behavioural instruction, in either
  direction.** Nothing about confirming, refusing, escalating, retrying, caution or
  irreversibility. Measured on #14: one "irreversible, no undo" line made the model ask
  permission and `/pre` never fired; one "do not ask the person to confirm" line pushed it
  the other way. The current checked-in loan toolkit still contains those caution lines
  (`tools/loan/loan/__init__.py:186,200`), and the local stand-in mirrors them
  (`apps/web/scripts/gateway-stand-in.ts:236,254`). The kept approvals toolkit also has
  flow-steering instructions at `tools/approvals/approvals/__init__.py:169`; do not copy
  those either. The loan-description cleanup is **#90**, still open.
  When you copy the toolkit, say what each tool does and what its arguments mean, then
  complete #90's equivalent cleanup before deploying.
- **`tool.metadata` never reaches a hook payload**, for any tool. `Behavior`,
  `read_only`, `operations` are for clients, not for policy. Do not key a rule on one.

### The name Arcade files it under is measured, not chosen

`arcade deploy` starts `tools/<yours>/server.py`, reads `serverInfo.name` off its `initialize`
response, splits it on underscores and **PascalCases** it. `arcade-mcp` PascalCases the
tool functions itself, before Arcade ever sees them.

| `MCPApp(name=...)` | toolkit | tools |
|---|---|---|
| `loan` | `Loan` | `Loan.SearchLoans`, `Loan.GetLoan`, `Loan.ApproveLoan`, `Loan.DenyLoan` |
| `loan_mcp_probe` | `LoanMcpProbe` | `LoanMcpProbe.PingProbe` |

Underscores are consumed; `mcp` is **not** stripped (that is where `arcade deploy`
differs from Remote MCP registration). Hyphens are rejected by `MCPApp` at
construction. Full measurement in [`tools/loan/README.md`](../tools/loan/README.md).

**Deploy first, then read the name back, then write rules against it.** Do not derive
it:

```sh
cd tools/<yours> && arcade deploy
# then read it back
curl -fsS -H "Authorization: Bearer $ARCADE_API_KEY" \
  https://api.arcade.dev/v1/workers/<server>/tools | jq '.items[].fully_qualified_name'
```

Put the observed toolkit name in `ARCADE_LOAN_TOOLKIT`. **A rule keyed on the wrong
string matches nothing, and a rule that matches nothing is indistinguishable from a rule
that permits.** It is the recurring failure mode of this whole project: it looks like a
working demo.

### Two spellings of one name, and they are not interchangeable

| where | spelling |
|---|---|
| MCP `tools/list`, and therefore what the model can call | `Loan_GetLoan` |
| hook payloads, audit rows, policy rules | `Loan.GetLoan` |

Key rules the dot way. Write the underscore spelling in any text **addressed to the
model** — a `/pre` denial's remediation sentence, for instance, because the model can
only call the name its own tool list carries. `apps/hooks` enforces the difference: a
reason naming a catalogued toolkit dot-spelled does not compile (#89).

---

## 3. The policy — `apps/hooks/src/fixtures/governance.json`

The one file that is entirely about your domain and lives outside it. Four keys.

### `catalogue` — what exists

```json
"catalogue": {
  "$LOAN": { "GetLoan": ["loan_id"], "ApproveLoan": ["loan_id", "amount"] },
  "$APPROVALS": { "RequestApproval": ["action", "resource_id", "amount", "justification"] }
}
```

`$LOAN` and `$APPROVALS` are **placeholders**, substituted at seed time with
`ARCADE_LOAN_TOOLKIT` and `ARCADE_APPROVALS_TOOLKIT`
(`apps/hooks/src/policy-store.ts`, `TOOLKIT_PLACEHOLDERS`). Keep the indirection: it is
what stops a measured toolkit name from having to be typed into a dozen rows.

The catalogue is a closed world. A rule condition may only read an argument the
catalogue lists, and a tool the catalogue does not list is denied rather than ignored —
`packages/governance-core/src/policy-engine.ts`. So the catalogue is the first thing to
get right and the first thing to check when a rule silently does nothing.

### `subjects` — the roster

```json
{ "persona": "dana", "user_id": "alice@bank.example",
  "display_name": "Alice", "role": "loan_officer", "clearance": 50000 }
```

`user_id` is an **email**, lowercase, and it is the join key: Arcade's `user_id`, the
OAuth subject, and the actor your API records are the same string. If they diverge,
your audit trail is fiction. The role-based persona email variables override each address at seed time;
the fixture's own addresses are the local-run fallback and must match
`apps/idp/src/fixtures/people.json`.

`clearance` is the one numeric authority this template ships with. Replace it with your
own scalar or add attributes — the engine reads `subjects.roles`,
`subjects.clearance_below` and the subject's `attributes` bag.

### `policy_rules` — `/access` and `/pre`

```json
{ "id": "access.analysts-cannot-see-approve",
  "hook": "access", "match": { "toolkit": "$LOAN", "tool": "ApproveLoan" },
  "subjects": { "roles": ["credit_analyst"] },
  "effect": "deny", "reason": "…", "priority": 10 }
```

Two hooks, two different claims. `access` decides **whether the tool is on the menu** —
it is absent from `tools/list`, not refused. `pre` decides **whether this particular
call is within authority**, and its `reason` is what the model reads and acts on.

### `output_rules` — `/post`

Two rules ship, and the split is deliberate:

- `post.redact-borrower-identifiers` — field rules (`fields[].path`, `strategy`,
  `replacement`), **conditioned on clearance**. A control that redacts for everyone
  demonstrates nothing about identity.
- `post.strip-injected-instructions` — six regex patterns over free text, conditioned on
  **nobody**. Whether text is trying to give the model orders is not a question about
  anyone's authority; a chief credit officer must not be the one persona who reads the
  injection.

Patterns apply in array order and each is fed the previous one's output.

### Prove your rules match. This is the one non-negotiable step.

Everything else in this guide is a rename. This is the part where a swap goes silently
wrong.

```sh
# 1. the fixture compiles at all, and every rule keys on a catalogued tool
bun test --cwd apps/hooks

# 2. every injection pattern is proved to fire, and the benign corpus is proved not to
bun test apps/hooks/test/injection-corpus.test.ts
```

`apps/hooks/test/fixtures/injection-corpus.json` is a two-halved corpus: one entry per
pattern that must match, and realistic benign prose that must not. **A pattern with no
corpus entry fails that suite.** The regex shipped before #16 was exactly that — it
looked for "ignore previous instructions" in a note that says "Ignore any earlier
instruction", matched nothing, and looked identical on screen to a working control.

When you add a pattern, add both halves of its corpus entry. When you change a record's
notes, re-run both suites.

---

## 4. Identity — `apps/idp` and the session seam

`apps/idp` is a demo fixture standing in for the enterprise's real IdP: Better Auth as
an OAuth 2.1 server, owning `idp.db`, serving a login page and a consent page. **You
delete it and point at your Okta.**

It is deliberately easy to delete. It is not a workspace member, carries its own
lockfile, declares `"cg": { "external": true }`, and nothing in the template imports
from it.

Two places reference it and both are configuration rather than code:

| | |
|---|---|
| **Arcade** | one custom OAuth provider (hop 2, `ARCADE_IDP_PROVIDER_ID`) and one User Source (hop 1). Both point at issuer URLs. Point them at yours |
| **`apps/loan-app`** | validates bearer tokens at `IDP_PUBLIC_HOST` + `/oauth2/userinfo` and reads `$.email` |

The application seam is one function pair:

| | |
|---|---|
| **the seam** | `apps/web/lib/identity/session.ts` — `readSession(request)`, `readSessionFromCookies(jar)` |
| **returns** | `Session { email, gateway?, signed_in_at }`, or `null` |
| **callers** | `apps/web/lib/agent/handlers.ts`, `apps/web/lib/agent/tool-list.ts`, `apps/web/app/chat/page.tsx`, `apps/web/app/page.tsx`, `apps/web/lib/identity/verifier.ts` |
| **keep** | the two signatures, and `email` being the join key |
| **delete** | `apps/idp`, `apps/web/lib/identity/oidc.ts`, `apps/web/lib/identity/personas.ts`, `apps/web/lib/identity/roster.ts`, `apps/web/components/identity/SignInPanel.tsx` |

Point `readSession` at your own session store and return a `Session` whose `email` is
the address your directory knows the person by. Nothing downstream reads an identity
from anywhere else — the verifier refuses a request that tries to carry one with a
`400`. The full table is in
[`apps/web/README.md`](../apps/web/README.md#the-identity-seam-a-forker-replaces).

The `gateway` field is the one thing to think about rather than swap: it holds this
person's Arcade gateway token, which is how the tool call reaches Arcade as them. A
real IdP replaces how the **session** is established, not hop 1.
`apps/web/lib/identity/handlers.ts::liveGatewayToken` stays.

> ⚠️ Your IdP must publish a `jwks_uri` with RS256 keys, or Arcade will not accept it as
> a User Source — measured on [spike #4](./spikes/04-user-source.md), where an IdP with
> HS256 ID tokens and no key set was refused at the form. Any real enterprise IdP does
> this; `apps/idp` had to be changed to.

---

## 5. Approvals — `tools/approvals`

**Keep it.** It routes on `action`, `amount` and the roster, and never on what the
resource is. `action` is a bare action name, not a fully-qualified tool: resolving it
needs the catalogue, which the control plane has and this toolkit deliberately does not.

Two things to align with your domain:

- The `action` strings your `/pre` remediation text names (`approve_loan` in the loan
  book) must be the ones `POST /approvals` receives.
- The Slack message body in `tools/approvals/approvals/message.py` names the action and
  the resource. It is domain-flavoured prose, not domain-coupled code.

The approval link **carries no authority** — no token, no signature, no query string —
and `tools/approvals/tests/test_message.py` asserts it, because that is exactly the
convenience someone adds back later. Keep that test.

---

## 6. The agent and the left half — `apps/web`

`apps/web` is mostly domain-free: the chat, the panel, the approval page and the split
screen's frame all survive a swap untouched. **Fourteen files do not.** None of them
carries a control, and they fall into five groups.

### The agent

| | |
|---|---|
| `apps/web/lib/agent/agent.ts` | the system prompt: role, tools, how to resolve a record named by amount, how to report verbatim |
| `apps/web/lib/identity/roster.ts` | email → display name and role, label direction only |

**The system prompt carries no behavioural instruction**, and that is the demo's
methodology rather than a style preference. Nothing about confirming, refusing,
escalating, retrying, caution or irreversibility. If your swapped demo needs a sentence
in the prompt to reach the hook, the run is proving the prompt. Measured on #14 and
again on #16; round 1 of #88's review removed exactly such a sentence.

### The reads behind the left half (#109)

These are the files that decide *what the boring enterprise app puts on screen*, and
they are the ones a forker is most likely to miss — the guide missed them until round 2
of this PR's review.

| | |
|---|---|
| `apps/web/lib/loan-context/loans.ts` | the records the left half shows, by id — `DEMO_LOAN_IDS = ["LN-2291", "LN-2299"]` — and the field types one read comes back as |
| `apps/web/lib/loan-context/read.ts` | runs two `Loan_GetLoan` calls on an already-open gateway session. Rename the tool, keep the shape |
| `apps/web/lib/home/surface.ts` | one gateway session per page load, answering both of `/`'s questions: the persona's tool list (act 1) and those reads |
| `apps/web/app/page.tsx` | `/` itself — the server component that calls `apps/web/lib/home/surface.ts` and hands the result to the split screen |

> ⚠️ **Do not replace these with a database read.** Opening your own database, or calling
> your API with a service credential, is faster and makes the screen a liar. The claim
> this demo makes is that *every* read of the system of record passes the control plane,
> keyed on who is asking — so the left half goes through an MCP client of the gateway
> with the signed-in person's bearer, exactly like the agent, and shows up in the audit
> log like any other call. With `/post` redaction live, a pane that reached past the
> hooks would show an unmasked account number inches from a panel asserting there is only
> one path to the data.

### The bank pane

The whole directory is yours to replace: `apps/web/components/bank/`.

| | |
|---|---|
| `apps/web/components/bank/BankPane.tsx` | the left half's chrome — tabs, navy bar, a release number nobody has bumped since 2009 |
| `apps/web/components/bank/LoanFiles.tsx` | the list of records under review |
| `apps/web/components/bank/LoanFileCard.tsx` | one record: every field name and every label |
| `apps/web/components/bank/format.ts` | currency, dates, the masked-field rendering |
| `apps/web/components/bank/bank.css` | the deliberately dull styling |
| `apps/web/components/bank/ToolListSlot.tsx` | where act 1's tool list sits inside the pane |

**Keep it ugly.** Square corners, hairline rules, uppercase field labels, four tabs that
go nowhere. A beautiful left half quietly undoes the argument: it makes the governed
system look like part of the same product as the thing governing it.

### Two files that are renames rather than replacements

| | |
|---|---|
| `apps/web/components/shell/SplitScreen.tsx` | generic frame; carries a `loanFiles` prop typed from `apps/web/lib/loan-context/loans.ts`. Rename the prop, keep the component |
| `apps/web/lib/governance/access-fanout.ts` | the panel's **fixture replay** — pins the measured access-row fanout using `Loan.GetLoan` and `Loan.ApproveLoan` as sample tool names. Not a live path; update it or leave it as a replay of somebody else's demo |

### Six user-visible strings, in files you otherwise keep

Not seams — one line each, in a file whose logic is entirely generic. They are on this
list because a heading reading "Loan operations" above somebody else's demo is exactly
the leftover this guide exists to prevent.

| | |
|---|---|
| `apps/web/app/chat/page.tsx` | the page heading, `Loan operations` |
| `apps/web/components/chat/Chat.tsx` | the placeholder prompt (`Approve the loan for $95K…`) and a denial caption naming the loan book |
| `apps/web/components/governance/ControlPlaneStatus.tsx` | the Reset confirmation, which names `loans.db` |
| `apps/web/lib/governance/control-plane.ts` | the Reset result sentence |

`apps/web/lib/agent/handlers.ts` and `apps/web/lib/config.ts` also match, but only on the
variable name `ARCADE_LOAN_TOOLKIT` — that is §7's configuration seam, not a string to
edit here.

### The sweep, so you can repeat it

```sh
grep -ril loan apps/web/lib apps/web/components apps/web/app
```

**38 files on `a70be04`.** Thirteen of the fourteen named above are in that list
(`apps/web/lib/identity/roster.ts` is the exception — it carries roles, not loans). Of the
remaining **25**, six are the strings above and `ARCADE_LOAN_TOOLKIT`'s two readers, and
**18 have zero non-comment matches** — every occurrence is explanatory prose in a
docblock.

Run the same sweep against your own vocabulary once the swap is done. Anything still
holding the old domain is a file this list did not know about, and that is a finding
worth an issue rather than a quiet edit.

---

## 7. Configuration

Every variable, its owner and where its value comes from is one table in the
[root README](../README.md#every-environment-variable). The domain swap touches:

| | |
|---|---|
| `ARCADE_LOAN_TOOLKIT` | your toolkit name, **measured off a real deploy**, not derived |
| `ARCADE_APPROVALS_TOOLKIT` | unchanged unless you rename `tools/approvals` |
| `ARCADE_IDP_PROVIDER_ID` | the Arcade auth provider id your tools require |
| `LOAN_APP_PUBLIC_HOST` | your API's host. Rename the variable, and rename it in the toolkit's `requires_secrets` at the same time |
| `PERSONA_<ROLE>_EMAIL` | your cast's role addresses, read once at first seed |
| `LOANS_DB_PATH` | only if you keep a database of your own |

Renaming a `*_PUBLIC_HOST` variable is three places, and all three must move together:
the toolkit's `requires_secrets` list, `.env.example`, and `render.yaml`. The Arcade
secret is uploaded from `.env` by `arcade deploy`, which is the one configuration
channel a deployed toolkit has.

---

## 8. Marking your app: `"cg": { "governed": true }`

Your business system declares this in its `package.json`:

```json
"cg": { "governed": true }
```

One flag, read by **both halves** of the forkability boundary, which is why they cannot
drift apart:

| reader | what it does with it |
|---|---|
| `apps/<yours>/test/knows-nothing-about-governance.test.ts` | asserts the flag is present, and fails if governance vocabulary or a `@cg/*` import appears in `src/` |
| `packages/policy-schema/test/consumable.test.ts` | sweeps every workspace requiring it to declare `@cg/policy-schema`, and **exempts** the flagged one |

Without the flag, the sweep would put the governance vocabulary back inside the business
system and the two tests would contradict each other (#33).

The flag is read off the manifest rather than matched on a directory name on purpose:
`packages/` keeps business-domain code out of its runtime source, so a forker marking
their own app inherits both halves automatically. The literal package-boundary check is
clean now: `grep -ri loan packages/` prints no matches and exits 1, which is the expected
result for a grep that found no domain vocabulary. There is a sibling,
`"cg": { "external": true }`, which `apps/idp` carries — it means "stands in for a system
outside the template", and it exempts the directory from the same sweep without claiming
it is governed.

Copy `apps/loan-app/test/knows-nothing-about-governance.test.ts` into your app and edit
its `FORBIDDEN` list to your own vocabulary. Ship the test. It is the thing that says no
when someone wants to add "just one guard" to the business system, and that pull is
real.

### `@cg/governed-app`

You will meet this name and there is no such package. It is a **stand-in app name**,
used as literal test data in `packages/governance-core/test/no-app-dependencies.test.ts`
to prove that eleven different import forms — static, type-only, default, namespace,
re-export, side-effect, dynamic, `require`, single-quoted, and a relative path that
climbs into `apps/` — are all recognised as dependencies on an app.

It is deliberately not a real app name: this fixture exercises import recognition without
coupling a package to a real business system. That guard is what enforces "the hook
framework does not depend on the business system" from the framework's side.

---

## 9. The boundary, verified rather than asserted

Two tests enforce it, in opposite directions:

| test | claim |
|---|---|
| `packages/governance-core/test/no-app-dependencies.test.ts` | governance-core declares no dependency on an app package and imports from none |
| `apps/loan-app/test/knows-nothing-about-governance.test.ts` | the business system mentions no governance vocabulary and imports no `@cg/*` |

Run both:

```sh
bun test packages/governance-core/test/no-app-dependencies.test.ts \
         packages/policy-schema/test/consumable.test.ts \
         apps/loan-app/test/knows-nothing-about-governance.test.ts
```

### The grep, and its honest result

`#24` asks for a third check, written down so it stays true:

```sh
grep -ri loan packages/
```

On current `origin/main` at `c9baca2`, this prints no matches and exits with status 1.
The exit status is expected for a grep with no matches, not a failed boundary check; its
empty stdout is the result to preserve. The `packages/` tree therefore contains no
`loan` references in the current source of truth.

The domain-specific acts 3 and 4 pin now lives beside the fixture in
`apps/loan-app/test/acts-3-4-redaction.test.ts`. A forker replaces that test with the
business app and seed data, leaving the reusable redaction suite and the rest of
`packages/` domain-free.

The enforced boundary and consumability checks pass in the current tree:

```sh
bun test packages/governance-core/test/no-app-dependencies.test.ts \
         packages/policy-schema/test/consumable.test.ts \
         apps/loan-app/test/knows-nothing-about-governance.test.ts
# → 34 pass, 0 fail
```

---

## 10. Run it

```sh
bun install
bun install --cwd apps/idp          # not optional; see the README
cp .env.example .env                # then fill it in

bun run typecheck
bun test                            # includes both boundary tests
bun run reset                       # three databases back to their fixtures
```

Then the whole system, with your domain in it, against a real Arcade project: the
ordered setup is [the root README](../README.md#setup-from-zero), and the rehearsal
script — the four acts, what the panel shows at each beat, and what to do when one
misbehaves — is [`docs/RUNBOOK.md`](./RUNBOOK.md).

---

## The checklist

- [ ] Business system replaced or deleted; actor derived from the token, never a parameter
- [ ] Seed fixture carries an over-authority record, sensitive fields, an injected note, and a control record
- [ ] Toolkit copied, renamed, `MCPApp(name=…)` set; descriptions carry no behavioural instruction
- [ ] `arcade deploy` run, toolkit name **read back** and put in `ARCADE_LOAN_TOOLKIT`
- [ ] `apps/hooks/src/fixtures/governance.json` rewritten: catalogue, roster, policy rules, output rules
- [ ] Every injection pattern has both halves of a corpus entry; `bun test --cwd apps/hooks` green
- [ ] `readSession` pointed at your IdP; `apps/idp` deleted; Arcade's provider and User Source repointed
- [ ] `"cg": { "governed": true }` on your app's manifest, and its `knows-nothing` test shipped
- [ ] Both boundary tests green
- [ ] One act driven end to end, and a `/pre` row in the audit log with your `user_id` on it

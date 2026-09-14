# Contextual Governance — Mastra × Arcade

An agent that does real work in a real business system, with [Arcade](https://arcade.dev)
enforcing deterministic control at four points on every tool call: **whether you can see
the tool**, **whether you hold the credential to call it**, **whether you have the
authority for this call**, and **what comes back**.

A loan officer asks the agent to approve a $95K loan and to double-check its work. Four
things go wrong. The control plane catches all four. The model never gets a vote.

Built with [Mastra](https://mastra.ai), Next.js, Bun, SQLite and TypeScript — plus two
Python `arcade-mcp` toolkits, which is what the agent's tools are authored in.

**`main` is a forkable template.** The loan book is a worked example; pointing it at your
own business system is [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md).

---

## What it demonstrates

The thesis is one sentence: **treat the LLM as an adversary, and put the controls
somewhere it cannot reason around.** Everything below follows from it.

### The four control points

| # | Layer | Keyed on | Mechanism | Act |
|---|---|---|---|---|
| 1 | Whether you can see the tool | identity | `POST /access` → `deny` list | 1 |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes | — |
| 3 | Whether you have the authority for *this* call | identity + policy | `POST /pre` → `CHECK_FAILED` | 2 |
| 4 | What comes back | policy | `POST /post` → `override.output` | 3, 4 |

Layers 1, 3 and 4 are HTTP endpoints this repo serves; Arcade calls them. Layer 2 is
Arcade's own.

> ⚠️ **Layer 2 is invisible to the control plane, and that constrains what you can
> stage.** Arcade evaluates auth requirements *before* `/pre`, so a refusal there fires
> no hook, writes no audit row and shows nothing on the panel (measured,
> [spike #2](./docs/spikes/02-remote-mcp-hooks.md)). If something you expected to see is
> missing, check the OAuth registration before you suspect the control plane.

### The four acts

| # | Beat | Control | Mechanism |
|---|---|---|---|
| 1 | Sam, a credit analyst, literally cannot see `ApproveLoan` | Access | `/access` → `deny` |
| 2 | Dana's $95K exceeds her $50K authority → blocked → routed approval → retry succeeds | Pre | `/pre` → `CHECK_FAILED` + remediation |
| 3 | `GetLoan` returns a bank account number → redacted before the model reads it | Post | `/post` → `override.output` |
| 4 | A seeded underwriter note carries an injected instruction → stripped | Post | `/post` → regex scanners |

The prompts as measured, what the panel shows at each beat, and what to do when an act
misbehaves live: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).

### Two things that are enforced rather than claimed

**The business system does not know it is governed.**
`apps/loan-app/test/knows-nothing-about-governance.test.ts` fails if the words `policy`,
`role`, `limit`, `redact`, `authority`, `approver` or `permission` appear in its source,
or if it imports a `@cg/*` package. The pull to add "just one guard" there is real, and
that test is the thing that says no.

**A control that silently does nothing is worse than no control.**
A rule keyed on a toolkit name Arcade does not use matches nothing, and a rule that
matches nothing is indistinguishable from a rule that permits — it looks exactly like a
working demo. Every identifier in this repo is measured off a real deployment rather
than derived, and every `/post` pattern is proved to fire against a corpus.

---

## Layout

```
apps/web         Next.js — chat, persona switcher, approval page, control-plane panel.
                 The Mastra agent runs in route handlers.               → Render
apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE.
                 Owns governance.db.                                    → Render
apps/loan-app    Bun — plain HTTP API, the bank's system of record. Owns loans.db.
                 No MCP, no Arcade, no governance.                      → Render
apps/idp         Bun — Better Auth OAuth 2.1 provider, login and consent pages.
                 Owns idp.db. A demo fixture standing in for the enterprise's
                 real IdP; a forker deletes it and points at their Okta. Not a
                 workspace member — has its own lockfile.               → Render

tools/loan       Python arcade-mcp — search_loans, get_loan, approve_loan, deny_loan.
                 Stateless client of apps/loan-app.               → arcade deploy
tools/approvals  Python arcade-mcp — request_approval, decide.    → arcade deploy

packages/governance-core   Hook framework, policy engine, audit, event bus.
                           Zero domain references, zero dependencies on apps/*.
packages/policy-schema     Shared zod types for policy, events, hook payloads.
```

Each directory has its own README, and they are the territory — this file is the map:
[`apps/web`](./apps/web/README.md) ·
[`apps/hooks`](./apps/hooks/README.md) ·
[`apps/idp`](./apps/idp/README.md) ·
[`tools/loan`](./tools/loan/README.md) ·
[`tools/approvals`](./tools/approvals/README.md) ·
[`packages/governance-core`](./packages/governance-core/README.md) ·
[`packages/policy-schema`](./packages/policy-schema/README.md)

### Why the services are split this way

**`apps/hooks` and `apps/loan-app` are separate processes on purpose.** One is the
governed system, the other is the thing governing it. Fold them together and "the
controls live outside the business system" becomes a claim about file organisation.

**`apps/loan-app` is not an MCP server on purpose.** Banks have APIs, not MCP servers.
Keeping the tool layer in `tools/loan` is what makes the forking promise real: you point
a thin toolkit at an API you already have, rather than writing an MCP server.

**The toolkits are Python and everything else is TypeScript.** `arcade-mcp` is the
tool-authoring framework and it is Python-only. The boundary is *tool authoring*, not
*domain* — nothing else in the repo is Python.

**`apps/idp` is its own service, not part of `apps/web`.** Folding it in would make our
own demo UI the bank's IdP and the agent's host the token issuer; an enterprise audience
asks whether `apps/web` could just mint itself a token, and the answer would be yes.
Folding it into `apps/loan-app` trips the boundary test above, because Better Auth's own
vocabulary is `role` and `permission`.

### Two OAuth hops, two mechanisms

Conflating them cost a day. Full diagram in [`DESIGN.md`](./DESIGN.md#identity-and-oauth).

| | hop | mechanism |
|---|---|---|
| **1** | MCP client → gateway | the gateway's **User Source**, `cg-demo-us`, backed by `apps/idp` |
| **2** | tool → your API | a **custom user verifier** route in `apps/web`, `/api/arcade/verify` |

Neither mechanism moves the other. Arcade's *default* verifier demands an Arcade account
that is a project member; our personas are not, so a persona verified against the wrong
account binds the grant to the wrong user and the tool re-challenges forever. Keep the
custom verifier route configured, and check it through the admin API rather than off a
dashboard label.

**Email is the join key.** Arcade's `user_id`, the OAuth subject and the actor
`apps/loan-app` records are the same string, lowercase. If they diverge, `governance.db`
and `loans.db` describe different people and the audit trail is fiction.

---

## Getting started locally

Requires [Bun](https://bun.sh) 1.3.14, and [uv](https://docs.astral.sh/uv/) for the
Python toolkits.

```sh
bun install
bun install --cwd apps/idp   # ⚠️ not optional — see below
cp .env.example .env         # then fill it in; every variable is documented in place
```

> ⚠️ **`bun install` at the root is not enough.** `apps/idp` is outside the workspace:
> Better Auth 1.7 needs zod 4 and the root manifest pins every workspace to zod 3 for the
> Arcade and Mastra path. Skip the second install and `bun test` fails with
> `Cannot find module 'better-auth'` and the repo looks broken on a fresh clone. It is
> not.

```sh
bun run typecheck        # tsc --noEmit across every workspace
bun test                 # decision modules, HTTP behaviour, and the forkability boundary
```

Run a service:

```sh
bun run dev:hooks        # :8081
bun run dev:loan-app     # :8082, the loan API
bun run dev:idp          # :8083, the identity provider — OAuth at /oauth2/*
bun run dev:idp-stub     # a userinfo-only stand-in for apps/idp, on IDP_PUBLIC_HOST's port
bun run dev:web          # :3000
```

Those are the defaults. Each service reads `PORT` from its own `.env.local` when there is
one, so a checkout that runs alongside another can give each service a different port
without touching a script — see `scripts/orca-setup.sh`.

The stub is the exception, and has to be: it lives under `apps/loan-app/scripts/`, so the
`PORT` it would read there is the loan API's. It binds the port in `IDP_PUBLIC_HOST`
instead — the address the loan API asks for userinfo. Move `IDP_PUBLIC_HOST` and both
sides follow.

Every `/loans` call needs a bearer token, and the API asks the identity provider who it
belongs to:

```sh
curl -H 'Authorization: Bearer dev:dana@example.test' localhost:8082/loans/LN-2291
```

Each service answers `GET /health` with one field per capability:

```sh
curl localhost:8081/health   # {"status":"healthy","service":"hooks","policy":{"revision":…},…}
curl localhost:8082/health   # {"status":"ok","service":"loan-app","loans":8,"reset":"disabled"}
curl localhost:8083/health   # {"status":"ok","service":"idp","people":4,…}
curl localhost:3000/health   # {"status":"degraded","service":"web","signin":"missing",…}
```

That last one is what a fresh clone with an unfilled `.env` actually answers, in full:

```json
{"status":"degraded","service":"web","signin":"missing","gateway":"missing",
 "verifier":"missing","agent":"missing","panel_stream":"fixture","reset":"disabled"}
```

A missing capability is **named**, `status` reads `degraded`, and the response is still
HTTP 200 — Render abandons a deploy whose health check is not 200, and an instance that
never comes up is one whose `/health` nobody can read. Nothing falls back silently.

### The offline path

Two beats of the approval flow run with no Arcade account and no network, against a local
stand-in that calls the **real** `/pre` on `apps/hooks` — so the refusal you see is the
actual policy refusing, and only the transport is ours:

```sh
bun run --cwd apps/web arcade-stand-in     # prints the port it bound
ARCADE_API_URL=http://localhost:<that port> ARCADE_API_KEY=offline \
  bun run --cwd apps/web dev
```

Full three-terminal walkthrough in [`apps/web/README.md`](./apps/web/README.md).

### Getting back to a clean state

```sh
bun run reset                   # the three services in this checkout
bun run reset --target render   # the deployed ones
```

One command, three databases: the identity provider's people, the control plane's policy
and audit log, and the loan book. Seconds, idempotent, safe to run repeatedly. It calls
each service's own `POST /admin/reset` under the shared `RESET_TOKEN`, so with that
variable unset there is nothing to call and every route answers 404.

**A redeploy is not a reset.** All three databases sit on Render disks and seed from
their fixture only when empty. Redeploying carries every stage edit and every approval
forward. This is the opposite of what most demo repos do, and it is deliberate: a policy
row edited during act 1 has to still be there in act 3.

**A reset is not a re-registration.** Nothing in `bun run reset` re-establishes the Arcade
side. The OAuth client Arcade holds lives in `idp.db` and is never touched — and deleting
that file, its disk, or `BETTER_AUTH_SECRET` *is* a rotation, which fails at the authorize
step where no hook fires and the panel stays dark.

---

## Setup from zero

Everything below needs a human with org access to an Arcade project, a Render account and
an Anthropic key. Nothing in it can be scripted from this repo, and the order matters —
the OAuth provider (step 4) must exist before the gateway (step 5), because the gateway
form will not let you pick a User Source that has not been registered.

### 0. Decide the four persona emails first

They are the join key across Arcade's `user_id`, the OAuth subject, the policy's subject
and the loan book's actor column. Every later step uses them. Case does not matter —
every holder lowercases — but they must be four real addresses you can receive mail at,
because Arcade's OAuth genuinely runs against them.

| Persona | Role | Limit | Why they exist |
|---|---|---:|---|
| Dana Okafor | Loan Officer | $50,000 | The protagonist |
| Sam Reyes | Credit Analyst | $0 | Act 1 — `ApproveLoan` hidden entirely |
| Riley Chen | VP Credit | $250,000 | Minimum-sufficient approver for $95K |
| Morgan Ellis | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered — proves routing |

The addresses themselves are **not in this repo** and never should be. They live in
`PERSONA_*_EMAIL` on `cg-web`, `cg-hooks` and `cg-idp`, set in the Render dashboard.

### 1. Deploy the four services — Render blueprint

Sync [`render.yaml`](./render.yaml) as a Render blueprint. It provisions `cg-loan-app`,
`cg-hooks`, `cg-idp` and `cg-web`. Every service declares `runtime: docker` and ships its
own Dockerfile: Render does not detect Bun, so the runtime is explicit rather than
detected.

Secrets are `sync: false`, so a sync prompts for them rather than committing them. Set
the four persona emails on `cg-idp` and `cg-hooks` **before their first boot** — the
seeds read them once — or reset those services afterwards.

> ⚠️ **Read every cross-service hostname and every persona email off the dashboard. They
> are not in this repo, and they cannot be derived.** `onrender.com` subdomains are
> global, so Render silently suffixes a service name that is already taken somewhere in
> the world — two of this demo's four services have a hostname that is not their service
> name, and one of the bare subdomains belongs to a stranger. For a while the loan API
> was validating bearer tokens against a colleague's IdP because of exactly that.
> Deriving fails too: `fromService … property: host` emits the *bare service name*, not a
> hostname, and blueprints have no string interpolation, so nothing in `render.yaml` can
> bridge the gap. Open each service's page, copy the host part of the URL shown there,
> and paste it. Each consumer refuses a value it could not reach, at boot, naming the
> variable — `apps/*/…/public-host.ts`.

### 2. Mint the OAuth clients on `cg-idp`

Better Auth **generates** client ids and secrets; they cannot be chosen. In `cg-idp`'s
Render shell:

```sh
bun run oauth-client                                  # the `arcade` client (hop 2)
bun run oauth-client --client web --rotate            # client C, cg-web's own sign-in
```

⚠️ **The secret is printed exactly once** — storage is hashed since #70. Write it down
then. A lost secret costs one `--rotate` and one dashboard field, never a
re-registration.

### 3. `arcade deploy` both toolkits

```sh
cd tools/loan      && arcade deploy
cd tools/approvals && arcade deploy
```

`arcade deploy` uploads each toolkit's declared secrets from the repo's `.env`, which is
the one configuration channel a deployed toolkit has: `LOAN_APP_PUBLIC_HOST` for the loan
tools, and `HOOKS_PUBLIC_HOST`, `WEB_PUBLIC_HOST`, `APPROVALS_STORE_TOKEN` for approvals.

Then **read the toolkit names back** and put them in `ARCADE_LOAN_TOOLKIT` and
`ARCADE_APPROVALS_TOOLKIT`. Measured on #35: `Loan` and `Approvals`, with tools
`Loan.SearchLoans`, `Loan.GetLoan`, `Loan.ApproveLoan`, `Loan.DenyLoan`,
`Approvals.RequestApproval`, `Approvals.Decide`. A rule keyed on `get_loan` matches
nothing.

### 4. Register the OAuth provider and the User Source

Two registrations against the same IdP, for the two hops, each with its own generated
redirect URI. Full field table in [`apps/idp/README.md`](./apps/idp/README.md).

**Custom OAuth 2.0 provider** (hop 2), provider id `cg-idp`:

| Arcade field | Value |
|---|---|
| Client ID / secret | as printed in step 2 |
| Authorize / Token URL | `https://<cg-idp host>/oauth2/authorize`, `/oauth2/token` |
| Client authentication | **`client_secret_basic`** — the dashboard default. Leave it alone; anything else is refused with `invalid_client` before the secret is checked |
| PKCE | **enabled**, `S256`. Arcade defaults it off; the client requires it |
| Scopes | `openid profile email offline_access` |
| `user_info_request.endpoint` | `https://<cg-idp host>/oauth2/userinfo`, bearer |
| **Identity JSONPath** | **`$.email`** |
| Redirect URL | the one Arcade shows. Allowlist it via `IDP_OAUTH_REDIRECT_URIS` |

That JSONPath is the mechanism behind "one identity, not two". Get it wrong and the
pre-hook governs one person while the loan book records another, and every test still
passes.

**User Source** (hop 1): issuer = `cg-idp`'s public URL, subject claim `email`, scopes
`openid profile email`. Your IdP must publish a `jwks_uri` with RS256 keys or the form
refuses it — measured on [spike #4](./docs/spikes/04-user-source.md). Whether a gateway
actually has one attached is readable from outside the dashboard, as
`urn:arcade:oauth:user_source_id` in its protected-resource document.

The dashboard's auth-method label is decorative — spike #5 found it reading
"Client Secret Basic" while the provider sent `client_secret_post`. Read the stored
configuration back instead:

```sh
bun docs/spikes/evidence/05-auth-provider-config.ts cg-idp
```

### 5. Create the gateway

Create an MCP gateway in **User Source mode** with `cg-idp` attached, add both toolkits,
and record its slug as `ARCADE_GATEWAY_ID`. Mastra's `MCPClient` connects to
`https://api.arcade.dev/mcp/${ARCADE_GATEWAY_ID}`.

Confirm `tools/list` through it returns **eight** entries — the project's six plus
Arcade's own `System_ManageAuthorization` and `Arcade_ListApps`, which never reach
`/access` and cannot be governed. `apps/web` filters to the two project toolkits.
Gateway calls need an `Arcade-User-Id` header, else `401`.

> Never drive the demo from an Arcade Org Admin account. An admin's `tools/list` sends
> the whole org catalogue — measured at 8259 tools, all correctly denied, and a 1.6 MB
> `/access` payload.

### 6. Register the hook extension

A webhook extension pointing at `cg-hooks`, with three hook configurations —
`/access`, `/pre`, `/post`. Four things are easy to miss and each one silently produces a
demo that governs nothing:

- **`failure_mode` is required and has no default.** Set it to fail closed on **all
  three**. Do not assume an inherited default; creating an extension without it is a
  `400`.
- **Extensions are created `status: inactive`** and fire nothing until activated. An
  apparently-successful setup that does nothing is the expected failure here.
- **`timeout_ms` exists at two levels and they do not inherit.** Set both.
- Bearer = `ARCADE_HOOK_SIGNING_SECRET`, the same value as on `cg-hooks`.

### 7. The custom verifier route — not an environment variable

Arcade dashboard → Auth → Settings → **Custom verifier route** must be
`${PUBLIC_URL}/api/arcade/verify`. This is the only step with no variable of its own, and
skipping it is invisible: Arcade falls back to its own verifier, which demands an Arcade
account that is a project member. Our personas are not, the grant binds to whoever
happens to be signed in at `account.arcade.dev`, and the tool re-challenges forever with
nothing on the panel to say why.

### 8. Prove it, before you build anything on it

```sh
# both readings must agree on one client_id
curl -fsS https://<cg-idp host>/health | jq '.oauth'
bun docs/spikes/evidence/05-auth-provider-config.ts cg-idp

# the control plane is armed, and it is the policy you think it is
curl -fsS https://<cg-hooks host>/health | jq '{status, counts, fixture_drift, warnings}'
```

`counts.output_rules` must be `2` and `policy.scanners.patterns` must be `6`.
`fixture_drift` must be `null`. Then sign in as Dana and run act 2 once, end to end.
[`docs/RUNBOOK.md`](./docs/RUNBOOK.md) §1 is the full pre-flight, and it is the document
to work from fifteen minutes before a demo.

Slack needs no app: access is brokered by Arcade's stock Slack provider, and each persona
who can trigger act 2 authorizes it once.

---

## Every environment variable

`.env.example` is the source of truth and carries the full argument for each one; this
table is the index. **SECRET** means it is `sync: false` in `render.yaml`, so a blueprint
sync prompts for it rather than committing it.

### Model and Arcade

| Variable | Read by | Where the value comes from |
|---|---|---|
| `ANTHROPIC_API_KEY` **SECRET** | `apps/web` | console.anthropic.com → Settings → API keys |
| `MODEL_ID` | `apps/web` | A Claude model id. Default `claude-sonnet-5`; in env so it swaps without a code change |
| `ARCADE_API_KEY` **SECRET** | `apps/web` | Arcade dashboard → API keys |
| `ARCADE_GATEWAY_ID` | `apps/web` | The gateway slug you create in step 5 |
| `ARCADE_API_URL` | `apps/web` | Unset = Arcade itself. Point it at the local stand-in for the offline path |
| `ARCADE_CLOUD_URL` | `apps/web` | Where `confirm_user` lives, which is **not** `api.arcade.dev`. Default `https://cloud.arcade.dev` is correct; measured on spike #5 |
| `ARCADE_HOOK_SIGNING_SECRET` **SECRET** | `apps/hooks` | Generate any long random string; enter the same one on the Arcade hook extension (step 6) |
| `ARCADE_LOAN_TOOLKIT` | `apps/hooks`, `apps/web` | **Read back off a real deploy** (step 3). `Loan`. On hooks it keys the rules; on web it is the agent's allow-list |
| `ARCADE_APPROVALS_TOOLKIT` | `apps/hooks`, `apps/web` | Same, `Approvals`. Required on `cg-web` too, or the agent cannot see the tool its own denial names (#89) |
| `ARCADE_IDP_PROVIDER_ID` | `tools/loan` (compiled in) | The Arcade auth provider id from step 4. `cg-idp` |
| `ARCADE_MCP_CLIENT_ID` | `apps/web` | Optional. Pins the MCP client id hop 1 authorizes under, so a redeploy does not cost every persona another consent click. Blank is correct to start |

### Service addresses — HOST-form, not URLs

Consumers add the scheme: `http` for localhost, `https` otherwise. **Every one of these
is read off the Render service page.** See the warning in step 1.

| Variable | Read by | Where the value comes from |
|---|---|---|
| `HOOKS_PUBLIC_HOST` | `apps/web`, `tools/approvals` | `cg-hooks`' Render page. This one reaches the browser via the panel, so a bare service name fails in a visitor's DevTools |
| `LOAN_APP_PUBLIC_HOST` | `apps/hooks`, `tools/loan` | `cg-loan-app`'s Render page. Reaches the toolkit as an Arcade secret |
| `IDP_PUBLIC_HOST` | `apps/loan-app` | `cg-idp`'s Render page. Where bearer tokens are validated. Locally, also the port `dev:idp-stub` binds |
| `WEB_PUBLIC_HOST` | `tools/approvals` | `cg-web`'s Render page. Builds the approval link. Absent from `render.yaml`: Render injects `RENDER_EXTERNAL_HOSTNAME` |
| `PUBLIC_URL` | `apps/web` | `cg-web`'s Render page, **with the scheme**. Every OAuth `redirect_uri` is built from it and matched byte for byte. Also decides whether the session cookie carries `Secure` |
| `IDP_ISSUER` | `apps/web` | `cg-idp`'s Render page, with the scheme |
| `IDP_PUBLIC_URL` | `apps/idp` | The IdP's own origin and OAuth issuer. Absent from `render.yaml`: Render injects `RENDER_EXTERNAL_URL` |

### Identity

| Variable | Read by | Where the value comes from |
|---|---|---|
| `BETTER_AUTH_SECRET` **SECRET** | `apps/idp` | Render generates it (`generateValue: true`). **Rotating it logs everyone out and makes the stored ID-token signing key unreadable** |
| `IDP_OAUTH_CLIENTS` | `apps/idp` | Comma-separated client *keys*, not credentials. Set it to `web` to mint client C alongside `arcade` |
| `IDP_OAUTH_REDIRECT_URIS` | `apps/idp` | The redirect URI Arcade shows under the provider's "Redirect URL". Default is Arcade Cloud's |
| `IDP_OAUTH_REDIRECT_URIS_<KEY>` | `apps/idp` | Per-client allowlist, upper-snake. `..._WEB` = `${PUBLIC_URL}/api/auth/callback` |
| `IDP_CLIENT_ID` / `IDP_CLIENT_SECRET` **SECRET** | `apps/web` | Client C, printed once by `bun run oauth-client --client web --rotate` (step 2) |
| `IDP_SCOPES` | `apps/web` | Default `openid email`. `email` is the join key — set it only to ask for *more* |
| `SESSION_SECRET` **SECRET** | `apps/web` | `openssl rand -hex 32`. **At least 32 characters and 8 distinct ones**, enforced: below that, `/health` reports every identity capability `missing` and each route answers 503. No fallback — a default key is a key everybody has |
| `PERSONA_DANA_EMAIL` and `_SAM_`, `_RILEY_`, `_MORGAN_` | `apps/web`, `apps/hooks`, `apps/idp` | The four real addresses from step 0, set in the Render dashboard. **Never written into this repo.** Read once, at first seed |

### Databases and reset

| Variable | Read by | Where the value comes from |
|---|---|---|
| `GOVERNANCE_DB_PATH` | `apps/hooks` | `/data/governance.db` on Render's disk; `./governance.db` locally |
| `LOANS_DB_PATH` | `apps/loan-app` | `/data/loans.db` on Render's disk |
| `IDP_DB_PATH` | `apps/idp` | `/data/idp.db` on Render's disk |
| `RESET_TOKEN` **SECRET** | all four services | `openssl rand -hex 32`. The **same value** on `cg-hooks`, `cg-idp`, `cg-loan-app` and `cg-web`. **Blank means the endpoint does not exist** — 404, `/health` reports `reset: disabled`, and the panel's Reset button is not drawn. No development fallback, on purpose |
| `RENDER_HOOKS_PUBLIC_HOST`, `RENDER_IDP_PUBLIC_HOST`, `RENDER_LOAN_APP_PUBLIC_HOST`, `RENDER_WEB_PUBLIC_HOST` | `bun run reset --target render`, and the runbook's pre-flight | The same Render pages again, as *separate* variables — so a command aimed at Render cannot silently reset a laptop, and one with no `--target` cannot silently reset the live demo |

### Control plane

| Variable | Read by | Where the value comes from |
|---|---|---|
| `APPROVALS_STORE_TOKEN` **SECRET** | `apps/hooks`, `apps/web`, `tools/approvals` | Any long random string, on all three. A **different** secret from the two others: this one writes the record a human then acts on |
| `GOVERNANCE_STREAM` | `apps/web` | `hooks` for any real deployment. `fixture` is the built-in replay; unset is the replay under `next dev` and **no stream at all** when deployed |
| `INJECTION_DETECTION` | `apps/hooks` | **Unset is armed**, deliberately. `off` compiles the policy without the injection patterns — act 4's control run. A typo is refused at boot rather than guessed at |
| `HOOK_DEADLINE_MS` | `apps/hooks` | Default 2500, inside Arcade's 5s. Past it, we fail closed and audit it rather than letting Arcade time us out |
| `POLICY_POLL_MS` | `apps/hooks` | Default 250. How fast a row edited on stage is honoured |
| `GRANT_TTL_SECONDS` | `apps/hooks` | Default 900. A grant is single-use *and* time-boxed |
| `PORT` | every service | Render injects it. Locally each service falls back to its own default, or reads its `.env.local` |

There is deliberately **no `NEXT_PUBLIC_*` variable anywhere.** `next build` inlines them
into the client bundle while Render supplies service env vars at runtime, so a
`NEXT_PUBLIC_HOOKS_HOST` would be empty at build time and `undefined` in the browser —
while working fine under `next dev`. The panel reads the hook host in a server component
and passes it down as a prop.

---

## What we measured

Four questions this project could not answer from documentation. Each was spiked against
a real Arcade project and the transcripts are in the repo, because the answers were
expensive and would otherwise be lost in issue comments.

**Do contextual-access hooks fire for tools we do not host ourselves?** — **yes.**
`/access`, `/pre` and `/post` all fire for a Remote MCP server's tools, with a payload
identical in shape to a hosted toolkit's. Confirmed by Arcade in session that hooks apply
to all tools regardless of where the server is hosted, including `arcade deploy`'d
toolkits, which is the path this demo runs on.
→ [`docs/spikes/02-remote-mcp-hooks.md`](./docs/spikes/02-remote-mcp-hooks.md) (#2), with
raw payloads.

**The same spike answered a harder question the other way: layer-2 refusals are invisible
to the control plane.** An unmet auth requirement returns `tool_requirements_not_met` and
fires no hook — no `/pre` event, no audit row, nothing on the panel. Not an architectural
problem, but it constrains the demo: **never stage a beat you want to *show* as an auth
failure**, and `governance.db` cannot claim to be a complete record of refusals. Two
things follow from it in code: the chat renders layer 2 as an authorization link rather
than a denial, and the panel names the layer that refuses upstream of the hooks.

**Does Arcade's stock Slack provider grant a user token with `chat:write`?** — **yes.**
A delegated *user* token, so act 2's message arrives under the requester's own name with
no APP badge, and there is no custom Slack app and no bot fallback. The toolkit must
request **four** scopes, not three: `users:read` is a prerequisite for `users:read.email`
and Slack refuses the authorize request outright without it.
→ [`docs/spikes/03-slack-scopes.md`](./docs/spikes/03-slack-scopes.md) (#3).

**What survives a hook denial, over MCP, all the way to the UI?** — enough to tell a
decision from an outage, which is the whole question. `POST /pre` answers HTTP 200 with
`{ code: "CHECK_FAILED", error_message: "DENIED: … [ref evt_…]" }`. Over MCP that
flattens to an `isError: true` envelope, and Mastra surfaces it as a tool error. **The
`[ref evt_…]` token survives every layer** and is the correlation to the audit row.

That token is why the chat can say "denied" honestly: the UI requires *positive* evidence
of a hook decision — Arcade's prefix, `CHECK_FAILED`, `CONTEXT_DENIED`, or the ref token
— before it draws a denial card. Every other tool failure is a fault card that says no
decision was made. **A control surface must never assert a control-plane action that did
not happen.** Measured on #14; the wire shapes are in
[`DESIGN.md`](./DESIGN.md#event-contract).

Two further measurements shaped the build more than any of the above:

- **The model reads the injected note and stops.** With act 4's note visible, the $95K
  beat reached `/pre` roughly 5 times in 17: Claude reads the injection, refuses it on
  principle, flags it, and ends the turn asking whether to proceed — so `ApproveLoan` is
  never called and act 2 never fires. With `/post` stripping the note first, 5 of 5, and
  5 of 5 again on independent re-measurement. **Act 4's control is act 2's prerequisite.**
  The fix was removing what the model was reading, never steering it.
- **One sentence in the system prompt moves everything.** An "irreversible, no undo" line
  made the model ask permission and `/pre` never fired; a "do not ask the person to
  confirm" line pushed it the other way. Both were removed, and no prompt steering is an
  acceptable fix for either failure: a run that needs the prompt to reach the hook proves
  the prompt.

Two spikes on identity — [`04-user-source.md`](./docs/spikes/04-user-source.md) and
[`05-custom-verifier.md`](./docs/spikes/05-custom-verifier.md) — are the working record of
the two-hop design, including the four OAuth misconfigurations that each fire no hook and
leave the control plane dark.

---

## The loan book

`apps/loan-app` is the system being governed, and it knows nothing about governance: no
authority checks, no withheld fields, nothing consulted before a write is applied.
`GET /loans/:id` hands back the borrower's bank account number, tax ID and the
underwriter's notes in full, on purpose — redacting them is the post-execution hook's job,
and a service that did it itself would leave nothing to demonstrate.

```
GET  /loans?status=&min_amount=&max_amount=
GET  /loans/:loan_id
POST /loans/:loan_id/approve   { amount }
POST /loans/:loan_id/deny      { reason }
GET  /health
```

Every `/loans` route needs a bearer token. The API asks `apps/idp`'s `/oauth2/userinfo`
who the token belongs to and records that email as the decision's `decided_by`. **The
actor is never a request parameter** — a body that tries to name one is a 400. OAuth
carries identity; the hooks carry authority.

A decision is an event rather than a flag, so approving the same loan twice leaves two
rows in its history instead of collapsing into an accidental no-op.

`loans.db` is seeded from `apps/loan-app/src/fixtures/loans.json` when it has no schema,
and left alone on every boot after that.

## The loan tools

`tools/loan` is where the agent's tools live: `search_loans`, `get_loan`, `approve_loan`,
`deny_loan`, each a stateless `httpx` call to the API above carrying the end user's OAuth
token. It ships with `arcade deploy`, and the toolkit name Arcade files it under is
measured, not derived — see [`tools/loan/README.md`](./tools/loan/README.md).

**Two spellings of one tool name, and they are not interchangeable.** MCP advertises
`Loan_GetLoan`, which is what the model can call. Hook payloads, audit rows and policy
rules use `Loan.GetLoan`. Key rules the dot way; write the underscore spelling in any text
addressed to the model, such as a `/pre` denial's remediation sentence. `apps/hooks`
enforces the difference at compile time.

## The identity provider

`apps/idp` is what the loan tools authenticate against: Arcade is registered as an OAuth
client of it, and the email it returns from `/oauth2/userinfo` is the identity every hook
and every loan-book write is keyed on. It stands in for the enterprise's real IdP, and it
has one operational rule — **resetting it must not rotate the OAuth client**, or the
registration in the Arcade dashboard goes stale right before you present.

**Email is the join key, and it is case-insensitive.** `apps/idp` and `apps/hooks`
lowercase what they seed, `apps/loan-app` lowercases what `/oauth2/userinfo` returns, and
the pre-hook folds case on the `user_id` Arcade sends. So the four `PERSONA_*_EMAIL`
values can be typed in whatever case the Arcade accounts use and the three databases still
describe one person.

## Two things that will bite you

**Zod is pinned to 3.25.76.** Zod 4 changes internals the Arcade/Mastra path does not
support yet, so the root manifest carries an `overrides` entry holding every workspace to
the same 3.x. Do not bump it without checking the Arcade SDK first. This pin is also why
`apps/idp` is outside the workspace.

**`packages/governance-core` must not depend on any app.** That boundary is what makes
this template forkable, and it is enforced by a test rather than a convention:
`packages/governance-core/test/no-app-dependencies.test.ts` fails if governance-core
declares a dependency on an app package or imports from one, in any of eleven import
forms. Its sibling, `apps/loan-app/test/knows-nothing-about-governance.test.ts`, enforces
the same boundary from the other side.

---

## Deploying

Four services deploy from [`render.yaml`](./render.yaml) as a Render blueprint.
`tools/loan` and `tools/approvals` are deliberately outside it: they are Python
`arcade-mcp` toolkits and Arcade hosts them via `arcade deploy`.

Three things about Render that are load-bearing here:

**A redeploy is not a reset.** Each database-owning service mounts a disk and seeds from
its fixture only when the database has no schema. Deploying changes the code, not the
rows. Getting back to clean is `bun run reset`, or the panel's Reset control.

**Services with disks give up zero-downtime deploys.** Render stops the old instance
before starting the new one. Irrelevant for a demo, and worth one line so nobody reports
it as a bug.

**Forking this blueprint hands you three paid disks.** 1 GB each, the minimum, on
`cg-loan-app`, `cg-hooks` and `cg-idp`. Each `disk:` block in `render.yaml` carries a
comment saying exactly what you give up by deleting it — the services re-seed themselves
from their fixtures on every boot, which is fine for a look at the demo and wrong for the
demo itself. `cg-idp` is the one to think hardest about: the OAuth client credentials live
in that database, so without the disk every restart regenerates them and the registration
in the Arcade dashboard goes stale.

## Forking

The domain swap is structural rather than a README instruction: replace `apps/loan-app`,
`tools/loan` and the seed fixtures, and leave `packages/` alone. Your own business system
declares `"cg": { "governed": true }` in its manifest and inherits both halves of that
boundary automatically.

**[`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md)** is the full walk: eight seams, each with
a path, plus the boundary check and its honest measured result.

**Identity is the other seam**, and it is one function pair. `readSession` /
`readSessionFromCookies` in `apps/web/lib/identity/session.ts` return a
`Session { email, gateway?, signed_in_at }` or `null`, and every route handler and server
component that needs to know who is acting calls one of them. Point it at your own Okta,
Auth0 or NextAuth session, return the email your directory knows the person by, and delete
`apps/idp` — nothing downstream reads an identity from anywhere else, and the verifier
route refuses a request that tries to carry one. The table of what to keep and what to
delete is in
[`apps/web/README.md`](./apps/web/README.md#the-identity-seam-a-forker-replaces).

---

## Where the rest of it is

| | |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | The authoritative record: architecture, contracts, and the reasoning behind each decision |
| [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) | The rehearsal script: pre-flight, the four acts with the prompts as measured, the reset, and the failure playbook |
| [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md) | Pointing this template at your own business system |
| [`docs/spikes/`](./docs/spikes/) | The four measurements above, with their transcripts |
| [issue #1](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/1) | The PRD and the work breakdown |

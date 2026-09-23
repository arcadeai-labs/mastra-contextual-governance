# Project context for workers

Implementers and reviewers read this file right after the issue and `DESIGN.md`.
The role prompts are project-agnostic; **everything a worker needs to know about
this codebase goes here.** Update it whenever a worker trips on something it
should have been told — via the driver, who gates the change.

---

## What this project is

A demo: an agent doing real work in a real business system, with Arcade
enforcing deterministic control on every tool call. The thesis is that the LLM
is treated as an adversary and the controls live **outside** it. A loan
underwriter chats with an agent; the agent calls `Loan` and `Approvals` tools
through Arcade; hooks in `apps/hooks` evaluate policy before and after every
call, and a control-plane panel shows what was allowed, denied, redacted or
escalated. "Working" means an audience watches four scripted acts happen live
and every control visibly fires. Two consequences you will feel:

- **The business system must not know about governance.** `apps/loan-app` has a
  test that fails if governance vocabulary appears in its source. That is the
  demo's central claim, enforced rather than asserted.
- **A control that silently does nothing is worse than no control.** The
  recurring failure here is a rule that matches nothing, which is
  indistinguishable from a rule that permits. It looks like a working demo. If
  your slice writes or matches a rule, prove it matches.

## Fresh-worktree quickstart

`scripts/orca-setup.sh` has already claimed your port block, written the
`.env.local` files and run both installs by the time you start.

```sh
bun install                        # the setup hook already did this
bun install --cwd apps/idp         # and this — apps/idp is NOT a workspace member
bun test                           # workspace groups only; see "the suite is eight groups"
bun run typecheck
bun run --cwd apps/web build
bun run dev:web                    # each service on its own PORT from its own .env.local
```

There is no Docker and no Compose in this project. **Do not start Docker
Desktop on this machine.**

## Environment facts that will bite you otherwise

- **`bun install` at the root is not enough.** `apps/idp` is excluded from the
  workspace on purpose: Better Auth needs zod 4 and the root manifest pins zod
  3 for the Arcade/Mastra path, and Bun applies root overrides workspace-wide
  while ignoring nested ones. If you see `Cannot find module 'better-auth'`,
  that is the cause — the repo is not broken. Run
  `bun install --cwd apps/idp`.

- **The suite is eight groups, not six workspaces.** "Run every workspace"
  omits 90 tests across 4 files. Report **per group, never as a total**:

  | group | note |
  | --- | --- |
  | `apps/web` · `apps/hooks` · `apps/loan-app` | workspace members |
  | `packages/governance-core` · `packages/policy-schema` | workspace members |
  | `apps/idp` | outside the workspace globs, but it does have tests |
  | root `test/` | not a workspace |
  | `docs/spikes/evidence` | not a workspace |

  `apps/loan-mcp` has no tests. Beyond the eight: `tools/loan` (16) and
  `tools/approvals` (144), plus `bun run typecheck` and the web build.

- **Run the root group as `bun test ./test/`.** `bun test test/<file>.ts`
  matches paths as **substrings** and silently also runs
  `apps/loan-app/test/reset.test.ts`, inflating the group. A merge worker
  caught this only because the count was 33 instead of the expected 23.

- **Tool identifiers are PascalCase**, measured off a real deployment: toolkit
  `Loan`, tools `SearchLoans`, `GetLoan`, `ApproveLoan`, `DenyLoan`; through a
  gateway the wire name is `Loan_GetLoan`. A rule keyed on `get_loan` matches
  nothing and reads exactly like a rule that permits.

- **`tool.metadata` is never populated** in hook payloads, for any tool. Do not
  key anything on `behavior.operations` or `read_only`.

- **Arcade evaluates auth requirements before `/pre`.** A refusal there fires no
  hook, writes no audit row, and shows nothing on the panel. If something you
  expect to see is invisible, check the OAuth registration before you suspect
  the control plane.

- **Ports.** Your worktree owns ten, claimed by `scripts/orca-setup.sh` from
  4400–4559 and released by `scripts/orca-archive.sh`. The root `.env.local`
  carries `CG_PORT_BASE`, `CG_PORT_WEB`, `CG_PORT_HOOKS`, `CG_PORT_LOAN_APP`,
  `CG_PORT_IDP` and the cross-service host strings; each of `apps/web`,
  `apps/hooks`, `apps/loan-app`, `apps/idp` has its **own** `.env.local` with
  its own `PORT`, because all four services read the same variable name. Never
  hard-code 3000, 8081, 8082 or 8083, and never pick a port at random — bind
  `:0` and read it back, as `tools/loan/tests/conftest.py::_free_port` does.
  Stale claims live in `~/.cache/mastra-contextual-governance/portblocks/`.

- **`bun run reset` no longer touches the IdP; `--hard` does**, and costs four
  logins and four cards. Never run `bun run reset --target render`.

- **Databases are SQLite on disk and gitignored.** They seed *if empty*, in one
  transaction with the schema. Never commit a `.db` file.

## What this project fails at

The recurring failure is **silent**, not loud, and it has claimed six slices in
a row. Every one is a path that is only exercised where nobody looks. Weight
your attention accordingly.

- **A rule that is under-scoped, not misspelled.** #184: both output rules
  matched `{ toolkit: "$LOAN", tool: "GetLoan" }` while `ApproveLoan` and
  `DenyLoan` returned the same `SELECT *` record, so every approve and deny
  leaked the data the rules exist to protect. **Ask of every slice: which paths
  return this data, and is the control on all of them?** `SearchLoans` is the
  model that works — it projects six safe columns and never reads the sensitive
  ones, so there is nothing for a hook to miss.
- **Enforcement written but never demonstrated.** If a slice adds a denial path,
  demand evidence it actually denied, not that the code exists.
- **The business system learning about governance.** `apps/loan-app` must not
  contain policy, role, limit, redaction or authority vocabulary, and must not
  import `@cg/*`. There is a test; check it was not weakened to pass.
- **Seeding.** A slice once shipped DDL outside the seed transaction: a failed
  seed rolled back its rows but left the tables, so every later boot came up
  green with zero rows, permanently, on a disk that persists. Try a
  deliberately broken fixture.
- **State from a previous run.** A test that passes because of what an earlier
  run left on disk is not passing. You have a clean worktree; use it.
- **A fixture change that never reaches the deployed service.** Durable policy
  lives in the database, so editing a fixture does not change a running
  environment.
- **The production image is not `next dev`.** A slice shipped no `public/` and
  nobody saw it, because `next dev` serves those files off disk.

## Non-negotiables

Gate through the human regardless of slice:

- **No external state, ever, by any worker.** Do not deploy (`arcade deploy`
  included), provision, log in, authenticate, use or create credentials, or
  alter Arcade, Render, Slack, Google or OAuth configuration. **The live
  services are in active use:** never point anything at `cg-idp-or5b`,
  `cg-web-sa31`, `cg-loan-app` or `cg-hooks` on `onrender.com`. The one narrow
  exception, and only with the driver's say-so: a freshly-random,
  environment-only, never-committed `BETTER_AUTH_SECRET`/`SESSION_SECRET` to
  boot a **local** throwaway IdP, killed afterwards with `pgrep` proof.
- **Anything touching the four acts or the demo narrative** (`DESIGN.md` §"The
  four acts").
- **Anything a new user or forker sees first:** the README quickstart, the
  rehearsal runbook, shipped defaults and config templates.
- **Anything touching identity, authorization or the access model** — the two
  hops, the User Source gateway hop, the verifier tool hop.
- **The only Python in this project is `tools/`.** A slice once turned the loan
  tools into Python against an explicit constraint and no gate caught it.
- `docs/PRESENTATION-BRIEF.md` is untracked and excluded on purpose because it
  names live persona addresses. Do not commit it and do not remove the
  exclusion.
- The personas are **Alice, Bob, Charlie and Michael at `@megaforce.tech`**.
  `dana`/`sam`/`riley`/`morgan` are internal keys only, and `@bank.example` is
  the local fixture — it must never reach anything audience-facing.

## Where things live

- `apps/web` — Next.js: the chat, the control-plane panel, the approval pages.
- `apps/hooks` — the control plane: `/pre` and `/post` hooks, policy evaluation,
  the audit log, the `/approvals` API. `src/fixtures/governance.json` is the
  policy fixture.
- `apps/loan-app` — the bank. Knows nothing about governance, and a test
  enforces that.
- `apps/idp` — the stand-in enterprise IdP (Better Auth). Outside the workspace.
- `apps/loan-mcp` — MCP surface. No tests.
- `packages/governance-core`, `packages/policy-schema` — policy types and
  evaluation shared by the hooks.
- `tools/loan`, `tools/approvals` — the Arcade toolkits, Python, `uv`.
- `test/` — root-level reset tests. `docs/spikes/evidence` — spike evidence
  tests. Neither is a workspace.
- `scripts/orca-setup.sh`, `scripts/orca-archive.sh` — the port-block hooks.
- `DESIGN.md` — architecture, the four acts, contracts. Law; never edit it.

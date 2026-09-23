# @cg/policy-schema

The frozen contract every other slice builds against. Zod 4 schemas, consumed as
TypeScript source — no build step.

```ts
import {
  PreHookRequest,       // Arcade's payloads, generated
  PolicyRule, Decision, // our vocabulary, hand-written
  aPolicyRule,          // fixtures
} from "@cg/policy-schema";
```

## Two sources, kept apart

`src/generated/hook-contract.ts` is **generated** from Arcade's OpenAPI document
(`ArcadeAI/schemas`, `logic_extensions/http/1.0/schema.yaml`), vendored at a pinned commit
under `vendor/`. It covers `/access`, `/pre`, `/post` and `/health` — requests, responses,
and the `ResponseCode` enum. Do not edit it; `bun test` fails if the committed file is not
what the vendored spec produces.

`src/domain.ts` is **ours**, and hand-written: `Subject`, `PolicyRule`, `OutputRule`,
`Decision`, `Grant`, `GrantRejectionReason`, `ApprovalRequest`, `GovernanceEvent`, plus the
pieces they are built from. Domain-agnostic by rule — subjects, tools, inputs, clearances,
never what the governed system happens to do. A type here that named the demo's business
domain would break the promise that forking means replacing one app and touching nothing
under `packages/`.

`src/fixtures.ts` builds valid instances of both. Every builder takes a deep-partial
override and returns `schema.parse()` output, so a fixture cannot drift out of conformance
with the schema it claims to instantiate. Everything is deterministic — no clock, no
randomness — because the UI lane snapshots it.

## Regenerating

```sh
bun run --cwd packages/policy-schema generate         # rewrite the generated file
bun run --cwd packages/policy-schema generate:check   # CI: fail if it is stale
bun run --cwd packages/policy-schema fetch            # pull upstream, then regenerate
```

`scripts/generate-hook-contract.ts` supports only the OpenAPI constructs the vendored
document actually uses, and throws with a JSON pointer on anything else. That is
deliberate: the alternative failure is emitting `z.unknown()` for a construct it does not
understand, producing a validator that accepts everything and a test suite that stays green.

See `vendor/README.md` for the pin and how to move it.

## Five choices worth knowing about

**Generated objects are `.passthrough()`; ours are `.strict()`.** Opposite settings, opposite
reasons. Arcade's payloads may grow, and Zod strips unknown keys by default — a new field
would vanish between `parse()` and the audit log, invisibly. Our policy rows may not grow: a
misspelled field there would parse cleanly and evaluate as though it had never been written,
turning a rule narrower than intended into a blanket rule. Strict makes that a parse error at
seed time.

**Nullable rather than optional, nearly everywhere.** These records round-trip through
`bun:sqlite` and across SSE. An absent key and a key set to `undefined` serialise
identically, so a field that is meaningfully empty says so with `null`.

**`Timestamp` accepts only `Z`-suffixed UTC instants** — `2026-01-01T00:00:00.000Z`. It
rejects a `+00:00` offset, and it rejects SQLite's own `datetime('now')` format
(`2026-01-01 00:00:00`). Anything writing these rows must stamp them with
`new Date().toISOString()` and never let SQLite supply the value, or every row fails on the
way back out. Pinned by a test.

**A `Grant` bounds, it does not pin, its one numeric input.** `pinned_inputs` must match
exactly; `ceiling` is `{ input, max }` and the input it names must be present, numeric, and
no greater than `max`. That is what lets #10 accept a retry at or below the approved value
and reject a replay above it — an exact-match input map cannot express the difference. Which
input carries the bound is data, so nothing here learns what the number counts.

**A rejected grant says why, in a shape two consumers can render.**
`GrantRejectionReason` is a discriminated union on `kind` — `expired`, `consumed`,
`self_approved`, `ceiling_exceeded`, `unenforceable` and the rest — and every arm carries the
values that produced it, because a compliance reviewer has to explain an outcome to an
auditor (PRD stories 19–22) and "invalid" is not an explanation. `GRANT_REJECTION_KINDS`
lists them, which is how #10's test suite proves it exercises every one. The checking itself
is `@cg/governance-core`'s `checkGrant`.

## Writing policy

`z.infer` gives the *output* type, where every default is populated. Seed data and the live
rule editor should type their literals as the input variants and let `parse()` fill the rest
in:

```ts
import { PolicyRule, type PolicyRuleInput } from "@cg/policy-schema";

const seed: PolicyRuleInput[] = [
  {
    id: "rule.clearance",
    description: "Deny when a numeric input exceeds the subject's clearance.",
    hook: "pre",
    match: { toolkit: "Widgets", tool: "update_widget" },
    conditions: [{ input: "quantity", operator: "exceeds_clearance" }],
    effect: "deny",
    reason: "This request exceeds your clearance. Request approval, then retry.",
    priority: 100,
  },
];

const rules = seed.map((rule) => PolicyRule.parse(rule));
```

A rule can be conditioned on the subject: `subjects` takes `user_ids`, `roles`,
`clearance_below` and `clearance_at_least`, so a redaction can apply to junior subjects and
not to senior ones without knowing what clearance measures. Every field is a narrowing
filter; `null` means "do not narrow on this", and a matcher that narrows on nothing applies
to everyone.

`reason` is load-bearing. Over MCP a denial reaches the model as
`"Tool execution was denied by an extension policy: " + reason` and nothing else, so this
string *is* the remediation instruction the agent acts on. The hook writes it; the system
prompt does not.

One thing not to do, measured in `docs/spikes/02-remote-mcp-hooks.md`: do not key a rule on
tool behaviour metadata. `tool.metadata` is never populated on hook payloads — for remote
MCP tools or hosted toolkits — so such a rule matches nothing, and a rule that matches
nothing is indistinguishable from a rule that permits.

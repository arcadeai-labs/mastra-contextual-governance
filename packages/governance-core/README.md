# @cg/governance-core

The governance layer: hook framework, policy engine, redaction, audit, event bus. Free of
business-domain vocabulary and — enforced by `test/no-app-dependencies.test.ts` — of any
dependency on `apps/*`. Forking means replacing the governed app and touching nothing here.

## PolicyEngine (`src/policy-engine.ts`, #7)

Pure. No I/O, no clock, no randomness. Two questions:

```ts
import { compilePolicy, resolveVisibility, evaluatePermission } from "@cg/governance-core";

const policy = compilePolicy({
  // Every governed toolkit (the ARCADE_*_TOOLKIT values from config, never
  // hardcoded), the tools it serves, and the arguments each call must supply.
  // Required: it is the typo check at compile time, the fail-closed boundary
  // at runtime, and what lets the compiler check remediation instructions.
  // A trailing `?` marks an argument optional: not required on the call, usable
  // in conditions, not usable as a {{inputs.…}} placeholder.
  catalogue: {
    [toolkitName]: {
      search_widgets: ["status?", "min_quantity?", "max_quantity?"],
      get_widget: ["widget_id"],
      update_widget: ["widget_id", "quantity"],
    },
    Approvals: { request_approval: ["resource_id", "quantity", "justification"] },
  },
  rules,   // PolicyRule[] from governance.db
});

// /access — which tools may this subject see at all
resolveVisibility(subject, tools, policy);   // → { tool, decision }[]

// /pre — may this subject make *this* call, with *these* argument values
evaluatePermission({ subject, tool, inputs, policy, grants });   // → Decision
```

`subject` is `Subject | null` — the hook handler (#12) resolves `context.user_id` to a
`Subject`; `null` means nobody matched. `grants` are `ValidatedGrant`s: grants that #10's
`GrantChecker` has judged valid *for this call* (expiry, uses, approver ≠ subject,
`resource_id`, pinned inputs, ceiling against the call's own value) and marked so with
`attestGrantValidated`. That function is the only way to produce the type, so a grant cannot
reach the engine without passing through validation. The engine itself only checks that a
grant applies to this subject and tool.

### What a decision means

| Situation | `effect` | `rule_id` |
|---|---|---|
| A rule matched | the rule's | the rule's id |
| A `pre` rule would deny, but an applicable grant is present | `allow` | the rule the grant lifted |
| A catalogued tool that no rule speaks about | `allow` | `null` |
| Unknown subject | `deny` | `null` |
| Toolkit not in the catalogue | `deny` | `null` |
| Tool not in its toolkit's catalogue entry (typo, case, prefix, or a tool the policy never heard of) | `deny` | `null` |
| A `/pre` call missing a catalogued argument of its tool | `deny` | `null` |
| A rule's condition reads an input that is missing or of the wrong type | `deny` | that rule's id |

Rules are evaluated in ascending `priority`, ties broken by `id`; first match wins.
Disabled rules never fire.

### Why `compilePolicy` throws

A rule that matches nothing is indistinguishable at runtime from a rule that permits. So
compilation is loud: it refuses, with every problem listed, a rule whose toolkit or tool the
catalogue does not list, whose condition reads an input no matched tool accepts (a typo
there would fail closed forever, telling the model to set an input the tool does not take),
whose condition value makes no sense for its operator (`gt "10"`, `in "eu"`, an invalid
regex), an `exists: false` on a required argument (dead: the call is denied before any rule
runs), a subject matcher that can never match (empty `roles` or `user_ids`,
`clearance_below <= 0`, an empty clearance band), an `access` rule with conditions (there are
no inputs at `/access`), a `modify` effect, a duplicate id, a `reason` placeholder rooted
outside `inputs`, `subject` or `tool` — and a `pre` denial whose reason is not actionable
(below).

**The one loudness gap, stated.** The engine holds no roster, so a misspelled *role* or
*user id* in `subjects` cannot be caught at compile time: such a rule matches nobody and the
default allow applies. The guarantee covers `match`, `conditions` and everything the schema
makes provable; role and user-id spelling is #12's seed data's to get right.

### Denial reasons

Over MCP the model sees `"Tool execution was denied by an extension policy: " + reason`
and nothing else. A rule's `reason` should therefore name the next tool to call and the
arguments it needs, and may interpolate the call:

```
DENIED: {{inputs.quantity}} exceeds your {{subject.clearance}} clearance.
To proceed, call Approvals.request_approval with resource_id={{inputs.widget_id}},
quantity={{inputs.quantity}} and justification=<why>, then retry this call unchanged.
```

Placeholders are exactly two segments and every one is provable at compile time:
`{{inputs.<argument>}}` where the argument is catalogued for *every* tool the rule can match
(the engine requires those inputs on the call, so the value is always there),
`{{subject.user_id|display_name|role|clearance}}`, and `{{tool.toolkit|name}}`. A placeholder
the engine cannot guarantee to fill is a compile error, not a `(not provided)` at runtime, and
so is any `{{` or `}}` that does not form a placeholder — `{{}}` included.

**This is enforced, not advised.** A `pre` rule with `effect: deny` fails to compile unless
its `reason` either contains the words `Do not retry`, which tells the model to stop rather
than guess (and then instructs no call at all), or names a catalogued tool as `Toolkit.tool`
*and*, after that name, spells out as `name=value` every argument the catalogue lists for
that tool. The reason is read as one left-to-right token stream. Arguments belong to the
`Toolkit.tool` reference they follow, and *any* such reference closes the previous one,
catalogued or not, so arguments cannot drift onto a tool that was not named for them;
arguments given to an uncatalogued reference are refused. The value is a `{{inputs.…}}`
placeholder, a `<what to supply>` instruction, a non-empty quoted string or a bare literal
with no brace, angle or quote characters; `name=` with nothing usable after it is refused,
and so is an argument the tool does not accept. So `"Insufficient authority."` is refused as
an apology, `"…with banana=1."` for the unknown argument, `"…with resource_id=, quantity=,
justification=."` and `"…resource_id={{}}, …"` for the missing values, two tools with
swapped argument lists for both, and `"Call Approvals.request_approval; then
Bogus.do_thing with resource_id=…"` because the arguments follow a tool that does not exist. Access denials are exempt: they hide
the tool, and the model never reads them.

Engine-authored reasons (the fail-closed rows above) follow the same standard: they name the
tool and input, and say whether a retry can fix it.

### Conditions

All conditions on a rule must hold. `input` is a dot path into the call's inputs.

| operator | value | fires when |
|---|---|---|
| `eq` / `neq` | any | input equals / differs from value (structural) |
| `gt` `gte` `lt` `lte` | number | numeric comparison |
| `in` / `nin` | array | input is / is not a member |
| `matches` | regex source | input is a string matching it |
| `exists` | omitted or `true` | input is present and not `null` |
| `exists` | `false` | input is absent or `null` |
| `exceeds_clearance` | none | input is a number greater than `subject.clearance` |

Numbers are not coerced: `"95"` is malformed, not ninety-five, and the denial says so and
asks for a number. The limit itself is inclusive — exactly at clearance is allowed.

## RedactionEngine (`src/redaction-engine.ts`, #8)

Pure. No I/O, no clock, no randomness. One question: what may the model *read*
of what came back.

```ts
import { compileOutputPolicy, redact } from "@cg/governance-core";

const policy = compileOutputPolicy({
  catalogue,   // the same catalogue the PolicyEngine compiles against
  rules,       // OutputRule[] from governance.db
});

// /post — rewrite the payload before it reaches the model
redact({ output, subject, tool, policy });   // → { output, redactions[] }
```

**No model is used to police model output.** Per #1 that is deliberate: asking
the adversary to guard the gate contradicts the thesis, and it would add a model
round-trip to every tool result. Everything here is declarative — named field
paths, and regular expressions over free text.

`redactions[]` is `RedactionRecord[]` from `@cg/policy-schema`: `path`,
`rule_id`, `pattern_id` and `kind`. There is nowhere in it to put the value that
was removed, because it is written to the audit log and drawn on a projector
(#21).

### Field paths

`a.b`, `a[0].b`, `a[].b`, optionally rooted at `$`. `[]` is every element of the
array at that position — a rule reaches into a history without knowing how long
it is. A path that runs into the wrong shape, or names a field that is not
there, matches nothing: tool outputs are heterogeneous (a list endpoint returns
an array where a detail endpoint returns an object) and a rule written for both
should redact whichever it finds rather than throwing on the other.

### The three strategies

|  | pattern match | field path |
|---|---|---|
| `mask` | the matched substring becomes `replacement`; the text around it survives | the value becomes `replacement` |
| `replace` | the whole string holding the match becomes `replacement` | the value becomes `replacement` |
| `remove` | the matched substring is deleted and the text closes up | the key is deleted from its parent |

For a field path `mask` and `replace` coincide: the match *is* the whole value,
so there is nothing around it to preserve. The distinction pays off on a pattern
sweep, which is where it is needed — a free-text field commonly holds real work
*and* something aimed at the model. Nothing is format-preserving; a mask that
revealed length or shape would teach the model what was taken.

### Order, and why every rule fires

Rules are ordered by ascending `priority`, ties broken by `id`. Unlike the
PolicyEngine this is **not** first-match-wins: redaction is cumulative, and a
high-priority rule that stopped evaluation would silently cancel every
protection below it. Within a rule, `fields` run before `patterns` — what can be
named is named, so one secret does not produce two records.

### Idempotence

> **The invariant:** for any policy `compileOutputPolicy` accepts, `redact` returns
> a payload that redacting again leaves identical with an empty `redactions[]` —
> because every string the engine can write is refused at compile time if any
> pattern could match it, and the whole transformation is then run to a fixed
> point.

Three things hold that up.

**The whole transformation runs to a fixed point** — field rules and pattern
sweeps together, not the sweep alone. Settling half an operation says nothing
about applying the other half again, so the pair is iterated until a pass leaves
the payload alone.

**Every string the engine can write is inert to every scanner.** A field's
marker, a pattern's replacement and the withheld sentinel are all text the engine
puts into a payload, and a pattern that can match one would rewrite it next time.
The check is `regex.test(marker)` — a partial match anywhere is enough — and for
the sentinel it runs against every pattern in the policy, with no tool-overlap
test, because any rule is applicable on some call.

**Records come from comparing input to output**, not from counting steps. A
payload that came back as it arrived had nothing removed from it, whatever the
rules did on the way, and a removal that removed nothing is a lie on the panel
and in the audit log. When there was nothing to do at all, `output` is the very
same reference that came in, which is how #12 tells an `allow` from a `modify`
without a deep compare.

If a string still cannot settle it is withheld and recorded with kind
`unsettled` and `rule_id: null` — the engine owns that outcome, not a rule.
Withholding more is the fail-closed direction at `/post`, and the row tells an
operator their output policy is broken rather than that a secret was found.

This shape was arrived at over three rounds of review, each of which found a
different string that the previous version left exposed: a pattern's own
replacement, then another rule's marker, then the sentinel itself. The lesson is
in the invariant above — it is stated over the *set* of strings the engine can
write, so it does not need to be restated the next time one is added.

### Fail closed means redact *more*

When the subject cannot be resolved, every subject-conditioned rule applies. At
`/pre` failing closed means denying; here it means withholding, so the caller
the control plane cannot name receives the most redacted payload rather than the
least. Both are fail-closed; they point opposite ways because one gates an
action and the other gates what comes back.

### Why `compileOutputPolicy` throws

A redaction rule that matches nothing looks exactly like a payload with nothing
sensitive in it — the demo still runs, the panel still lights up green, and the
account number is in the model's context. So compilation is loud, and lists
every problem at once: a toolkit or tool the catalogue does not list (tool names
are case-sensitive — `Records.get_record` is not a tool and is refused), a rule with
neither fields nor patterns, a malformed field path, a field path repeated
within a rule, an unparseable regex, a regex that matches the empty string (it
would rewrite every string it was pointed at), the sticky flag (it would scan
only from position 0), a marker some co-applicable pattern matches, a pattern
that can match the withheld sentinel, a duplicate pattern id, a subject matcher that can never match, an empty `reason`, a
duplicate rule id — and `remove` on an array element addressed by index, which
renumbers the elements after it and so does not mean the same thing twice.

The same loudness gap the PolicyEngine has applies here: the engine holds no
roster, so a misspelled *role* or *user id* in `subjects` cannot be caught at
compile time. Both engines share one definition of subject matching
(`src/subjects.ts`) so they cannot drift about who a rule governs.

## GrantChecker (`src/grant-checker.ts`, #10)

Pure, clock injected. Does a grant authorise **this** call?

```ts
import { checkGrant, selectGrant, consumeGrant, isGrantRejection } from "@cg/governance-core";

// One grant against one call.
const result = checkGrant({ grant, subject, tool, inputs, now: new Date() });

// Or a set of them — what /pre actually does with the rows for this subject.
const { grant, rejected } = selectGrant({ grants, subject, tool, inputs, now });

if (grant) {
  const decision = evaluatePermission({ subject, tool, inputs, policy, grants: [grant] });
  // …then, once the call has happened:
  await store.save(consumeGrant(grant));
}
```

`checkGrant` returns a `ValidatedGrant` — the only type `evaluatePermission` accepts, and
`attestGrantValidated` is called exactly once, on the last line of the happy path — or a
`GrantRejection`. Narrow with `isGrantRejection`. `selectGrant` is `checkGrant` over a set:
the first valid grant wins, and *every* rejection is reported so the audit row can show that
a stale grant was present and was not what authorised the call. No grants at all is an
ordinary outcome, not an error.

**It must be run against the inputs of the call being made.** The engine reads nothing of a
grant beyond `subject_id`, `match` and `id`; expiry, uses, approver, resource, pinned inputs
and the ceiling are checked here or nowhere. A grant validated once in the abstract and then
applied to a different resource at any amount is exactly the replay this module exists to
stop.

### Checking is not consuming

Two functions, deliberately. `checkGrant` has no side effects and never decrements anything;
`consumeGrant` spends one use and checks nothing. The caller checks, acts, then consumes and
persists — single use is enforced by the row, so a `consumeGrant` result that is never saved
is not a use. `consumeGrant` returns a plain `Grant`, not a `ValidatedGrant`, so a consumed
grant cannot go back to the engine without a fresh check.

### What is checked, in order

| # | Check | Rejection `kind` |
|---|---|---|
| 1 | The grant can constrain something at all: no wildcard in `match`, parseable timestamps, a finite ceiling, no input both pinned and bounded, `resource_id` carried by a pinned input | `unenforceable` |
| 2 | `granted_by ≠ subject_id` | `self_approved` |
| 3 | `subject_id` is the caller | `subject_mismatch` |
| 4 | Not revoked | `revoked` |
| 5 | `now` inside `[issued_at, expires_at)` | `not_yet_valid`, `expired` |
| 6 | Uses left (`null` is unlimited) | `consumed` |
| 7 | Exactly this `toolkit` and `tool` | `tool_mismatch` |
| 8 | Every pinned input present with the approved value | `resource_mismatch`, `pinned_input_mismatch` |
| 9 | The call's value on the bounded input is at or below `ceiling.max` | `ceiling_exceeded`, `ceiling_input_missing`, `ceiling_input_not_numeric` |

Order fixes which reason a grant that fails several checks is reported with, and it is
deliberate: a malformed grant reads as malformed rather than as a scope mismatch, because
the fix is different — one is a bug in whatever issued it, the other is the control working.

The window excludes its end: a grant good "until 12:15" is not good *at* 12:15.000. The
ceiling includes its bound: an approval for 95,000 authorises 95,000, mirroring
`exceeds_clearance`. Numbers are not coerced here either — `"95000"` is not ninety-five
thousand.

**Row 1 is the one to read twice.** A grant that constrains nothing is worse than no grant:
it is indistinguishable from a grant that permits, and it looks like a working control. A
`*` in a grant's `match` would authorise every tool it covers; a `resource_id` that no
pinned input carries is decorative, because nothing else in the system knows which argument
names the resource. Both are refused rather than ignored.

### Rejections

Every rejection carries a `GrantRejectionReason` — a discriminated union in
`@cg/policy-schema`, so the audit log and the panel render the same record — plus a
one-sentence `message` naming the values that produced it: *"The grant authorises
`"quantity"` up to 95, but the call passed 500000."* A compliance reviewer has to be able to
explain an outcome to an auditor (PRD stories 19–22), and "invalid" is not an explanation.

These are **not** the strings the model reads. A blocked call's remediation instruction is
the policy rule's `reason`; a grant that fails to lift a denial leaves that denial, and its
instruction, in place.

## EventBus (`src/event-bus.ts`, #20)

The odd one out: it holds state. No I/O, no HTTP, no SQLite — a subscriber registry the
audit write fans out through, so that "a decision was recorded" and "somebody is watching"
are two different concerns.

```ts
import { createEventBus } from "@cg/governance-core";

const bus = createEventBus({ onSubscriberError: (cause) => log(String(cause)) });
const off = bus.subscribe((batch) => queue.push(...batch));   // batch: PublishedEvent[]
bus.publish([{ seq, event }]);                                 // never throws
```

Everything downstream of this — the socket, the `text/event-stream` frames, replaying the log
for a `Last-Event-ID` — is `apps/hooks/src/events.ts`, because HTTP does not belong in this
package. What lives here is only the part a forker keeps.

`PublishedEvent` pairs a `GovernanceEvent` with its position in the log it was read out of.
The position is what makes a resumed stream exact rather than approximately right: it totally
orders every event the bus will carry, so a subscriber discards what it has already sent by
comparing two integers instead of remembering ids.

Three properties, all of them about the bus being unable to damage the thing publishing to
it — which is a hook request, inside a governance decision:

1. **Batches stay batches.** `publish` takes the whole array a transaction committed. A
   whole-project `/access` commits ~10,844 rows at once, and a subscriber handed them one at
   a time cannot tell that they were one decision.
2. **A subscriber cannot throw at the publisher.** Delivery is wrapped per subscriber and
   reported through `onSubscriberError`. A broken view must not turn a recorded decision into
   a failed tool call; that would invert the point of putting the controls outside the model.
3. **A subscriber may unsubscribe during delivery.** Delivery iterates a snapshot, so a
   stream that closes itself in response to an event does not skip the subscriber behind it.

Delivery is synchronous, inside the publisher's stack. A subscriber must do no work beyond
queueing.

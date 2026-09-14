/**
 * What a `modify` did, drawn from the control plane's own account of it.
 *
 * Act 3's whole point is that a bank account number never reached the model.
 * This panel is the one surface guaranteed to be on a projector, so printing
 * that number would be worse than having no diff at all. The rule here is
 * therefore absolute and not a matter of configuration:
 *
 * > **A removed value is never rendered.** It is replaced by a mask. Not
 * > truncated, not partially shown, not hashed — masked.
 *
 * That rule is easy to keep here because **this module is never handed a
 * value**. A `/post` event carries `redactions[]` and nothing else: path,
 * `rule_id`, `pattern_id`, kind. `before` and `after` were retired from
 * `GovernanceEvent` outright (#16 decided it, #101 deleted the fields), because
 * the audit log is durable and `GET /events` is unauthenticated — an optional
 * payload slot is exactly where the raw output would eventually end up.
 *
 * So there is one source, {@link redactionRows}: one row per `RedactionRecord`,
 * where the *record* says what changed, the mask is derived from `kind` rather
 * than from a value nobody sent, and the rule that took each leaf is named.
 * {@link diffRowsFor} is the entry point the card calls.
 *
 * This file used to carry a second source, `maskedDiff()`, which walked a
 * `before`/`after` pair and masked every leaf that differed. It went with the
 * fields (#101): with no event able to carry a payload, it was a fallback for a
 * shape the type system forbids. Its disappearance is the reason the empty case
 * below is now unambiguous — no rows means the event reported no redactions,
 * and nothing else.
 */

import type { GovernanceEvent, RedactionRecord } from "@cg/policy-schema";

/**
 * What happened to one leaf of the payload. There is no `added`: a redaction
 * only ever substitutes or deletes, and a row claiming the control plane added
 * something would be a claim no `RedactionRecord` can support.
 */
export type DiffChange = "changed" | "removed";

/**
 * One line of the diff. `before` is *always* a mask; `after` is what the model
 * was left with, said in words, or `null` where the leaf was removed outright.
 */
export interface DiffRow {
  /** Canonical JSONPath into the tool's output, e.g. `$.bank_account_number`. */
  readonly path: string;
  readonly change: DiffChange;
  /** A mask standing in for the removed value. Never the value. */
  readonly before: string | null;
  /** What the model actually received here. */
  readonly after: string | null;
  /**
   * The `rule_id` — and the `pattern_id` when a sweep rather than a named field
   * did the work — naming *why* this leaf changed.
   */
  readonly annotation: string | null;
}

/**
 * What the model got where a value used to be, said in words.
 *
 * Derived from `kind` alone, because a `RedactionRecord` deliberately carries
 * no value and no replacement text — see its docstring in `@cg/policy-schema`.
 * So the panel can say *that* a field was masked and never what the mask
 * covered, which is the invariant this whole file exists to keep.
 */
const OUTCOME: Record<RedactionRecord["kind"], string | null> = {
  mask: "masked",
  replace: "replaced",
  // `null` renders as "removed entirely": the key is gone from the payload
  // rather than standing there holding a marker.
  remove: null,
  unsettled: "withheld — the output policy did not settle",
};

/** `changed` for a substitution, `removed` for a deletion. */
const CHANGE: Record<RedactionRecord["kind"], DiffChange> = {
  mask: "changed",
  replace: "changed",
  remove: "removed",
  unsettled: "changed",
};

/**
 * The mask every row shows in place of what was taken.
 *
 * It is a phrase, not a row of dots. The first cut of this panel drew `●●●●●●`
 * and a design review caught the problem: at projector distance a run of dots
 * reads as a value — an account number in a masked font — rather than as the
 * absence of one. A mask has to be unmistakably a mask, so it says so in words,
 * and the renderer puts a hatched field behind it.
 *
 * It says nothing about the value's type either, unlike the payload diff this
 * replaced: the record does not say whether what went was a string or a number,
 * and guessing would be inventing detail about a value nobody has.
 */
const MASK = "value withheld";

/**
 * One row per redaction, in the order the engine reported them (rule priority,
 * then id), so the panel reads in the same order the audit row does.
 */
export function redactionRows(redactions: readonly RedactionRecord[]): DiffRow[] {
  return redactions.map((record) => ({
    path: record.path,
    change: CHANGE[record.kind],
    before: MASK,
    after: OUTCOME[record.kind],
    annotation: [record.rule_id, record.pattern_id].filter((part) => part !== null).join(" · ") || null,
  }));
}

/**
 * The rows for one event.
 *
 * An event with no `redactions[]` yields no rows, and that is the one case the
 * renderer is allowed to call unchanged. It is unambiguous now: before #101 a
 * `modify` could also draw nothing because it carried a payload this module
 * failed to read, which is exactly how act 3 once rendered as "the payload came
 * back unchanged".
 */
export function diffRowsFor(event: GovernanceEvent): DiffRow[] {
  return redactionRows(event.redactions ?? []);
}

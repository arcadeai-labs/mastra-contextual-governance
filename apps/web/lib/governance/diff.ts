/**
 * The before/after diff, with every removed value masked.
 *
 * Act 3's whole point is that a bank account number never reached the model.
 * This panel is the one surface guaranteed to be on a projector, so printing
 * that number in the diff would be worse than having no diff at all. The rule
 * here is therefore absolute and not a matter of configuration:
 *
 * > **A `before` value is never rendered.** It is replaced by a mask built from
 * > nothing but the value's type. Not truncated, not partially shown, not
 * > hashed — masked.
 *
 * `after` *is* rendered, because `after` is by definition what the control
 * plane let through to the model. Hiding it would leave the diff saying
 * nothing, and a diff that shows neither side does not demonstrate a control.
 *
 * Why every `before` and not just the sensitive ones: a `GovernanceEvent`
 * carries `before` and `after` as opaque payloads and nothing on it says which
 * leaf was masked for being a secret and which was rewritten for carrying an
 * injected instruction. With no way to tell them apart, the safe reading of
 * every removed value is "secret".
 *
 * **Since #16 a `/post` event carries `redactions[]` and no payload at all** —
 * not `before`, not `after`, because the audit log is durable and `GET /events`
 * is unauthenticated. There is therefore nothing for {@link maskedDiff} to
 * compare on a redaction event, and a panel that asked it anyway got two
 * `undefined`s, no rows, and the "came back unchanged" placeholder printed over
 * the act the demo exists to show. {@link redactionRows} is the other source:
 * one row per `RedactionRecord`, where the *record* says what changed and the
 * mask is derived from `kind` rather than from a value nobody sent.
 *
 * {@link diffRowsFor} picks between them, and `redactions[]` wins: it is the
 * control plane's own account of what it removed, and an event carrying one is
 * never described as unchanged.
 */

import type { GovernanceEvent, RedactionRecord } from "@cg/policy-schema";

/** What happened to one leaf of the payload. */
export type DiffChange = "changed" | "removed" | "added";

/**
 * One line of the diff. `before` is *always* a mask; `after` is the real value
 * rendered as text, or `null` where the leaf was removed outright.
 */
export interface DiffRow {
  /** Dot-and-bracket path into the payload, e.g. `applicant.accounts[0].number`. */
  readonly path: string;
  readonly change: DiffChange;
  /** A mask standing in for the removed value. Never the value. */
  readonly before: string | null;
  /** What the model actually received here. */
  readonly after: string | null;
  /**
   * The `rule_id` — and the `pattern_id` when a sweep rather than a named field
   * did the work — naming *why* this leaf changed. Populated from
   * `redactions[]`; `null` on a row derived by comparing two payloads, where
   * nothing on the event says which rule touched which leaf.
   */
  readonly annotation: string | null;
}

/**
 * A stand-in for a value, derived from its **type** and never its content.
 *
 * It is a phrase, not a row of dots. The first cut of this panel drew `●●●●●●`
 * and a design review caught the problem: at projector distance a run of dots
 * reads as a value — an account number in a masked font — rather than as the
 * absence of one. A mask has to be unmistakably a mask, so it says so in
 * words, and the renderer puts a hatched field behind it.
 *
 * Saying only the type also leaks strictly less than the dots did. The dots
 * were length-proportional up to a cap, so a short PIN and a long note looked
 * different; these do not.
 */
function mask(value: unknown): string {
  // `null` is not a secret and there is nothing to withhold, so it is named.
  if (value === null) return "null";
  if (typeof value === "string") return "text withheld";
  if (typeof value === "number") return "number withheld";
  if (typeof value === "boolean") return "value withheld";
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"} withheld`;
  }
  if (typeof value === "object") return "object withheld";
  return "value withheld";
}

/** How a surviving value reads on screen. Only ever applied to `after`. */
function show(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * The leaves that differ between `before` and `after`, deepest-first within
 * each branch, in the payload's own key order.
 *
 * Unchanged leaves are omitted — that is what makes the diff readable from
 * across a room. A `modify` whose payloads are identical yields no rows, and
 * the renderer says so rather than drawing an empty box.
 */
export function maskedDiff(before: unknown, after: unknown): DiffRow[] {
  const rows: DiffRow[] = [];

  function walk(path: string, left: unknown, right: unknown): void {
    if (isRecord(left) && isRecord(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(join(path, key), key in left ? left[key] : undefined, key in right ? right[key] : undefined);
      }
      return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        walk(`${path}[${index}]`, left[index], right[index]);
      }
      return;
    }

    if (left === undefined && right === undefined) return;

    if (left === undefined) {
      rows.push({ path, change: "added", before: null, after: show(right), annotation: null });
      return;
    }
    if (right === undefined) {
      rows.push({ path, change: "removed", before: mask(left), after: null, annotation: null });
      return;
    }

    // Two values of different shape, or two differing leaves. `JSON.stringify`
    // is the comparison rather than `===` so an object replaced by an object
    // with the same contents does not read as a change.
    if (JSON.stringify(left) === JSON.stringify(right)) return;

    rows.push({ path, change: "changed", before: mask(left), after: show(right), annotation: null });
  }

  walk("", before, after);
  return rows;
}

// ---------------------------------------------------------------------------
// Rows from `redactions[]` — the shape a real `/post` event arrives in
// ---------------------------------------------------------------------------

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

/** `changed` for a substitution, `removed` for a deletion. Never `added`. */
const CHANGE: Record<RedactionRecord["kind"], DiffChange> = {
  mask: "changed",
  replace: "changed",
  remove: "removed",
  unsettled: "changed",
};

/**
 * One row per redaction, in the order the engine reported them (rule priority,
 * then id), so the panel reads in the same order the audit row does.
 *
 * `before` is the same mask phrase the payload diff uses, minus the type: the
 * record does not say whether what went was a string or a number, and guessing
 * would be inventing detail about a value nobody has.
 */
export function redactionRows(redactions: readonly RedactionRecord[]): DiffRow[] {
  return redactions.map((record) => ({
    path: record.path,
    change: CHANGE[record.kind],
    before: "value withheld",
    after: OUTCOME[record.kind],
    annotation: [record.rule_id, record.pattern_id].filter((part) => part !== null).join(" · ") || null,
  }));
}

/**
 * The rows for one event, from whichever account of the change it carries.
 *
 * `redactions[]` first and by preference: it is the control plane's own record,
 * it names the rule per leaf, and it exists precisely so the event does not
 * have to carry the payload. Falling back to the payload diff keeps the older
 * shape renderable — a hook that does send `before`/`after` still draws — and
 * an event with neither yields no rows, which is the one case the renderer is
 * allowed to call unchanged.
 */
export function diffRowsFor(event: GovernanceEvent): DiffRow[] {
  if (event.redactions !== undefined && event.redactions.length > 0) {
    return redactionRows(event.redactions);
  }
  return maskedDiff(event.before, event.after);
}

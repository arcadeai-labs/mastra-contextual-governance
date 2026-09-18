/**
 * How each decision and each control point is named and drawn.
 *
 * One table, because the panel's central claim is that the audience can tell
 * three states apart at a glance from across a room. That is only true if a
 * decision looks the same everywhere it appears, and it is only checkable if
 * there is one place to check.
 *
 * Every decision carries a **glyph and a word** as well as a colour. Colour
 * alone fails for a colour-blind viewer, on a washed-out projector, and in the
 * phone photo somebody takes of the slide — and the three glyphs here are in
 * every font this will ever render in, unlike an icon set.
 */
import type { Effect, HookPoint } from "@cg/policy-schema";

export interface DecisionStyle {
  /** The word on the card. What a presenter says out loud. */
  readonly label: string;
  /** Legible without a webfont, in any font, at any size. */
  readonly glyph: string;
  /** For a lane's own counter, where it reads as "2 allowed" in a sentence. */
  readonly lane: string;
}

export const DECISIONS: Readonly<Record<Effect, DecisionStyle>> = {
  allow: { label: "Allowed", glyph: "✓", lane: "allowed" },
  deny: { label: "Denied", glyph: "✕", lane: "denied" },
  // "Not equal" is what a modification is, and it is what the diff underneath
  // shows — the glyph and the evidence say the same thing.
  modify: { label: "Modified", glyph: "≠", lane: "modified" },
};

/** The order a lane's counters read in. Allow first: most calls are allowed. */
export const DECISION_ORDER = ["allow", "deny", "modify"] as const;

export interface LaneStyle {
  readonly name: string;
  /** Plain language, so nobody needs to already know what a pre-hook is. */
  readonly gloss: string;
  /** What an empty lane says. An invitation to watch, not a shrug. */
  readonly empty: string;
}

export const LANES: Readonly<Record<HookPoint, LaneStyle>> = {
  access: {
    name: "Access",
    gloss: "Which tools this person can see",
    empty: "No tool list has been requested yet.",
  },
  pre: {
    name: "Pre",
    gloss: "Whether this call may be made",
    empty: "No call has been attempted yet.",
  },
  post: {
    name: "Post",
    gloss: "What is allowed back to the model",
    empty: "Nothing has come back yet.",
  },
};

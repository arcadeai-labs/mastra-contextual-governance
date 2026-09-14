/**
 * The stream, grouped the way a person reads it.
 *
 * `text` events are **deltas**, not messages. `events.ts` says so in one line —
 * "a run of assistant text; concatenate in order" — and `lib/agent/run.ts`
 * emits one per `text-delta` chunk the provider produces, which live is a few
 * characters each. The chat rendered one block per event, so the first live turn
 * on Render read:
 *
 *     It
 *     looks like the lo
 *     an system
 *     need
 *     s you
 *
 * The scripted tests never caught it because the stubs emit whole sentences:
 * with `{ kind: "text", text: "It looks like…" }` going in, one block per event
 * and one block per reply are the same picture. That is the shape of this bug
 * and it is worth naming — a fixture coarser than production makes a rendering
 * fault invisible, and the only thing that finds it is a test that streams the
 * way the provider does (`test/chat-rendering.test.tsx` feeds three characters
 * at a time).
 *
 * So: consecutive `text` events fold into one reply block, and everything else
 * stays an event of its own, in arrival order.
 *
 * **Consecutive, not all.** Text before a tool call and text after it are two
 * things the model said either side of doing something, and the tool call
 * belongs between them — that ordering is most of what the chat is for on this
 * demo. Joining every `text` event in the turn would hoist the whole reply above
 * the first `tool-call` and lose it. (`replyText()` in `events.ts` does join
 * them all, and should: it answers "what did the model say this turn", which is
 * a different question from "what does this screen show".)
 */
import type { ChatEvent } from "../../lib/agent/events.ts";

/** One thing on screen: a run of the model's prose, or one non-text event. */
export type Block =
  /** Consecutive `text` events, concatenated. Rendered as markdown. */
  | { kind: "reply"; text: string }
  | { kind: "event"; event: ChatEvent };

/**
 * Blocks in arrival order.
 *
 * Pure, and re-run on every render rather than accumulated into state: the
 * events array is the only source of truth for what the turn has produced, and
 * a second copy of the reply kept in a ref is a second copy that can disagree
 * with it.
 */
export function transcript(events: readonly ChatEvent[]): Block[] {
  const blocks: Block[] = [];

  for (const event of events) {
    if (event.kind !== "text") {
      blocks.push({ kind: "event", event });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "reply") last.text += event.text;
    else blocks.push({ kind: "reply", text: event.text });
  }

  return blocks;
}

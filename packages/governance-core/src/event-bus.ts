/**
 * The in-process fan-out for `GovernanceEvent`s.
 *
 * One publisher — the audit write — and as many subscribers as there are open
 * streams. Nothing here knows about HTTP, SQLite or the wire format: encoding a
 * batch as `text/event-stream` frames and holding a socket open is the hook
 * server's job (`apps/hooks/src/events.ts`). This module is the seam between
 * "a decision was recorded" and "somebody is watching", and it is here rather
 * than in `apps/hooks` because `DESIGN.md` lists the event bus in this package
 * and a subscriber registry is exactly as domain-free as the rest of it.
 *
 * Three properties the callers depend on, all of them about the bus never
 * being able to damage the thing publishing to it:
 *
 * 1. **Batches stay batches.** `publish` takes the whole array a transaction
 *    committed, because a whole-project `/access` commits ~10,844 rows at once
 *    (measured, `bun run --cwd apps/hooks bench`) and a subscriber that has to
 *    reason about them one at a time cannot tell that they were one decision.
 * 2. **A subscriber cannot throw at the publisher.** Delivery is wrapped per
 *    subscriber. A broken stream must not turn a recorded decision into a
 *    failed hook call — the panel is a view, and a view breaking the control
 *    plane would invert the whole point of the architecture.
 * 3. **A subscriber may unsubscribe during delivery.** Delivery iterates a
 *    snapshot, so a stream that closes itself in response to an event does not
 *    skip the subscriber that happens to sit after it.
 *
 * Delivery is synchronous. It runs inside the publisher's stack — which is
 * inside a hook request — so a subscriber's handler must do no work beyond
 * queueing. The hook server's does: it appends to an array and resolves a
 * promise.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

/**
 * One event, with its position in the log it was read out of.
 *
 * The position is what makes a resumed stream exact rather than approximately
 * right: it is monotonic, it totally orders every event the bus will ever
 * carry, and it lets a subscriber discard something it has already sent by
 * comparing two integers instead of remembering ids.
 */
export interface PublishedEvent {
  /** Monotonic, gap-tolerant, strictly increasing in commit order. */
  readonly seq: number;
  readonly event: GovernanceEvent;
}

/**
 * The fan-out, over whatever a caller publishes.
 *
 * Generic because #20's resume half needed a second one carrying something
 * that is deliberately *not* a `GovernanceEvent`: an approval decision is a
 * store write, not a hook decision, and `audit_log` enforces that distinction
 * (`hook` is `access|pre|post`). The three properties above are the reason to
 * share the implementation rather than write the registry twice — they are
 * about the bus never damaging its publisher, and that argument does not
 * depend on what is being carried.
 */
export type BusSubscriber<T> = (batch: readonly T[]) => void;

export interface Bus<T> {
  /**
   * Hands `batch` to every current subscriber, in subscription order. Never
   * throws. A no-op when `batch` is empty or nobody is listening.
   */
  publish(batch: readonly T[]): void;
  /** Registers `subscriber`. The returned function removes it, idempotently. */
  subscribe(subscriber: BusSubscriber<T>): () => void;
  /** How many subscribers are currently registered. For `/health`. */
  readonly subscribers: number;
}

/** The governance stream's bus. The original, and still the only publisher of audit rows. */
export type EventBus = Bus<PublishedEvent>;
export type EventBusSubscriber = BusSubscriber<PublishedEvent>;

export interface EventBusOptions {
  /**
   * Called with whatever a subscriber threw. The default is silence, because
   * the bus has no opinion about logging; the hook server passes its logger.
   */
  readonly onSubscriberError?: (cause: unknown) => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  return createBus<PublishedEvent>(options);
}

/** The same registry, for anything else one process wants to fan out. */
export function createBus<T>(options: EventBusOptions = {}): Bus<T> {
  const onSubscriberError = options.onSubscriberError ?? (() => {});
  const subscribers = new Set<BusSubscriber<T>>();

  return {
    publish(batch: readonly T[]): void {
      if (batch.length === 0 || subscribers.size === 0) return;
      // A snapshot: a subscriber that unsubscribes while being delivered to
      // must not shift the iteration out from under the ones behind it.
      for (const subscriber of [...subscribers]) {
        // Still registered? The snapshot may name one that just left.
        if (!subscribers.has(subscriber)) continue;
        try {
          subscriber(batch);
        } catch (cause) {
          onSubscriberError(cause);
        }
      }
    },

    subscribe(subscriber: BusSubscriber<T>): () => void {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },

    get subscribers(): number {
      return subscribers.size;
    },
  };
}

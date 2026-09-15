/**
 * The bus's job is to be unable to hurt the thing publishing to it. These are
 * the three ways it could: a throwing subscriber, a subscriber that leaves
 * mid-delivery, and one that was already gone.
 */
import { describe, expect, test } from "bun:test";

import { createEventBus, type PublishedEvent } from "../src/event-bus.ts";

const at = (seq: number): PublishedEvent => ({
  seq,
  event: {
    id: `evt_${seq}`,
    ts: "2026-01-01T00:00:00.000Z",
    execution_id: `tc_${seq}`,
    hook: "pre",
    user_id: "subject@example.com",
    tool: "Records.ApproveRecord",
    decision: "deny",
    reason: "over clearance",
    rule_id: "pre.approve-within-clearance",
  },
});

describe("createEventBus", () => {
  test("delivers a batch whole, to every subscriber, in subscription order", () => {
    const bus = createEventBus();
    const order: string[] = [];
    const first: PublishedEvent[][] = [];
    bus.subscribe((batch) => {
      order.push("first");
      first.push([...batch]);
    });
    bus.subscribe(() => order.push("second"));

    bus.publish([at(1), at(2)]);

    expect(order).toEqual(["first", "second"]);
    // One delivery of two, not two of one: a whole-project /access is one
    // decision and a subscriber has to be able to see that.
    expect(first).toHaveLength(1);
    expect(first[0]!.map((published) => published.seq)).toEqual([1, 2]);
  });

  test("unsubscribing is idempotent and stops delivery", () => {
    const bus = createEventBus();
    const seen: number[] = [];
    const off = bus.subscribe((batch) => seen.push(batch.length));

    bus.publish([at(1)]);
    off();
    off();
    bus.publish([at(2)]);

    expect(seen).toEqual([1]);
    expect(bus.subscribers).toBe(0);
  });

  test("a throwing subscriber is reported and does not stop the ones after it", () => {
    const failures: unknown[] = [];
    const bus = createEventBus({ onSubscriberError: (cause) => failures.push(cause) });
    bus.subscribe(() => {
      throw new Error("the panel exploded");
    });
    const seen: number[] = [];
    bus.subscribe((batch) => seen.push(batch[0]!.seq));

    // Never throws at the publisher: the publisher is a hook request, and a
    // broken view must not turn a recorded decision into a failed tool call.
    expect(() => bus.publish([at(7)])).not.toThrow();
    expect(seen).toEqual([7]);
    expect(String(failures[0])).toInclude("the panel exploded");
  });

  test("a subscriber that unsubscribes another mid-delivery does not skip anyone", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    let offSecond = () => {};
    bus.subscribe(() => {
      seen.push("first");
      offSecond();
    });
    offSecond = bus.subscribe(() => seen.push("second"));
    bus.subscribe(() => seen.push("third"));

    bus.publish([at(1)]);

    // The one removed during this delivery is skipped; the one behind it — the
    // failure mode a live `for…of` over the set would have — is not.
    expect(seen).toEqual(["first", "third"]);
  });

  test("an empty batch and an audience of nobody are both no-ops", () => {
    const bus = createEventBus();
    let calls = 0;
    bus.subscribe(() => {
      calls += 1;
    });
    bus.publish([]);
    expect(calls).toBe(0);
    expect(() => createEventBus().publish([at(1)])).not.toThrow();
  });

  test("counts its subscribers, which is what /health reports", () => {
    const bus = createEventBus();
    expect(bus.subscribers).toBe(0);
    const off = bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.subscribers).toBe(2);
    off();
    expect(bus.subscribers).toBe(1);
  });
});

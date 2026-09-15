/**
 * The stream client, driven against a real HTTP server on a real socket.
 *
 * Nothing here stubs `fetch` or hand-feeds the decoder: every test starts a
 * `Bun.serve` on a port the OS handed out, writes actual `text/event-stream`
 * bytes down it, and asserts on what came out of `subscribeToGovernanceEvents`.
 * A mocked transport would pass while the real one 404s.
 *
 * Ports are never hard-coded and never guessed. `port: 0` asks the OS for a
 * free one and `server.port` reads it back, the way
 * `tools/loan/tests/conftest.py::_free_port` does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GovernanceEvent } from "@cg/policy-schema";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";

import {
  GOVERNANCE_EVENT_NAME,
  subscribeToGovernanceEvents,
  type StreamStatus,
} from "../lib/governance/subscribe.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

/** A server whose handler writes SSE bytes. Returns its address. */
function serve(
  handler: (request: Request, write: (text: string) => void) => void | Promise<void>,
): {
  url: string;
  requests: Request[];
} {
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          let open = true;
          const write = (text: string): void => {
            if (open) controller.enqueue(encoder.encode(text));
          };
          try {
            await handler(request, write);
          } finally {
            open = false;
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** One `event: governance` frame on the wire. */
function frame(event: GovernanceEvent): string {
  return `event: ${GOVERNANCE_EVENT_NAME}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Waits for `predicate`, or fails the test loudly rather than hanging forever. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

interface Collected {
  readonly events: GovernanceEvent[];
  readonly batches: GovernanceEvent[][];
  readonly statuses: StreamStatus[];
  readonly unusable: Array<{ data: string; problem: string }>;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

function collect(url: string, retryMs = 20): Collected {
  const events: GovernanceEvent[] = [];
  const batches: GovernanceEvent[][] = [];
  const statuses: StreamStatus[] = [];
  const unusable: Array<{ data: string; problem: string }> = [];
  const controller = new AbortController();

  const done = subscribeToGovernanceEvents(url, {
    onEvents: (batch) => {
      batches.push(batch);
      events.push(...batch);
    },
    onStatus: (status) => statuses.push(status),
    onUnusableFrame: (data, problem) => unusable.push({ data, problem }),
    signal: controller.signal,
    retryMs,
  });

  return { events, batches, statuses, unusable, controller, done };
}

describe("events reach the panel", () => {
  test("every event on the stream is delivered, in order", async () => {
    const sequence = aGovernanceEventSequence();
    const { url } = serve((_request, write) => {
      for (const event of sequence) write(frame(event));
    });

    const run = collect(url);
    await until(() => run.events.length === sequence.length, "all five fixture events");
    run.controller.abort();
    await run.done;

    expect(run.events.map((event) => event.id)).toEqual(sequence.map((event) => event.id));
  });

  test("the whole event is delivered, not just its id", async () => {
    const modify = aGovernanceEventSequence().find((event) => event.decision === "modify")!;
    const { url } = serve((_request, write) => write(frame(modify)));

    const run = collect(url);
    await until(() => run.events.length === 1, "the modify event");
    run.controller.abort();
    await run.done;

    expect(run.events[0]).toEqual(modify);
  });

  test("an event lands at the panel well inside a second of being written", async () => {
    let writtenAt = 0;
    const { url } = serve(async (_request, write) => {
      // Let the client settle before the clock starts, so the measurement is
      // the delivery path and not the connection handshake.
      write(": ready\n\n");
      await Bun.sleep(50);
      writtenAt = performance.now();
      write(frame(aGovernanceEvent({ id: "evt_timed" })));
      await Bun.sleep(500);
    });

    const run = collect(url);
    await until(() => run.events.length === 1, "the timed event");
    const latency = performance.now() - writtenAt;
    run.controller.abort();
    await run.done;

    expect(latency).toBeLessThan(1000);
  });
});

describe("a burst", () => {
  test("a thousand events arrive complete and in order", async () => {
    const burst = Array.from({ length: 1000 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${String(index).padStart(4, "0")}` }),
    );
    const { url } = serve((_request, write) => {
      for (const event of burst) write(frame(event));
    });

    const run = collect(url);
    await until(() => run.events.length === burst.length, "a thousand events");
    run.controller.abort();
    await run.done;

    expect(run.events.map((event) => event.id)).toEqual(burst.map((event) => event.id));
  });

  test("a burst is coalesced into far fewer batches than events", async () => {
    // What keeps a burst from costing a thousand renders: each socket read
    // hands over everything it yielded, together.
    const burst = Array.from({ length: 1000 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}` }),
    );
    const { url } = serve((_request, write) => {
      for (const event of burst) write(frame(event));
    });

    const run = collect(url);
    await until(() => run.events.length === burst.length, "a thousand events");
    run.controller.abort();
    await run.done;

    expect(run.batches.length).toBeLessThan(burst.length / 2);
  });
});

describe("frames the panel cannot use", () => {
  test("a frame that is not JSON is reported and the stream carries on", async () => {
    const { url } = serve((_request, write) => {
      write(`event: ${GOVERNANCE_EVENT_NAME}\ndata: not json at all\n\n`);
      write(frame(aGovernanceEvent({ id: "evt_after_bad_json" })));
    });

    const run = collect(url);
    await until(() => run.events.length === 1, "the event after the bad one");
    run.controller.abort();
    await run.done;

    expect(run.unusable).toEqual([{ data: "not json at all", problem: "not JSON" }]);
    expect(run.events[0]?.id).toBe("evt_after_bad_json");
  });

  test("JSON that is not a GovernanceEvent is reported and the stream carries on", async () => {
    const { url } = serve((_request, write) => {
      write(`event: ${GOVERNANCE_EVENT_NAME}\ndata: {"hook":"nowhere"}\n\n`);
      write(frame(aGovernanceEvent({ id: "evt_after_bad_shape" })));
    });

    const run = collect(url);
    await until(() => run.events.length === 1, "the event after the bad one");
    run.controller.abort();
    await run.done;

    expect(run.unusable).toHaveLength(1);
    expect(run.events[0]?.id).toBe("evt_after_bad_shape");
  });

  test("a frame of another event name is ignored, not reported as broken", async () => {
    // #20 puts `approval.granted` down this same stream. It is not this
    // panel's to render, and it must not look like a contract violation.
    const { url } = serve((_request, write) => {
      write('event: approval.granted\ndata: {"request_id":"REQ-1"}\n\n');
      write(frame(aGovernanceEvent({ id: "evt_after_other" })));
    });

    const run = collect(url);
    await until(() => run.events.length === 1, "the governance event");
    run.controller.abort();
    await run.done;

    expect(run.unusable).toEqual([]);
    expect(run.events.map((event) => event.id)).toEqual(["evt_after_other"]);
  });
});

describe("reconnecting", () => {
  test("an initial replay anchor is sent once, then normal resume takes over", async () => {
    let connections = 0;
    const { url, requests } = serve((_request, write) => {
      connections += 1;
      write(frame(aGovernanceEvent({ id: `evt_initial_${connections}` })));
    });

    const controller = new AbortController();
    const events: GovernanceEvent[] = [];
    const done = subscribeToGovernanceEvents(url, {
      initialLastEventId: "0",
      onEvents: (batch) => events.push(...batch),
      signal: controller.signal,
      retryMs: 20,
    });

    await until(() => events.length >= 2, "the replayed event and its resume");
    controller.abort();
    await done;

    expect(requests[0]?.headers.get("last-event-id")).toBe("0");
    expect(requests[1]?.headers.get("last-event-id")).toBe("evt_initial_1");
  });

  test("the stream reopens after the server closes it", async () => {
    let connections = 0;
    const { url } = serve((_request, write) => {
      connections += 1;
      write(frame(aGovernanceEvent({ id: `evt_conn_${connections}` })));
    });

    const run = collect(url);
    await until(() => run.events.length >= 2, "an event from a second connection");
    run.controller.abort();
    await run.done;

    expect(run.events.map((event) => event.id)).toEqual(["evt_conn_1", "evt_conn_2"]);
  });

  test("the resume asks to continue from the last id it saw", async () => {
    let connections = 0;
    const { url, requests } = serve((_request, write) => {
      connections += 1;
      if (connections === 1) write(frame(aGovernanceEvent({ id: "evt_4k7xq2m9hz" })));
      else write(frame(aGovernanceEvent({ id: "evt_8t3zh6vd2m" })));
    });

    const run = collect(url);
    await until(() => run.events.length >= 2, "the resumed event");
    run.controller.abort();
    await run.done;

    expect(requests[0]?.headers.get("last-event-id")).toBeNull();
    expect(requests[1]?.headers.get("last-event-id")).toBe("evt_4k7xq2m9hz");
  });

  test("a refused connection is retried rather than ending the subscription", async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts += 1;
        if (attempts < 3) return new Response("nope", { status: 503 });
        return new Response(frame(aGovernanceEvent({ id: "evt_eventually" })), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    servers.push(server);

    const run = collect(`http://127.0.0.1:${server.port}`);
    await until(() => run.events.length === 1, "the event after two refusals");
    run.controller.abort();
    await run.done;

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(run.events[0]?.id).toBe("evt_eventually");
  });

  test("a server that never answers does not throw at the caller", async () => {
    // Nothing is listening on this port: the OS handed it out and we released
    // it immediately, so connecting is refused rather than hanging.
    const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
    const { port } = probe;
    probe.stop(true);

    const run = collect(`http://127.0.0.1:${port}`);
    await until(() => run.statuses.includes("reconnecting"), "a reconnect attempt");
    run.controller.abort();

    await run.done;
    expect(run.events).toEqual([]);
  });
});

describe("what the panel can say about its own connection", () => {
  test("connecting, then live", async () => {
    const { url } = serve(async (_request, write) => {
      write(frame(aGovernanceEvent({ id: "evt_status" })));
      await Bun.sleep(200);
    });

    const run = collect(url);
    await until(() => run.events.length === 1, "the event");
    run.controller.abort();
    await run.done;

    expect(run.statuses.slice(0, 2)).toEqual(["connecting", "live"]);
  });

  test("reconnecting is reported after a drop", async () => {
    const { url } = serve((_request, write) => write(frame(aGovernanceEvent({ id: "evt_drop" }))));

    const run = collect(url);
    await until(() => run.statuses.includes("reconnecting"), "a reconnect");
    run.controller.abort();
    await run.done;

    expect(run.statuses).toContain("reconnecting");
  });
});

describe("aborting", () => {
  test("resolves and stops delivering", async () => {
    const { url } = serve(async (_request, write) => {
      for (let index = 0; index < 200; index += 1) {
        write(frame(aGovernanceEvent({ id: `evt_${index}` })));
        await Bun.sleep(10);
      }
    });

    const run = collect(url);
    await until(() => run.events.length > 0, "the first event");
    run.controller.abort();
    await run.done;

    const delivered = run.events.length;
    await Bun.sleep(60);

    expect(run.events).toHaveLength(delivered);
  });

  test("a signal already aborted opens no connection at all", async () => {
    const { url, requests } = serve((_request, write) => write(": hello\n\n"));
    const controller = new AbortController();
    controller.abort();

    await subscribeToGovernanceEvents(url, {
      onEvents: () => {},
      signal: controller.signal,
    });

    expect(requests).toEqual([]);
  });
});

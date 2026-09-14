/**
 * A minimal `text/event-stream` reader, for tests that drive `GET /events` over
 * a real socket.
 *
 * Deliberately **not** `apps/web`'s decoder: this package cannot import an app,
 * and a test that shared the client's parser could not catch the two of them
 * agreeing on something wrong. It reads only what the contract says is there —
 * `event:`, `id:`, `data:` and comments — which is also what makes it the right
 * place to assert that an approval frame carries no `id:` at all (#20).
 *
 * Extracted from `events.test.ts` when #20's resume half needed the same reader
 * for the second event name on the same socket.
 */
import { expect } from "bun:test";

export interface Frame {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

export interface Reader {
  /** Frames received so far, in arrival order. */
  readonly frames: Frame[];
  /** Comment lines received so far, without the leading colon. */
  readonly comments: string[];
  /** Every byte received, for assertions about the layout itself. */
  readonly raw: () => string;
  /** Resolves once `count` frames have arrived, or rejects after `timeoutMs`. */
  readonly untilFrames: (count: number, timeoutMs?: number) => Promise<void>;
  /** Resolves once the server closed the stream. */
  readonly untilClosed: (timeoutMs?: number) => Promise<void>;
  /** Reads whatever is already buffered, without waiting for more. */
  readonly settle: (ms?: number) => Promise<void>;
  /** Stops reading the socket, so the server feels real backpressure. */
  readonly pause: () => void;
  /** Starts reading again. A lagging panel is slow, not frozen for ever. */
  readonly resume: () => void;
  readonly closed: () => boolean;
  readonly abort: () => void;
}

/** Opens a stream and drains it in the background. */
export async function openEventStream(base: string, lastEventId?: string): Promise<Reader> {
  const controller = new AbortController();
  const headers: Record<string, string> = { accept: "text/event-stream", "cache-control": "no-cache" };
  if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;

  const response = await fetch(`${base}/events`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const body = response.body;
  if (body === null) throw new Error("no body");

  const frames: Frame[] = [];
  const comments: string[] = [];
  let text = "";
  let buffer = "";
  let done = false;
  let paused = false;

  const pump = (async () => {
    const stream = body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        while (paused) await Bun.sleep(5);
        const chunk = await stream.read();
        if (chunk.done) break;
        text += chunk.value;
        buffer += chunk.value;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "";
          let id: string | null = null;
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(": ")) comments.push(line.slice(2));
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (data.length > 0) frames.push({ event, id, data: data.join("\n") });
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // An abort from the test, or the server closing mid-read.
    } finally {
      done = true;
    }
  })();

  const waitFor = async (predicate: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (have ${frames.length} frames)`);
      await Bun.sleep(5);
    }
  };

  return {
    frames,
    comments,
    raw: () => text,
    untilFrames: (count, timeoutMs = 5000) =>
      waitFor(() => frames.length >= count, timeoutMs, `${count} frames`),
    untilClosed: (timeoutMs = 5000) => waitFor(() => done, timeoutMs, "the stream to close"),
    settle: async (ms = 120) => {
      await Bun.sleep(ms);
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    closed: () => done,
    abort: () => {
      controller.abort();
      void pump;
    },
  };
}

/**
 * #99 — the reply, as a person reads it, through the real `Chat`.
 *
 * The bug this file exists to keep out was live on the Render URL and invisible
 * to 553 passing tests: the model's reply arrived as `text` events of a few
 * characters each and the chat drew one block per event, so Alice's first turn
 * read "It / looks like the lo / an system / need / s you".
 *
 * **Why every other test missed it.** They all feed `{ kind: "text", text: "a
 * whole sentence" }`. With a fixture coarser than the provider, one block per
 * event and one block per reply are the same picture, and the only test that can
 * tell them apart is one that streams the way the provider does. So this file
 * does: 40 events of three characters each, written as 40 separate chunks, over
 * real HTTP from a real `Bun.serve` on port `:0`, into the real `Chat` mounted
 * in a real DOM. Nothing about the unit under test is stubbed — what is
 * substituted is the base URL in front of `fetch`, because `Chat` asks for the
 * relative `/api/chat` and the test server is not on the document's origin.
 *
 * `happy-dom` earns its place here for the same reason. Every other React test
 * in this service is `renderToStaticMarkup`, which is enough when the claim is
 * about markup; this claim is about what a *stream* does to state over 40
 * updates, and there is no markup-only way to ask it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ChatEvent } from "../lib/agent/events.ts";

// Bun's own, captured before happy-dom replaces the globals with the DOM's
// look-alikes. Two reasons, both measured here: `Chat`'s request goes to a real
// server over real HTTP (only the origin in front of the relative path is
// supplied), and `Bun.serve` rejects a `Response` that is not Bun's — with the
// registrator installed, a bare `new Response(…)` in this file is happy-dom's.
const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTextEncoder = globalThis.TextEncoder;

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register({ url: "http://chat.test/" });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Chat } = await import("../components/chat/Chat.tsx");
const { encodeEvent } = await import("../lib/agent/events.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DANA = "alice@bank.example";

/**
 * The reply the 40 events spell: 120 characters, so every one of the 40 is
 * exactly three. A real sentence rather than 40 copies of "aaa", so a failure
 * prints something a person can read and so the assertion is on the whole reply
 * rather than on a length.
 */
const REPLY =
  "It looks like the loan system needs you to authorize it before I can read LN-2291, " +
  "so I have stopped here for right now.";

/** `text` events of exactly three characters, the way a provider streams. */
function deltas(reply: string, size = 3): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (let at = 0; at < reply.length; at += size) {
    events.push({ kind: "text", text: reply.slice(at, at + size) });
  }
  return events;
}

/**
 * A chat route that answers with exactly these events, one chunk per event.
 *
 * One chunk each on purpose: a single `Response` body with all 40 lines in it
 * would arrive as one `read()` and would not exercise the thing that broke.
 * Port `:0`, read back — this worktree owns a block of ten and a test that
 * guesses one is a test that fails in somebody else's.
 */
function chatRoute(events: readonly ChatEvent[]) {
  return Bun.serve({
    port: 0,
    async fetch() {
      const body = new NativeReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new NativeTextEncoder();
          for (const event of events) {
            controller.enqueue(encoder.encode(encodeEvent(event)));
            // A tick between chunks, so the browser side really does see 40
            // reads rather than one coalesced buffer.
            await Bun.sleep(0);
          }
          controller.close();
        },
      });
      return new NativeResponse(body, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
}

let origin = "";
let server: ReturnType<typeof Bun.serve> | null = null;

function serve(events: readonly ChatEvent[]): void {
  server?.stop(true);
  server = chatRoute(events);
  origin = `http://localhost:${server.port}`;
}

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(new URL(String(input), origin), init)) as typeof fetch;
});

afterAll(async () => {
  server?.stop(true);
  await GlobalRegistrator.unregister();
});

/** Mount the real `Chat`, press Send, and let the stream finish. */
async function turn(events: readonly ChatEvent[]): Promise<HTMLElement> {
  serve(events);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<Chat signedInAs={DANA} />);
  });

  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  // The turn ends when the stream closes and the button goes back to `Send` —
  // one state update later than the `done` event, and waiting for the earlier
  // of the two is how a test ends while the component is still writing to
  // itself. Polled rather than slept on: a fixed sleep is either slow or flaky
  // and eventually both.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const idle = container.querySelector("button")?.textContent === "Send";
    if (idle && container.textContent?.includes("this turn.")) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }

  return container;
}

/** Every paragraph of model prose on screen, in order. */
function replies(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-kind="text"]')].map(
    (node) => node.textContent ?? "",
  );
}

describe("a streamed reply is one message, not one message per chunk", () => {
  test("40 three-character text events render as a single block", async () => {
    const events = deltas(REPLY);
    // The premise of the test, asserted rather than assumed: if a future change
    // to `deltas` made these sentences instead of fragments, the test below
    // would pass for the wrong reason and #99 would come back.
    expect(events).toHaveLength(40);
    expect(new Set(events.map((event) => (event.kind === "text" ? event.text.length : 0)))).toEqual(
      new Set([3]),
    );

    const container = await turn([...events, { kind: "done", calls: 0 }]);

    expect(replies(container)).toEqual([REPLY]);
  });

  test("the block grows as the chunks arrive rather than appearing at the end", async () => {
    // Streaming is the other half of the claim: one block, but not one block
    // that shows up whole when the stream closes. Fed a stream that never
    // closes, the reply so far is already on screen.
    const held = Bun.serve({
      port: 0,
      fetch() {
        const body = new NativeReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new NativeTextEncoder();
            for (const part of ["It ", "loo", "ks ", "lik", "e t", "he "]) {
              controller.enqueue(encoder.encode(encodeEvent({ kind: "text", text: part })));
            }
            // Deliberately never closed: the turn is still in flight.
          },
        });
        return new NativeResponse(body, { headers: { "content-type": "application/x-ndjson" } });
      },
    });
    const previous = origin;
    origin = `http://localhost:${held.port}`;

    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Chat signedInAs={DANA} />);
      });
      await act(async () => {
        container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      for (let attempt = 0; attempt < 400; attempt += 1) {
        // Trimmed, because a paragraph is: `markdown.ts` strips a block's
        // leading and trailing whitespace, so mid-stream the space that has
        // arrived but has nothing after it yet is not on screen.
        if (replies(container).join("") === "It looks like the") break;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }

      expect(replies(container)).toEqual(["It looks like the"]);
      // Still running: the stream has not ended and the chat says so.
      expect(container.textContent).toContain("Running…");

      // Close the connection and let the chat notice, inside `act`. Left
      // running, the turn would go on updating state after the test had ended,
      // which React reports and a reviewer then has to rule out.
      held.stop(true);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        root.unmount();
      });
    } finally {
      origin = previous;
      held.stop(true);
    }
  });

  test("a blank line in the reply is a second paragraph, and only a blank line is", async () => {
    const container = await turn([
      ...deltas("One.\n\nTwo, and\na line break inside it."),
      { kind: "done", calls: 0 },
    ]);

    expect(replies(container)).toEqual(["One.", "Two, and\na line break inside it."]);
  });

  test("prose either side of a tool call stays either side of it", async () => {
    // The reason the fold is over *consecutive* events. Joining every `text`
    // event in the turn would hoist the whole reply above the first tool call
    // and lose the order the demo is about.
    const container = await turn([
      ...deltas("Rea"),
      ...deltas("ding it now."),
      { kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: "LN-2291" } },
      { kind: "tool-result", tool: "Loan_GetLoan" },
      ...deltas("It is for $95,000."),
      { kind: "done", calls: 1 },
    ]);

    expect(replies(container)).toEqual(["Reading it now.", "It is for $95,000."]);
    const markup = container.innerHTML;
    expect(markup.indexOf("Reading it now.")).toBeLessThan(markup.indexOf("Loan_GetLoan"));
    expect(markup.indexOf("Loan_GetLoan")).toBeLessThan(markup.indexOf("It is for $95,000."));
  });
});

describe("markdown in a streamed reply", () => {
  test("a link split across chunks still renders as one link", async () => {
    // The delta boundary lands inside the `[…](…)` constantly, and a renderer
    // that parsed each event on its own would print brackets. It parses the
    // fold, so it does not.
    const container = await turn([
      ...deltas("Open [the authorization page](https://cg-idp.example/oauth2/authorize) and retry."),
      { kind: "done", calls: 0 },
    ]);

    const link = container.querySelector("a[href^='https://cg-idp.example']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("the authorization page");
    expect(replies(container)).toEqual([
      "Open the authorization page and retry.",
    ]);
  });

  test("an HTML payload in the reply is shown as text, never rendered", async () => {
    // The reply is the one surface on this screen a prompt injection gets to
    // write — act 4 is a loan file trying to. Whatever the model emits, no
    // element of its choosing ends up in this document.
    const payload = '<img src=x onerror="alert(1)"> and <b>bold</b> and <script>alert(2)</script>';
    const container = await turn([...deltas(payload), { kind: "done", calls: 0 }]);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(replies(container)).toEqual([payload]);
  });
});

/**
 * #142 — conversation turns, explicit authorization continuation, and persona
 * isolation through the real `Chat` component and real local HTTP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { ChatEvent } from "../lib/agent/events.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register({ url: "http://chat-conversation.test/" });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { Chat } = await import("../components/chat/Chat.tsx");
const { encodeEvent } = await import("../lib/agent/events.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALICE = "alice@bank.example";
const BOB = "bob@bank.example";

interface Harness {
  origin: string;
  posts: Array<Record<string, unknown>>;
  stop: () => void;
}

let harness: Harness | null = null;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(new URL(String(input), harness?.origin ?? "http://localhost:1"), init)) as typeof fetch;
});

afterEach(() => {
  harness?.stop();
  harness = null;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function start(eventsForPost: (body: Record<string, unknown>, postNumber: number) => ChatEvent[]): void {
  const posts: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/chat") return new NativeResponse(null, { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      const events = eventsForPost(body, posts.length);
      const stream = new NativeReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events.map(encodeEvent).join("")));
          controller.close();
        },
      });
      return new NativeResponse(stream, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  harness = { origin: `http://localhost:${server.port}`, posts, stop: () => server.stop(true) };
}

async function mount(signedInAs: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Chat signedInAs={signedInAs} />);
  });
  return { container, root };
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("timed out waiting for the chat turn");
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function cleanup(container: HTMLElement, root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

describe("conversation turns", () => {
  test("appends visible turns and sends completed history on the next request", async () => {
    start((_body, postNumber) => [
      { kind: "text", text: postNumber === 1 ? "The first answer." : "I remember the first answer." },
      { kind: "done", calls: 0 },
    ]);
    const { container, root } = await mount(ALICE);
    try {
      await submit(container);
      await settle(() => harness?.posts.length === 1 && container.querySelector("button")?.textContent === "Send");
      await submit(container);
      await settle(() => harness?.posts.length === 2 && container.querySelector("button")?.textContent === "Send");

      const history = harness?.posts[1]?.history;
      expect(history).toEqual([
        {
          role: "user",
          content: "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
        },
        { role: "assistant", content: "The first answer." },
      ]);
      expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(2);
      expect(container.textContent).toContain("The first answer.");
      expect(container.textContent).toContain("I remember the first answer.");
    } finally {
      await cleanup(container, root);
    }
  });

  test("clears the in-memory transcript and history when the persona changes", async () => {
    start(() => [{ kind: "text", text: "Alice-only reply." }, { kind: "done", calls: 0 }]);
    const { container, root } = await mount(ALICE);
    try {
      await submit(container);
      await settle(() => harness?.posts.length === 1 && container.textContent?.includes("Alice-only reply.") === true);
      await act(async () => {
        root.render(<Chat signedInAs={BOB} />);
      });
      await settle(() => container.textContent?.includes("Alice-only reply.") === false);
      expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(0);
      expect(container.textContent).toContain(BOB);
    } finally {
      await cleanup(container, root);
    }
  });
});

describe("authorization continuation", () => {
  const challenge: ChatEvent = {
    kind: "authorization",
    tool: "Loan_GetLoan",
    url: "https://provider.example/authorize/request-1",
    instructions: "Authorize the provider, then continue.",
  };

  test("hides redundant authorization prose and double-clicking continues exactly once", async () => {
    start(() => [
      challenge,
      { kind: "text", text: "Please authorize at https://provider.example/authorize/request-1 and click the link." },
      { kind: "done", calls: 1 },
    ]);
    const { container, root } = await mount(ALICE);
    try {
      await submit(container);
      await settle(() => container.querySelector('[data-action="continue-authorization"]') !== null);
      expect(container.textContent).not.toContain("Please authorize at");
      expect(container.querySelectorAll('[data-kind="authorization"]')).toHaveLength(1);

      const continueButton = container.querySelector<HTMLButtonElement>(
        '[data-action="continue-authorization"]',
      );
      expect(continueButton).not.toBeNull();
      await act(async () => {
        continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle(() => harness?.posts.length === 2 && container.querySelector("button")?.textContent === "Send");
      expect(harness?.posts).toHaveLength(2);
      // The first challenged turn was not committed as model history, and the
      // retry remains an explicit new request for the same prompt.
      expect(harness?.posts[1]?.history).toBeUndefined();
      expect(container.querySelectorAll('[data-kind="authorization"]')).toHaveLength(2);
    } finally {
      await cleanup(container, root);
    }
  });
});

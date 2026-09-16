/**
 * The browser half of #20: a turn that ends waiting, and the decision that
 * starts the next one.
 *
 * Through the real `Chat`, in a real DOM, against a real `Bun.serve` on port
 * `:0` speaking the two things the component consumes — NDJSON on `/api/chat`
 * and `text/event-stream` on `/events`. Nothing about the unit under test is
 * stubbed; what is substituted is the origin in front of `fetch`, because
 * `Chat` asks for relative paths and the test server is not on the document's.
 *
 * `happy-dom` for the same reason `chat-rendering.test.tsx` uses it: every
 * claim here is about what a *stream* does to state over time, and there is no
 * markup-only way to ask whether a second turn started.
 *
 * The four claims:
 *
 * 1. A turn that ends after `Approvals_RequestApproval` ends, and **nothing is
 *    sent** until a decision arrives. One POST, and it stays one.
 * 2. `approval.granted` for this browser's request starts exactly one more
 *    turn, carrying the id and the previous turn as context — and no outcome.
 * 3. The transcript **continues**. The denial, the escalation and the
 *    "waiting" card are still on screen underneath the resumed turn.
 * 4. A notice that is not this browser's — another request, or another
 *    persona — starts nothing.
 *
 * Plus the reconnect: a notice delivered while the socket was down is picked up
 * from `/api/approvals/{id}/status` when it comes back, because the frame
 * carries no id and takes no part in the replay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { ApprovalNotice } from "@cg/policy-schema";
import type { ChatEvent } from "../lib/agent/events.ts";

// Bun's own, captured before happy-dom replaces the globals. `Bun.serve`
// rejects a `Response` that is not Bun's, and the component's requests go to a
// real server over real HTTP.
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
const MORGAN = "michael@bank.example";
const REQUEST_ID = "apr_0m4xq7bd91kz";

/** The turn that ends waiting: a denial, the escalation, and the reply. */
const BLOCKED: ChatEvent[] = [
  { kind: "tool-call", tool: "Loan_ApproveLoan", inputs: { loan_id: "LN-2291", amount: 95000 } },
  {
    kind: "denied",
    tool: "Loan_ApproveLoan",
    reason:
      "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. " +
      "[ref evt_4k7xq2m9hz]",
    ref: "evt_4k7xq2m9hz",
  },
  { kind: "tool-call", tool: "Approvals_RequestApproval", inputs: { resource_id: "LN-2291" } },
  { kind: "tool-result", tool: "Approvals_RequestApproval" },
  {
    kind: "waiting",
    tool: "Approvals_RequestApproval",
    request_id: REQUEST_ID,
    approver: "Charlie",
    approver_id: "charlie@bank.example",
  },
  { kind: "text", text: "Approval requested from Charlie, VP Credit. Waiting." },
  { kind: "done", calls: 2 },
];

/** The resumed turn, as the server would answer it. */
const RESUME_MESSAGE =
  `Approval request ${REQUEST_ID} — approve_loan on LN-2291 for 95000 — was approved by Charlie at ` +
  "2026-09-14T10:00:00.000Z.";

const RESUMED: ChatEvent[] = [
  {
    kind: "resumed",
    request_id: REQUEST_ID,
    decision: "approved",
    decided_by: "charlie@bank.example",
    message: RESUME_MESSAGE,
  },
  { kind: "tool-call", tool: "Loan_ApproveLoan", inputs: { loan_id: "LN-2291", amount: 95000 } },
  { kind: "tool-result", tool: "Loan_ApproveLoan" },
  { kind: "text", text: "Approved: LN-2291 for $95,000." },
  { kind: "done", calls: 1 },
];

const FOLLOW_UP: ChatEvent[] = [
  { kind: "text", text: "The follow-up finished while approval was being recorded." },
  { kind: "done", calls: 0 },
];

function notice(overrides: Partial<ApprovalNotice> = {}): ApprovalNotice {
  return {
    kind: "approval.granted",
    request_id: REQUEST_ID,
    requester_id: DANA,
    status: "approved",
    action: "approve_loan",
    resource_id: "LN-2291",
    amount: 95_000,
    decided_by: "charlie@bank.example",
    decided_at: "2026-09-14T10:00:00.000Z",
    grants_activated: 1,
    ...overrides,
  } as ApprovalNotice;
}

// ---------------------------------------------------------------------------
// One server: the chat route, the stream, and the catch-up read
// ---------------------------------------------------------------------------

interface Harness {
  origin: string;
  /** Every POST body the chat route received, in order. */
  posts: Array<Record<string, unknown>>;
  /** How many times a client has connected to the stream. */
  connects: number;
  /** Push a frame to every open stream. */
  announce: (value: ApprovalNotice) => void;
  /** Close every open stream, so the client reconnects. */
  drop: () => void;
  /** What `/api/approvals/{id}/status` answers. */
  storedStatus: string;
  /** Hold the first chat response to exercise a decision racing waiting delivery. */
  holdFirst: () => void;
  releaseFirst: () => void;
  /** Hold the second chat response to exercise a decision racing an active turn. */
  holdSecond: () => void;
  releaseSecond: () => void;
  stop: () => void;
}

function startHarness(): Harness {
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const state = {
    posts: [] as Array<Record<string, unknown>>,
    connects: 0,
    storedStatus: "pending",
    holdFirst: false,
    releaseFirst: () => {},
    holdSecond: false,
    releaseSecond: () => {},
  };
  const encoder = new NativeTextEncoder();

  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/chat") {
        const body = (await request.json()) as Record<string, unknown>;
        state.posts.push(body);
        if (state.holdFirst && state.posts.length === 1) {
          await new Promise<void>((resolve) => {
            state.releaseFirst = resolve;
          });
        }
        if (state.holdSecond && state.posts.length === 2) {
          await new Promise<void>((resolve) => {
            state.releaseSecond = resolve;
          });
        }
        const events = "resume" in body ? RESUMED : state.posts.length === 1 ? BLOCKED : FOLLOW_UP;
        return new NativeResponse(events.map(encodeEvent).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      if (url.pathname.startsWith("/api/approvals/")) {
        return NativeResponse.json({ request_id: REQUEST_ID, status: state.storedStatus });
      }

      if (url.pathname === "/events") {
        state.connects += 1;
        const body = new NativeReadableStream<Uint8Array>({
          start(controller) {
            open.add(controller);
            controller.enqueue(encoder.encode(": governance stream\n\n"));
          },
          cancel(this: void) {
            // The client went away; the controller is closed for us.
          },
        });
        return new NativeResponse(body, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }

      return new NativeResponse(null, { status: 404 });
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    get posts() {
      return state.posts;
    },
    get connects() {
      return state.connects;
    },
    get storedStatus() {
      return state.storedStatus;
    },
    set storedStatus(value: string) {
      state.storedStatus = value;
    },
    holdFirst() {
      state.holdFirst = true;
    },
    releaseFirst() {
      state.releaseFirst();
      state.releaseFirst = () => {};
      state.holdFirst = false;
    },
    holdSecond() {
      state.holdSecond = true;
    },
    releaseSecond() {
      state.releaseSecond();
      state.releaseSecond = () => {};
      state.holdSecond = false;
    },
    announce(value) {
      // Exactly the frame `apps/hooks` writes: a named event, no `id:` line.
      const frame = `event: approval\ndata: ${JSON.stringify(value)}\n\n`;
      for (const controller of open) controller.enqueue(encoder.encode(frame));
    },
    drop() {
      for (const controller of open) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      open.clear();
    },
    stop: () => server.stop(true),
  };
}

let harness: Harness;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(new URL(String(input), harness.origin), init)) as typeof fetch;
});

afterAll(async () => {
  harness?.stop();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  harness?.stop();
  harness = startHarness();
});

/** Mounts the real `Chat` with the stream wired up, and presses Send once. */
async function mountAndAsk(signedInAs: string = DANA): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <Chat signedInAs={signedInAs} approvalStreamUrl={`${harness.origin}/events`} />,
    );
  });

  // The subscription opens on mount, before any turn — on stage the gap
  // between the escalation and the click is where the presenter talks.
  await settle();
  expect(harness.connects).toBeGreaterThan(0);

  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();

  return container;
}

/**
 * Lets pending microtasks, fetches and React updates run.
 *
 * `ms` is bumped for the reconnect cases: the subscriber's first backoff is
 * 500 ms (`approval-stream.ts`), so a settle shorter than that would report
 * "it never reconnected" about a client that simply had not got there yet.
 */
async function settle(ticks = 12, ms = 5): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => {
      await Bun.sleep(ms);
    });
  }
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

async function typePrompt(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) throw new Error("chat composer is missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------

describe("a turn that ends waiting", () => {
  test("ends, and nothing is sent until a decision arrives", async () => {
    const container = await mountAndAsk();

    // One POST. No second request, no poll, no timer — the turn is over.
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toEqual({
      prompt: "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
    });

    // And a full second of doing nothing stays nothing.
    await settle(40);
    expect(harness.posts).toHaveLength(1);

    expect(container.querySelector('[data-kind="waiting"]')).not.toBeNull();
    expect(textOf(container)).toContain("Charlie");
    expect(textOf(container)).toContain(REQUEST_ID);
  });
});

describe("approval.granted starts the next turn", () => {
  test("queues a decision delivered before the waiting event is committed", async () => {
    harness.holdFirst();
    const container = await mountAndAsk();

    // The approval tool has returned the request id to the real chat route,
    // but the first response is still streaming and has not committed its
    // waiting card yet.
    expect(harness.posts).toHaveLength(1);
    await act(async () => {
      harness.announce(notice());
    });
    await settle();
    expect(harness.posts).toHaveLength(1);
    expect(container.querySelector('[data-kind="waiting"]')).toBeNull();

    // Once the waiting event arrives, the queued notice starts one resume.
    harness.releaseFirst();
    await settle(30, 5);
    expect(harness.posts).toHaveLength(2);
    expect((harness.posts[1]?.resume as Record<string, unknown>)?.request_id).toBe(REQUEST_ID);
    expect(container.querySelectorAll('[data-kind="resumed"]')).toHaveLength(1);
  });

  test("one resume, carrying the id and the previous turn as context", async () => {
    const container = await mountAndAsk();

    await typePrompt(container, "Keep this draft while Charlie decides.");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft while Charlie decides.",
    );

    await act(async () => {
      harness.announce(notice());
    });
    await settle();

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft while Charlie decides.",
    );

    expect(harness.posts).toHaveLength(2);
    const resume = harness.posts[1]?.resume as Record<string, unknown>;
    expect(resume?.request_id).toBe(REQUEST_ID);
    // Context, and only context: the turn that ended waiting.
    expect(resume?.prompt).toContain("Approve the loan for $95K");
    expect(String(resume?.reply)).toContain("Approval requested from Charlie");
    // Nothing this browser could have made up about the decision itself.
    expect(Object.keys(resume ?? {}).sort()).toEqual(["prompt", "reply", "request_id"]);

    // The next ordinary prompt receives both the server-built decision line
    // and the completed resumed reply, after the waiting turn that preceded it.
    const form = container.querySelector("form");
    await typePrompt(container, "What should I do next?");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(harness.posts).toHaveLength(3);
    expect(harness.posts[2]?.history).toEqual([
      {
        role: "user",
        content: "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
      },
      { role: "assistant", content: "Approval requested from Charlie, VP Credit. Waiting." },
      { role: "user", content: RESUME_MESSAGE },
      { role: "assistant", content: "Approved: LN-2291 for $95,000." },
    ]);
  });

  test("defers a grant during an active turn and coalesces repeat plus catch-up notices", async () => {
    const container = await mountAndAsk();
    harness.holdSecond();

    // Start a normal follow-up and leave its HTTP response in flight.
    await typePrompt(container, "Check the follow-up status.");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle(12, 5);
    expect(harness.posts).toHaveLength(2);

    // The live frame, a duplicate frame, and reconnect catch-up all describe
    // one decision. The waiting card remains truthful until the active stream
    // releases the lock, and no blank resume turn is added.
    await act(async () => {
      harness.announce(notice());
      harness.announce(notice());
    });
    harness.storedStatus = "approved";
    await act(async () => {
      harness.drop();
    });
    await settle(20, 60);
    expect(harness.posts).toHaveLength(2);
    expect(container.querySelector('[data-kind="waiting"]')).not.toBeNull();

    harness.releaseSecond();
    await settle(40, 5);
    expect(harness.posts).toHaveLength(3);
    expect(container.querySelectorAll('[data-kind="resumed"]')).toHaveLength(1);
    expect(container.textContent).toContain("The follow-up finished while approval was being recorded.");

    // A late duplicate after the deferred resume has started is still a no-op.
    await act(async () => {
      harness.announce(notice());
    });
    await settle();
    expect(harness.posts).toHaveLength(3);
  });

  test("clears a queued grant when the persona changes during the active turn", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Chat signedInAs={DANA} approvalStreamUrl={`${harness.origin}/events`} />);
    });
    await settle();
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    harness.holdSecond();
    await typePrompt(container, "Check the follow-up status.");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle(12, 5);
    expect(harness.posts).toHaveLength(2);
    await act(async () => {
      harness.announce(notice());
    });

    // The old stream is aborted and its queued approval must not resume as the
    // newly signed-in persona when the old HTTP response eventually completes.
    await act(async () => {
      root.render(<Chat signedInAs={MORGAN} approvalStreamUrl={`${harness.origin}/events`} />);
    });
    await settle();
    harness.releaseSecond();
    await settle(30, 5);
    expect(harness.posts).toHaveLength(2);
    expect(container.textContent).toContain(MORGAN);
    expect(container.querySelector('[data-kind="resumed"]')).toBeNull();
    expect(container.querySelector('[data-kind="waiting"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("the transcript continues; nothing already on screen is cleared", async () => {
    const container = await mountAndAsk();
    await act(async () => {
      harness.announce(notice());
    });
    await settle();

    const text = textOf(container);
    // What the audience is being shown caused this — still there.
    expect(text).toContain("exceeds your approval authority of 50000");
    expect(container.querySelector('[data-kind="denied"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="waiting"]')).not.toBeNull();
    // And underneath it, the resumed turn.
    expect(container.querySelector('[data-kind="resumed"]')).not.toBeNull();
    expect(text).toContain("Approved: LN-2291 for $95,000.");
  });

  test("a second notice for the same request starts nothing more", async () => {
    await mountAndAsk();
    await act(async () => {
      harness.announce(notice());
    });
    await settle();
    expect(harness.posts).toHaveLength(2);

    // A reconnect racing the live frame, or a server that announced twice.
    await act(async () => {
      harness.announce(notice());
    });
    await settle();
    expect(harness.posts).toHaveLength(2);
  });
});

describe("a notice that is not this browser's starts nothing", () => {
  test("another request id", async () => {
    await mountAndAsk();
    await act(async () => {
      harness.announce(notice({ request_id: "apr_somebodyelses" }));
    });
    await settle();
    expect(harness.posts).toHaveLength(1);
  });

  test("another requester — Michael's tab does not resume Alice's turn", async () => {
    // Signed in as Michael, watching the same stream. The frame names Alice as
    // the requester; without the check the turn would run, as Michael, on
    // Alice's approval.
    await mountAndAsk(MORGAN);
    await act(async () => {
      harness.announce(notice({ requester_id: DANA }));
    });
    await settle();
    expect(harness.posts).toHaveLength(1);
  });
});

describe("a decision made while the socket was down", () => {
  test("catches up when reconnect happens before the waiting event is committed", async () => {
    harness.holdFirst();
    const container = await mountAndAsk();
    expect(harness.posts).toHaveLength(1);

    // Charlie's decision is recorded while the browser is disconnected, and
    // the reconnect lands before the first chat response has committed its
    // waiting event. There is still no request to resume while that turn is
    // active.
    harness.storedStatus = "approved";
    await act(async () => {
      harness.drop();
    });
    await settle(12, 60);
    expect(harness.connects).toBeGreaterThan(1);
    expect(harness.posts).toHaveLength(1);
    expect(container.querySelector('[data-kind="waiting"]')).toBeNull();

    // The catch-up read is deferred until the waiting event supplies the
    // request id, then starts one resume.
    harness.releaseFirst();
    await settle(30, 5);
    expect(harness.posts).toHaveLength(2);
    expect((harness.posts[1]?.resume as Record<string, unknown>)?.request_id).toBe(REQUEST_ID);
  });

  test("is picked up when the stream comes back", async () => {
    await mountAndAsk();
    expect(harness.posts).toHaveLength(1);

    // The decision lands with nobody listening: the frame carries no `id:` and
    // takes no part in the replay, so reconnecting does not deliver it.
    harness.storedStatus = "approved";
    await act(async () => {
      harness.drop();
    });
    await settle(20, 60);

    // The reconnect asked the server what the store says, and resumed on the
    // answer rather than on a frame it never saw.
    expect(harness.connects).toBeGreaterThan(1);
    expect(harness.posts).toHaveLength(2);
    expect((harness.posts[1]?.resume as Record<string, unknown>)?.request_id).toBe(REQUEST_ID);
  });

  test("a request the store still calls pending resumes nothing", async () => {
    await mountAndAsk();
    harness.storedStatus = "pending";
    await act(async () => {
      harness.drop();
    });
    await settle(20, 60);

    expect(harness.connects).toBeGreaterThan(1);
    expect(harness.posts).toHaveLength(1);
  });
});

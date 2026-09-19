/**
 * #123 — what the chat says when the grant Arcade holds has gone stale.
 *
 * The failure it describes is real and measured: reset `apps/idp`, and Arcade
 * goes on presenting the hop-2 token cg-idp has just forgotten. The tool call
 * comes back as a `fault` whose message is `apps/loan-app`'s own sentence, and
 * nothing in it carries an `authorization_url`, an `invalid_token` code or a
 * status — so there is no re-authorization card to render and this suite does
 * not pretend otherwise. What it holds is that the card **says which failure
 * this is and names the one recovery**, rather than the generic "any side
 * effects are unknown" that is true of every fault and useful for none.
 *
 * Driven through the real `Chat` over real HTTP, the way `chat-rendering.test.tsx`
 * does, because the claim is about what a person reads on screen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ChatEvent } from "../lib/agent/events.ts";
import { STALE_GRANT_SIGNATURE } from "../lib/agent/stale-grant.ts";

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
 * Arcade's wrapping of the tool's message, verbatim from #123's report, with
 * `apps/loan-app`'s sentence inside it. Written out rather than built from the
 * constant so the test would still fail if the constant drifted away from what
 * the service actually emits.
 */
const STALE =
  "[TOOL_RUNTIME_FATAL] ToolExecutionError during execution of tool 'get_loan': " +
  "The identity provider rejected the token.";

/** An ordinary plumbing failure, for the contrast. */
const UNREACHABLE = "The loan origination system could not be reached.";

let origin = "";
let server: ReturnType<typeof Bun.serve> | null = null;

function serve(events: readonly ChatEvent[]): void {
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    fetch() {
      const body = new NativeReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new NativeTextEncoder();
          for (const event of events) controller.enqueue(encoder.encode(encodeEvent(event)));
          controller.close();
        },
      });
      return new NativeResponse(body, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
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

  for (let attempt = 0; attempt < 400; attempt += 1) {
    const idle = container.querySelector("button")?.textContent === "Send";
    if (idle && container.querySelector('[data-kind="fault"]') !== null) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }

  return container;
}

function faultCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector<HTMLElement>('[data-kind="fault"]');
  expect(card).not.toBeNull();
  return card!;
}

describe("a stale hop-2 grant is named, with its recovery", () => {
  test("the card says the provider no longer recognises the token Arcade holds", async () => {
    const card = faultCard(
      await turn([
        { kind: "fault", tool: "Loan_GetLoan", message: STALE },
        { kind: "done", calls: 1 },
      ]),
    );
    const text = card.textContent ?? "";

    // The provider's own words are still there, unedited — every other fault
    // card in this UI shows them and this one does not become a summary.
    expect(text).toContain(STALE_GRANT_SIGNATURE);
    expect(card.querySelector('[data-fault-cause="stale-grant"]')).not.toBeNull();
    expect(text).toContain("no longer recognises the token Arcade holds");
    expect(text).toMatch(/identity provider was reset|grant was revoked/);
  });

  test("it names the manual step, and says retrying will not help", async () => {
    const text =
      faultCard(
        await turn([
          { kind: "fault", tool: "Loan_GetLoan", message: STALE },
          { kind: "done", calls: 1 },
        ]),
      ).textContent ?? "";

    // The recovery has to be an instruction someone can follow, not "try
    // again" — Arcade believes the grant is live and will not re-challenge, so
    // a retry is the one thing that reliably does nothing (#123, #75).
    expect(text).toContain("Revoke this persona's cg-idp authorization in the Arcade dashboard");
    expect(text).toContain("retrying");
  });

  test("it states that nothing reached the loan book, because nothing did", async () => {
    const text =
      faultCard(
        await turn([
          { kind: "fault", tool: "Loan_ApproveLoan", message: STALE },
          { kind: "done", calls: 1 },
        ]),
      ).textContent ?? "";

    // True of a write as much as a read: `apps/loan-app` resolves the caller
    // before it touches the book, so a refusal here never got that far. The
    // generic line cannot say this and has to hedge.
    expect(text).toContain("Nothing was read from or written to the loan book");
    expect(text).not.toContain("Any side effects are unknown");
  });

  test("it is still a fault, and never claims a decision was made", async () => {
    const container = await turn([
      { kind: "fault", tool: "Loan_GetLoan", message: STALE },
      { kind: "done", calls: 1 },
    ]);
    const text = faultCard(container).textContent ?? "";

    expect(container.querySelector('[data-kind="denied"]')).toBeNull();
    expect(container.querySelector('[data-kind="authorization"]')).toBeNull();
    expect(text).not.toMatch(/denied|refused by|control plane/i);
    // And no link: there is no authorization URL anywhere in the payload, and
    // a card that produced one would be producing it out of nothing.
    expect(faultCard(container).querySelector("a")).toBeNull();
  });

  test("an ordinary fault keeps the wording that claims nothing", async () => {
    const container = await turn([
      { kind: "fault", tool: "Loan_GetLoan", message: UNREACHABLE },
      { kind: "done", calls: 1 },
    ]);
    const text = faultCard(container).textContent ?? "";

    expect(text).toContain(UNREACHABLE);
    expect(text).toContain("Any side effects are unknown");
    expect(faultCard(container).querySelector('[data-fault-cause="stale-grant"]')).toBeNull();
    expect(text).not.toContain("Arcade dashboard");
  });
});

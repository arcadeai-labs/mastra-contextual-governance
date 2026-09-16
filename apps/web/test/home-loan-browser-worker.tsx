/**
 * #149 — the loan-card authorization continuation in a real browser-shaped
 * DOM. The chat route and refresh callback service are synthetic local HTTP
 * services; the component and state transitions are real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeHeaders = globalThis.Headers;
const NativeReadableStream = globalThis.ReadableStream;

GlobalRegistrator.register({ url: "http://loan-home.test/" });
globalThis.Request = NativeRequest;
globalThis.Response = NativeResponse;
globalThis.Headers = NativeHeaders;
globalThis.ReadableStream = NativeReadableStream;

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { BankPane } = await import("../components/bank/BankPane.tsx");
const { encodeEvent } = await import("../lib/agent/events.ts");
type LoanFilesState = import("../lib/loan-context/loans.ts").LoanFilesState;

const SYNTHETIC_REFRESH_PATH = "/test/loan-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_STATE = {
  status: "loaded" as const,
  body: {
    reads: [
      {
        loan_id: "LN-2291",
        outcome: "authorization" as const,
        url: "https://provider.example/authorize/loan-1",
        instructions: "Authorize the provider, then continue.",
      },
    ],
    actor: "alice@bank.example",
    tool: "Loan_GetLoan",
  },
};

const LOADED_STATE = {
  status: "loaded" as const,
  body: {
    reads: [
      {
        loan_id: "LN-2291",
        outcome: "read" as const,
        loan: { loan_id: "LN-2291", borrower_name: "Northwind Bakery LLC", amount: 95000, status: "pending" },
      },
      {
        loan_id: "LN-2299",
        outcome: "read" as const,
        loan: { loan_id: "LN-2299", borrower_name: "Meridian Physical Therapy", amount: 88000, status: "pending" },
      },
    ],
    actor: "alice@bank.example",
    tool: "Loan_GetLoan",
  },
};

let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
let refreshes = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === SYNTHETIC_REFRESH_PATH && request.method === "POST") {
        refreshes += 1;
        return NativeResponse.json(LOADED_STATE, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        return new NativeResponse(
          encodeEvent({ kind: "text", text: "Chat history survives the loan refresh." }) +
            encodeEvent({ kind: "done", calls: 0 }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      return new NativeResponse(null, { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(new URL(String(input), origin), init)) as typeof fetch;
  window.innerWidth = 1440;
  window.innerHeight = 900;
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  server?.stop(true);
  await GlobalRegistrator.unregister();
});

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("timed out waiting for home loan UI");
}

describe("home loan authorization continuation", () => {
  test("continues one fresh read without remounting or losing chat history", async () => {
    refreshes = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      await act(async () => {
        function BrowserHarness() {
          const [loanFiles, setLoanFiles] = useState<LoanFilesState>(AUTH_STATE);
          const refresh = async () => {
            const response = await fetch(SYNTHETIC_REFRESH_PATH, { method: "POST" });
            setLoanFiles((await response.json()) as typeof LOADED_STATE);
          };
          return (
            <BankPane
              signedInAs="alice@bank.example"
              identity={null}
              loanFiles={loanFiles}
              onContinueAuthorization={refresh}
            />
          );
        }
        root.render(<BrowserHarness />);
      });
      expect(container.querySelector('a[href="https://provider.example/authorize/loan-1"]')).not.toBeNull();
      expect(container.querySelector('[data-action="continue-loan-authorization"]')).not.toBeNull();

      const send = container.querySelector<HTMLButtonElement>('button[type="submit"]');
      await act(async () => send?.click());
      await settle(() => container.textContent?.includes("Chat history survives the loan refresh.") === true);
      const historyBefore = container.querySelectorAll('[data-role="assistant"]').length;

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-action="continue-loan-authorization"]')?.click();
      });
      await settle(() => container.querySelector(".bank-file-borrower")?.textContent === "Northwind Bakery LLC");

      expect(refreshes).toBe(1);
      expect(container.querySelector('[data-action="continue-loan-authorization"]')).toBeNull();
      expect(container.textContent).toContain("Chat history survives the loan refresh.");
      expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(historyBefore);
      expect(container.querySelectorAll(".bank-file")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

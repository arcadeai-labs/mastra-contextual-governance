/**
 * #149's production continuation regression.
 *
 * This boots the actual Next page, seeds its sealed session cookie in a real
 * headless Chrome, and drives the hydrated page through `HomeRefreshBoundary`,
 * `HomeRefreshContext`, and `router.refresh()`. The gateway is the repo's
 * synthetic MCP server backed by the real hooks, loan app, and local IdP; the
 * browser never receives an injected refresh callback.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { chunk, chunkName, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE } from "../lib/identity/session.ts";
import { encodeEvent } from "../lib/agent/events.ts";
import { DANA, SESSION_SECRET, startAgentHarness, type AgentHarness } from "./agent-harness.ts";

const WEB = join(import.meta.dir, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

type CdpListener = (params: Record<string, unknown>) => void;

/** Small Chrome DevTools Protocol client; no browser automation package is needed. */
class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: unknown) => void }>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly socket: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", (event) => reject(event));
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse & { method?: string; params?: Record<string, unknown> };
      if (message.method !== undefined) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
        return;
      }
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("Chrome CDP socket closed"));
      this.pending.clear();
    });
  }

  on(method: string, listener: CdpListener): void {
    const listeners = this.listeners.get(method) ?? new Set<CdpListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.opened;
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return (await response) as T;
  }

  close(): void {
    this.socket.close();
  }
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("OS did not assign a port");
  return port;
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (cause) {
      lastError = cause;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`HTTP ${url}`, async () => {
    try {
      const response = await fetch(url);
      return response.status < 500;
    } catch {
      return false;
    }
  }, timeoutMs);
}

async function stopProcess(child: Subprocess | undefined): Promise<void> {
  if (child === undefined) return;
  child.kill();
  await child.exited.catch(() => undefined);
}

async function browserTarget(debugPort: number): Promise<{ webSocketDebuggerUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl !== undefined);
  if (target?.webSocketDebuggerUrl === undefined) throw new Error("Chrome exposed no page target");
  return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const response = await cdp.command<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(response.exceptionDetails.text ?? "browser evaluation failed");
  }
  return response.result?.value as T;
}

async function clickContinue(cdp: Cdp): Promise<void> {
  await evaluate<boolean>(
    cdp,
    `(() => {
      const button = document.querySelector('[data-action="continue-loan-authorization"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      button.click();
      button.click();
      return true;
    })()`,
  );
}

/**
 * The full browser proof is intentionally local-only. On Linux CI without the
 * developer Chrome binary this remains an explicit skipped measurement, while
 * the normal component and MCP suites still run everywhere.
 */
test.skipIf(!existsSync(CHROME))(
  "guards one real Next refresh, retries a re-challenge, and preserves chat state",
  async () => {
    let harness: AgentHarness | undefined;
    let next: Subprocess | undefined;
    let chrome: Subprocess | undefined;
    let cdp: Cdp | undefined;
    let profile: string | undefined;
    try {
      harness = await startAgentHarness();
      const webPort = freePort();
      const debugPort = freePort();
      const origin = `http://127.0.0.1:${webPort}`;
      const env = {
        ...process.env,
        NODE_ENV: "development",
        PORT: String(webPort),
        PUBLIC_URL: origin,
        ARCADE_API_URL: harness.gateway.url,
        ARCADE_API_KEY: "arcade-key-for-local-next-browser",
        ARCADE_GATEWAY_ID: "cg-demo-us",
        ARCADE_LOAN_TOOLKIT: "Loan",
        ARCADE_APPROVALS_TOOLKIT: "Approvals",
        ANTHROPIC_API_KEY: "not-used-by-local-chat-intercept",
        MODEL_ID: "claude-sonnet-5",
        SESSION_SECRET,
        IDP_ISSUER: harness.config.identity.idpIssuer,
        IDP_CLIENT_ID: "web",
        IDP_CLIENT_SECRET: "not-used-by-local-next-browser",
        APPROVALS_STORE_TOKEN: "store-token-for-agent-tests",
      };

      next = Bun.spawn({
        cmd: ["bun", "run", "next", "dev", "--port", String(webPort)],
        cwd: WEB,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain both streams so a noisy dev server cannot block on a full pipe.
      void new Response(next.stdout as ReadableStream).text();
      void new Response(next.stderr as ReadableStream).text();
      await waitForHttp(`${origin}/`);

      profile = mkdtempSync(join(tmpdir(), "cg-loan-next-chrome-"));
      chrome = Bun.spawn({
        cmd: [
          CHROME,
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${debugPort}`,
          "about:blank",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(chrome.stdout as ReadableStream).text();
      void new Response(chrome.stderr as ReadableStream).text();
      await waitFor(`Chrome DevTools on ${debugPort}`, async () => {
        try {
          return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
        } catch {
          return false;
        }
      }, 30_000);

      const session = {
        email: DANA,
        signed_in_at: Date.now(),
        gateway: {
          access_token: harness.gateway.issueToken(DANA),
          expires_at: Date.now() + 3_600_000,
          client_id: "local-next-browser",
        },
      };
      const sealed = await seal(session, SESSION_SECRET);
      const cookies = chunk(sealed).map((value, index) => ({
        name: chunkName(SESSION_COOKIE, index),
        value,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      }));

      cdp = new Cdp((await browserTarget(debugPort)).webSocketDebuggerUrl);
      await cdp.command("Page.enable");
      await cdp.command("Runtime.enable");
      await cdp.command("Network.enable");
      await cdp.command("Network.setCookies", { cookies });

      // Keep the Chat component on its actual production path without an
      // external model call: only the browser's local /api/chat response is
      // fulfilled by CDP, while React, the route, and all shell components are
      // still the deployed Next code.
      await cdp.command("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      cdp.on("Fetch.requestPaused", (params) => {
        const requestId = String(params.requestId ?? "");
        const request = (params.request ?? {}) as { url?: string };
        if (!request.url?.includes("/api/chat")) {
          void cdp?.command("Fetch.continueRequest", { requestId });
          return;
        }
        const body =
          encodeEvent({ kind: "text", text: "Local chat history survives router refresh." }) +
          encodeEvent({ kind: "done", calls: 0 });
        void cdp?.command("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/x-ndjson" }],
          body: Buffer.from(body).toString("base64"),
        });
      });

      // The first page attempt is challenged and stops before the sibling read.
      harness.gateway.requireAuthorizationFor("Loan_GetLoan", "https://provider.example/authorize/loan-book");
      await cdp.command("Page.navigate", { url: origin });
      await waitFor("initial authorization card", async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('[data-action="continue-loan-authorization"]') !== null`),
      );

      const initialCounts = { lists: harness.lists.length, calls: harness.calls.length };
      expect(initialCounts.lists).toBe(1);
      expect(initialCounts.calls).toBe(1);
      expect(harness.calls[0]?.outcome).toBe("authorization_required");
      const initialState = await evaluate<{ textarea: string; assistants: number }>(
        cdp,
        `(() => {
          const textarea = document.querySelector('textarea[aria-label="Message the assistant"]');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('chat textarea missing');
          textarea.focus();
          return { textarea: textarea.value, assistants: document.querySelectorAll('[data-role="assistant"]').length };
        })()`,
      );
      expect(initialState.textarea).toContain("Approve the loan for $95K");
      await evaluate<void>(
        cdp,
        `(() => {
          const textarea = document.querySelector('textarea[aria-label="Message the assistant"]');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('chat textarea missing');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(textarea, 'REVIEWER-DRAFT-150 must survive real router.refresh');
          textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textarea.value }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          textarea.blur();
          textarea.focus();
        })()`,
      );
      await Bun.sleep(100);
      expect(await evaluate<string>(cdp, `document.querySelector('textarea')?.value ?? ''`)).toContain("REVIEWER-DRAFT-150");

      // The local response creates one completed turn without touching an
      // external model, giving the refresh assertion real chat history.
      await evaluate<void>(cdp, `document.querySelector('button[type="submit"]')?.click()`);
      try {
        await waitFor("completed chat history", async () =>
          evaluate<boolean>(cdp as Cdp, `document.querySelectorAll('[data-role="assistant"]').length === 1`),
        );
      } catch (cause) {
        const state = await evaluate<Record<string, unknown>>(
          cdp,
          `(() => ({
            prompt: document.querySelector('textarea')?.value,
            sendDisabled: document.querySelector('button[type="submit"]')?.hasAttribute('disabled'),
            failures: document.querySelector('[role="alert"]')?.textContent,
            fetchStatus: document.readyState,
          }))()`,
        );
        throw new Error(`${String(cause)}; browser chat state: ${JSON.stringify(state)}`);
      }
      // Sending clears the composer. Put a distinctive unsent draft back after
      // the completed turn so the refresh assertion covers both state shapes.
      await evaluate<void>(
        cdp,
        `(() => {
          const textarea = document.querySelector('textarea[aria-label="Message the assistant"]');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('chat textarea missing');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(textarea, 'REVIEWER-DRAFT-150 must survive real router.refresh');
          textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textarea.value }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
      );
      await Bun.sleep(100);
      expect(await evaluate<string>(cdp, `document.querySelector('textarea')?.value ?? ''`)).toContain("REVIEWER-DRAFT-150");
      await evaluate<void>(cdp, `document.querySelector('textarea')?.setAttribute('data-refresh-node', 'true')`);
      await evaluate<void>(cdp, `document.querySelector('[aria-label="Assistant"]')?.setAttribute('data-chat-node', 'true')`);

      // Hold the synthetic gateway response long enough to observe the actual
      // pending UI. Three rapid DOM clicks must still produce one listing and
      // one challenged call.
      harness.gateway.setToolResponseDelay(900);
      harness.gateway.requireAuthorizationFor("Loan_GetLoan", "https://provider.example/authorize/retry-first");
      await clickContinue(cdp);
      await waitFor("disabled Refreshing feedback", async () =>
        evaluate<boolean>(
          cdp as Cdp,
          `(() => { const b = document.querySelector('[data-action="continue-loan-authorization"]'); return b instanceof HTMLButtonElement && b.disabled && b.textContent?.includes('Refreshing'); })()`,
        ),
      );
      expect(
        await evaluate<boolean>(cdp, `document.querySelector('[data-action="continue-loan-authorization"]') !== null`),
      ).toBe(true);
      try {
        await waitFor("first refresh to settle as a challenge", async () =>
          evaluate<boolean>(
            cdp as Cdp,
            `(() => { const b = document.querySelector('[data-action="continue-loan-authorization"]'); return b instanceof HTMLButtonElement && !b.disabled && b.textContent === 'Continue'; })()`,
          ),
        );
      } catch (cause) {
        const state = await evaluate<Record<string, unknown>>(
          cdp,
          `(() => ({
            button: document.querySelector('[data-action="continue-loan-authorization"]')?.outerHTML,
            cards: document.querySelectorAll('.bank-file').length,
            body: document.querySelector('.bank-panel-body')?.textContent,
          }))()`,
        );
        throw new Error(`${String(cause)}; browser refresh state: ${JSON.stringify(state)}; counts: ${JSON.stringify({ lists: harness.lists.length, calls: harness.calls.length })}`);
      }
      expect(harness.lists.length - initialCounts.lists).toBe(1);
      expect(harness.calls.length - initialCounts.calls).toBe(1);
      expect(harness.calls.at(-1)?.outcome).toBe("authorization_required");
      expect(await evaluate<string>(cdp, `document.querySelector('textarea')?.value ?? ''`)).toContain("REVIEWER-DRAFT-150");
      expect(await evaluate<number>(cdp, `document.querySelectorAll('[data-role="assistant"]').length`)).toBe(1);
      expect(await evaluate<boolean>(cdp, `document.querySelector('textarea')?.dataset.refreshNode === 'true'`)).toBe(true);
      expect(await evaluate<boolean>(cdp, `document.querySelector('[aria-label="Assistant"]')?.dataset.chatNode === 'true'`)).toBe(true);

      // A re-challenge is an explicit retry: it remains paused, and does not
      // auto-loop after the previous server refresh settles.
      harness.gateway.requireAuthorizationFor("Loan_GetLoan", "https://provider.example/authorize/retry");
      await clickContinue(cdp);
      await waitFor("re-challenge pending feedback", async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('[data-action="continue-loan-authorization"]')?.textContent?.includes('Refreshing') === true`),
      );
      await waitFor("re-challenge to settle", async () =>
        evaluate<boolean>(
          cdp as Cdp,
          `(() => { const b = document.querySelector('[data-action="continue-loan-authorization"]'); return b instanceof HTMLButtonElement && !b.disabled && b.textContent === 'Continue'; })()`,
        ),
      );
      expect(harness.lists.length - initialCounts.lists).toBe(2);
      expect(harness.calls.length - initialCounts.calls).toBe(2);
      expect(harness.calls.at(-1)?.outcome).toBe("authorization_required");

      // The successful retry replaces the server-provided loan state with both
      // files, while the stable client shell keeps the conversation and draft.
      await clickContinue(cdp);
      await waitFor("both loan files after successful Continue", async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelectorAll('.bank-file[data-outcome="read"]').length === 2`),
      );
      expect(harness.lists.length - initialCounts.lists).toBe(3);
      expect(harness.calls.length - initialCounts.calls).toBe(4);
      expect(harness.calls.slice(initialCounts.calls).map((call) => call.outcome)).toEqual([
        "authorization_required",
        "authorization_required",
        "ran",
        "ran",
      ]);
      expect(await evaluate<string>(cdp, `document.querySelector('textarea')?.value ?? ''`)).toContain("REVIEWER-DRAFT-150");
      expect(await evaluate<number>(cdp, `document.querySelectorAll('[data-role="assistant"]').length`)).toBe(1);
      expect(await evaluate<boolean>(cdp, `document.querySelector('textarea')?.dataset.refreshNode === 'true'`)).toBe(true);
      expect(await evaluate<boolean>(cdp, `document.querySelector('[aria-label="Assistant"]')?.dataset.chatNode === 'true'`)).toBe(true);
      expect(await evaluate<string[]>(cdp, `Array.from(document.querySelectorAll('.bank-file-borrower')).map((node) => node.textContent)`)).toEqual([
        "Northwind Bakery LLC",
        "Meridian Physical Therapy",
      ]);
      expect(await evaluate<string[]>(cdp, `performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/api/loan-context'))`)).toEqual([]);
    } finally {
      cdp?.close();
      await stopProcess(chrome);
      await stopProcess(next);
      await harness?.stop();
      if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
    }
  },
  240_000,
);

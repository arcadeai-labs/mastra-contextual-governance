/**
 * Driving a headless Chrome over the DevTools Protocol, with no browser
 * automation package in the dependency tree.
 *
 * Lifted out of `home-loan-next-browser.test.ts` on #155 — unchanged, line for
 * line — because a second test needed the same client:
 * `home-full-screen-browser.test.ts` has to watch a served page's **network**
 * and its **viewport** rather than its markup, and neither is a question a
 * `renderToStaticMarkup` can be asked.
 *
 * Where a browser is *found* is `chrome.ts`'s job (#152). This is what to do
 * with one once you have it. The two are deliberately separate files: one
 * answers "is there a browser here, and may we skip if not", the other "how do
 * I click something".
 *
 * Every port is taken from the OS with `:0` and read back. This worktree owns a
 * block of ten and a reviewer's owns a different block, so nothing here may
 * pick a number.
 */
import type { Subprocess } from "bun";

interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

type CdpListener = (params: Record<string, unknown>) => void;

/** Small Chrome DevTools Protocol client; no browser automation package is needed. */
export class Cdp {
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

export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("OS did not assign a port");
  return port;
}

export async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
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

export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`HTTP ${url}`, async () => {
    try {
      const response = await fetch(url);
      return response.status < 500;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function stopProcess(child: Subprocess | undefined): Promise<void> {
  if (child === undefined) return;
  child.kill();
  await child.exited.catch(() => undefined);
}

export async function browserTarget(debugPort: number): Promise<{ webSocketDebuggerUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl !== undefined);
  if (target?.webSocketDebuggerUrl === undefined) throw new Error("Chrome exposed no page target");
  return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

export async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
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

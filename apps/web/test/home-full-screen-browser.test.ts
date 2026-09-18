/**
 * #155's two claims that a render cannot make, measured against the real Next
 * server in a real browser.
 *
 * `test/home-screen.test.tsx` asserts on markup through each component's own
 * props, which is the right shape for everything about *what is drawn*. Two of
 * this slice's acceptance criteria are not about that:
 *
 * 1. **"No `cg-` class in the served HTML."** A component test renders the
 *    components a test file chose. The served page is whatever `app/page.tsx`,
 *    the App Router and the client bundle between them produce, which is a
 *    strictly larger thing — and the criterion is written about the larger
 *    thing on purpose.
 * 2. **"`/` opens no SSE connection to the hooks `GET /events` stream"**, to be
 *    asserted "on the rendered client tree / network in a test, not by reading
 *    the code". So: the network. Every request the page makes is recorded off
 *    `Network.requestWillBeSent` and the governance timeline's is looked for by
 *    address.
 *
 * ## What "no SSE" means here, exactly
 *
 * Two consumers shared the hooks `/events` URL before this slice: the panel's
 * governance-timeline subscription (`lib/governance/subscribe.ts`) and #20's
 * approval-notice listener (`lib/governance/approval-stream.ts`). The panel is
 * gone from `/` and so is the first. The second **stays**, confirmed with the
 * driver on 2026-09-18: it reads `event: approval` and drops every
 * `event: governance` frame by name, and removing it would silently break act
 * 2's second half — Charlie approves, Dana's turn resumes — on the page the
 * demo is actually given on.
 *
 * So the measurement is made twice, and the difference between the two runs is
 * the whole point:
 *
 * - `GOVERNANCE_STREAM` unset → **no** request to the hooks host at all. This
 *   is the "the bank page no longer depends on `panel_stream`" criterion: the
 *   page renders whole with no control plane anywhere.
 * - `GOVERNANCE_STREAM=hooks`, pointed at a stand-in that really holds an SSE
 *   socket open → **one** connection per page load. Counting is the assertion,
 *   and it only means anything against a server that answers: two consumers
 *   are two concurrent `fetch`es, so before this slice the same page load
 *   opened two. One is the approval listener alone.
 *
 *   The stand-in then pushes a real `event: governance` frame with an `id:`,
 *   which is the frame the panel exists to draw. Nothing appears. A consumer
 *   that had quietly survived the refactor would be holding a timeline by now,
 *   and would resume from that `id` on its next connect; neither happens.
 *
 * ## Viewports
 *
 * 1920x1080 and 1440x900, the two the issue names, via
 * `Emulation.setDeviceMetricsOverride` so the measurement does not depend on
 * the window the machine happened to give us.
 *
 * Local-only, like `home-loan-next-browser.test.ts` and for the same reason: on
 * Required wherever a browser can be had, which since #152 includes CI: it
 * resolves one through `chrome.ts`, so a missing browser is a failure there and
 * a skip that says where it looked on a developer machine without one. A
 * measurement that silently does not run is the control-that-matches-nothing
 * this project is organised against.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { chunk, chunkName, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE } from "../lib/identity/session.ts";
import { DANA, SESSION_SECRET, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";

const WEB = join(import.meta.dir, "..");
const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** One connection to the stand-in's `/events`, and what it asked for. */
interface StreamConnection {
  headers: Record<string, string>;
  url: string;
}

interface HooksStandIn {
  /** HOST form, as `HOOKS_PUBLIC_HOST` takes it. */
  host: string;
  connections: StreamConnection[];
  /** Push one frame to every connected browser. */
  push: (event: string, data: unknown, id?: string) => void;
  /** Close every open socket, so every live consumer reconnects. */
  drop: () => void;
  stop: () => void;
}

/**
 * The hook server's `/events`, reduced to the one thing this test needs: a
 * socket that stays open and a record of who opened it.
 *
 * It has to really answer. A refused connection would put both consumers into a
 * reconnect loop and make "how many are there" unanswerable — which is how the
 * first draft of this test measured eight connections and concluded nothing.
 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "accept, cache-control, last-event-id",
  "access-control-expose-headers": "*",
};

function startHooksStandIn(): HooksStandIn {
  const connections: StreamConnection[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/events") return new Response(null, { status: 404 });
      // The page is on a different port, so both consumers' `cache-control`
      // header makes this a preflighted cross-origin request. Answer it, and do
      // not count it: an `OPTIONS` is the browser asking permission, not a
      // consumer opening a stream. `apps/hooks` allows the same.
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      connections.push({
        url: request.url,
        headers: Object.fromEntries(
          [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
        ),
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          open.add(controller);
          controller.enqueue(encoder.encode(": connected\n\n"));
        },
        cancel(this: void) {
          // The browser went away. Controllers are dropped on stop().
        },
      });
      return new Response(stream, {
        headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return {
    host: `127.0.0.1:${server.port}`,
    connections,
    push(event, data, id) {
      const frame =
        (id === undefined ? "" : `id: ${id}\n`) + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const controller of open) {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          open.delete(controller);
        }
      }
    },
    drop() {
      for (const controller of open) {
        try {
          controller.close();
        } catch {
          // already gone
        }
      }
      open.clear();
    },
    stop() {
      this.drop();
      server.stop(true);
    },
  };
}

interface Measured {
  /** Every request the page made, in order. */
  requests: Seen[];
  /** `document.documentElement.outerHTML` after the client tree has hydrated. */
  html: string;
  /** What `1920x1080` and `1440x900` each gave the bank's root element. */
  viewports: Array<{ width: number; height: number; bank: { width: number; height: number } }>;
  /** The two columns and the composer, per viewport, so the 2/3 split is a number. */
  columns: Array<{
    width: number;
    records: number;
    assistant: number;
    composer: number;
  }>;
}

/** Boot Next and Chrome, load `/` as Dana, and report what happened. */
async function measureHome(options: {
  governanceStream: string | null;
  hooksHost?: string;
  /** Run once per page load, after the client tree has settled. */
  afterLoad?: (cdp: Cdp) => Promise<void>;
}): Promise<Measured> {
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
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NODE_ENV: "development",
      PORT: String(webPort),
      PUBLIC_URL: origin,
      ARCADE_API_URL: harness.gateway.url,
      ARCADE_API_KEY: "arcade-key-for-full-screen-browser",
      ARCADE_GATEWAY_ID: "cg-demo-us",
      ARCADE_LOAN_TOOLKIT: "Loan",
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      ANTHROPIC_API_KEY: "not-used-by-this-test",
      MODEL_ID: "claude-sonnet-5",
      SESSION_SECRET,
      IDP_ISSUER: harness.config.identity.idpIssuer,
      IDP_CLIENT_ID: "web",
      IDP_CLIENT_SECRET: "not-used-by-this-test",
      APPROVALS_STORE_TOKEN: "store-token-for-agent-tests",
    };
    if (options.hooksHost !== undefined) env["HOOKS_PUBLIC_HOST"] = options.hooksHost;
    else delete env["HOOKS_PUBLIC_HOST"];
    if (options.governanceStream === null) delete env["GOVERNANCE_STREAM"];
    else env["GOVERNANCE_STREAM"] = options.governanceStream;

    next = Bun.spawn({
      cmd: ["bun", "run", "next", "dev", "--port", String(webPort)],
      cwd: WEB,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    void new Response(next.stdout as ReadableStream).text();
    void new Response(next.stderr as ReadableStream).text();
    await waitForHttp(`${origin}/`);

    profile = mkdtempSync(join(tmpdir(), "cg-full-screen-chrome-"));
    chrome = Bun.spawn({
      cmd: [
        chromeResolution.path as string,
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
        client_id: "full-screen-browser",
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

    const requests: Seen[] = [];
    cdp.on("Network.requestWillBeSent", (params) => {
      const request = (params.request ?? {}) as { url?: string; headers?: Record<string, string> };
      if (request.url !== undefined) requests.push({ url: request.url, headers: request.headers ?? {} });
    });

    const viewports: Measured["viewports"] = [];
    const columns: Measured["columns"] = [];
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
    ] as const) {
      await cdp.command("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.command("Page.navigate", { url: origin });
      await waitFor(`the bank at ${width}x${height}`, async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('.bank') !== null`),
      );
      // Hydration, so the recorded network covers the client tree's effects and
      // not only the server's HTML. Through `BankPane`'s own `data-hydrated`
      // marker (#152, moved here by #155), not through the presence of the
      // composer: the composer is server-rendered and says nothing about React.
      await waitFor(`hydration at ${width}x${height}`, async () =>
        evaluate<boolean>(
          cdp as Cdp,
          `document.querySelector('.bank[data-hydrated="true"]') !== null`,
        ),
      );
      await Bun.sleep(1_500);
      await options.afterLoad?.(cdp);
      viewports.push({
        width,
        height,
        bank: await evaluate<{ width: number; height: number }>(
          cdp,
          `(() => { const r = document.querySelector('.bank').getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()`,
        ),
      });
      columns.push({
        width,
        ...(await evaluate<{ records: number; assistant: number; composer: number }>(
          cdp,
          `(() => {
            const at = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().width);
            return {
              records: at('.bank-column-records'),
              assistant: at('.bank-column-assistant'),
              composer: at('textarea[aria-label="Message the assistant"]'),
            };
          })()`,
        )),
      });
    }

    const html = await evaluate<string>(cdp, `document.documentElement.outerHTML`);
    return { requests, html, viewports, columns };
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(next);
    await harness?.stop();
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  }
}

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "with no control plane configured, / is whole and touches the hook server not at all",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const measured = await measureHome({ governanceStream: null });

    // The bank fills both viewports the issue names. `dvh` in a headless Chrome
    // with no browser chrome is the full height, so this is exact rather than
    // approximate.
    expect(measured.viewports).toEqual([
      { width: 1920, height: 1080, bank: { width: 1920, height: 1080 } },
      { width: 1440, height: 900, bank: { width: 1440, height: 900 } },
    ]);

    // No control-plane column. The panel's whole namespace, absent from the
    // served document — server HTML and hydrated client tree together.
    expect(measured.html).not.toMatch(/class="[^"]*\bcg-[a-z]/);
    expect(measured.html).toContain("Loan Origination System");
    expect(measured.html).toContain("Signed in as");
    expect(measured.html).toContain(DANA);

    // Two columns, and the conversation is not 1920px wide.
    expect(measured.html).toContain("bank-column-records");
    expect(measured.html).toContain("bank-column-assistant");

    // **Two thirds to the conversation**, the human's call at the 2026-09-18
    // gate. A ratio rather than two pixel counts, because the counts depend on
    // padding and the gap and would have to be rewritten whenever either moved;
    // what was decided is the proportion.
    for (const column of measured.columns) {
      const share = column.assistant / (column.records + column.assistant);
      expect({ width: column.width, twoThirds: Math.abs(share - 2 / 3) < 0.01 }).toEqual({
        width: column.width,
        twoThirds: true,
      });
      // And still a readable measure: the thing the gate asked for alongside the
      // ratio was "no 1900px textarea".
      expect({ width: column.width, composer: column.composer < 1_400 }).toEqual({
        width: column.width,
        composer: true,
      });
    }

    // And no SSE at all was opened: with nothing to watch, this page opens
    // nothing, which is what "no longer depends on `panel_stream`" means.
    expect(measured.requests.filter((request) => request.url.includes("/events"))).toEqual([]);
    expect(
      measured.requests.filter((request) => request.url.includes("/api/governance/fixture-stream")),
    ).toEqual([]);
  },
  240_000,
);

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "with a live control plane, / opens the approval listener and no timeline subscription",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const hooks = startHooksStandIn();
    try {
      const measured = await measureHome({
        governanceStream: "hooks",
        hooksHost: hooks.host,
        // One real governance frame, of the kind the panel's three lanes are
        // built to draw, delivered to whatever is listening on this page.
        afterLoad: async () => {
          hooks.push(
            "governance",
            {
              id: "evt_fullscreen0",
              kind: "pre",
              tool: "Loan_ApproveLoan",
              user_id: DANA,
              decision: "denied",
              at: new Date().toISOString(),
            },
            "evt_fullscreen0",
          );
          await Bun.sleep(400);
          // Now cut every socket. Whatever is listening reconnects, and what it
          // asks for on the way back in is the measurement.
          hooks.drop();
          await Bun.sleep(1_200);
        },
      });

      // Something is listening — otherwise every assertion below would pass on
      // a page that opened nothing, which is the shape of a test that proves
      // its own subject away. #20's listener is supposed to be here.
      expect(hooks.connections.length).toBeGreaterThanOrEqual(measured.viewports.length);

      for (const connection of hooks.connections) {
        // **The assertion this test exists for.** `subscribe.ts` records the id
        // of every frame it sees — "even for a frame we cannot use" — and sends
        // it as `Last-Event-ID` on the next connect. `approval-stream.ts` never
        // sends one, and says why: an approval notice carries no id and has no
        // place in the replay.
        //
        // So: a governance row with an `id:` went down the socket, the socket
        // was cut, and every reconnect asked for the stream from the top. There
        // is no timeline consumer on this page.
        //
        // Counting connections would not do instead. Next runs the App Router
        // under React strict mode in development, which invokes an effect
        // twice, so "one subscription" is not "one `fetch`".
        expect(connection.headers["last-event-id"]).toBeUndefined();
        // Nor the panel's fixture-replay parameters.
        expect(connection.url).not.toContain("repeat=");
        expect(connection.url).not.toContain("fanout=");
        expect(connection.headers["accept"]).toContain("text/event-stream");
      }

      // The reconnect really happened, so the header check above ran against
      // connections made *after* the id'd frame rather than only against first
      // connections, which carry no header either way.
      expect(hooks.connections.length).toBeGreaterThan(measured.viewports.length);

      // The replay is the panel's other stream, and this page has neither.
      expect(
        measured.requests.filter((request) => request.url.includes("/api/governance/fixture-stream")),
      ).toEqual([]);

      // Nothing was drawn from the governance frame, and no panel chrome exists
      // for it to have been drawn into — which is where a leftover subscription
      // would have been easiest to miss.
      expect(measured.html).not.toMatch(/class="[^"]*\bcg-[a-z]/);
      expect(measured.html).not.toContain("evt_fullscreen0");
      expect(measured.html).not.toContain("FIXTURE REPLAY");
      expect(measured.html).not.toContain("LIVE ·");

      // Still whole, with a control plane configured.
      expect(measured.html).toContain("Loan Origination System");
      expect(measured.viewports).toEqual([
        { width: 1920, height: 1080, bank: { width: 1920, height: 1080 } },
        { width: 1440, height: 900, bank: { width: 1440, height: 900 } },
      ]);
    } finally {
      hooks.stop();
    }
  },
  240_000,
);

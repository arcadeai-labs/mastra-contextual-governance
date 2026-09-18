/**
 * #152's hydration regression, on the page as it is actually served.
 *
 * This boots the actual Next page, seeds its sealed session cookie in a real
 * headless Chrome, waits for React to take ownership of the controls, and then
 * drives the chat composer the way a person does. The gateway is the repo's
 * synthetic MCP server backed by the real hooks, loan app and local IdP; the
 * loan cards are the real `GET /api/loans` against the real loan book.
 *
 * ## What this file used to be, and what #157 took out of it
 *
 * It was #149's *continuation* regression: the loan cards were governed
 * `Loan_GetLoan` reads, a layer-2 challenge put a `Continue` button on a card,
 * and the test clicked it to drive `HomeRefreshBoundary` and `router.refresh()`
 * through a re-challenge and a success. #157 moved the cards off the MCP path —
 * they read the bank's own API as the signed-in person and poll — so there is
 * no challenge, no Continue button and no refresh boundary left to drive. That
 * half is deleted because the UI it exercised does not exist, and
 * `test/loan-board-browser.test.ts` covers what replaced it: a decision made by
 * somebody else reaching this screen inside one poll interval.
 *
 * **The rest of the file stays, and it is the half that matters on CI.** #152's
 * subject was never the loan card; it was the window between a page being
 * *rendered* and being *hydrated*, in which a click escapes React and the
 * composer's form submits natively as `GET /?`, replacing the document and
 * taking the turn with it. That race is a property of the chat and of Next, not
 * of how the loan cards are read, and `.github/workflows/ci.yml` installs
 * Chrome specifically so this runs on every merge. Deleting it along with the
 * Continue button would have dropped the regression #152 was opened to hold.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { chunk, chunkName, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE } from "../lib/identity/session.ts";
import { encodeEvent } from "../lib/agent/events.ts";
import { DANA, DEV_IDP_TOKEN_PREFIX, SESSION_SECRET, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
// The CDP client moved to `cdp.ts` on #155 so `home-full-screen-browser.test.ts`
// could drive the same browser. Lifted unchanged; nothing about it is new.
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";

const WEB = join(import.meta.dir, "..");
const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
// A skip that says nothing is the failure mode #152 was opened about. If this
// machine has no browser and is allowed to skip, it prints where it looked.
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

/**
 * The laptop the demo is given on (#152). Set through CDP rather than inferred
 * from the headless default, and read back below, so the evidence this test
 * produces is the evidence a reviewer captured by hand on #150.
 */
const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Optional, and 0 by default: hold `/_next/static/chunks/*` back by this many
 * milliseconds so hydration lands well after the server-rendered HTML.
 *
 * This is the knob that makes #152's fix falsifiable. The flake it diagnoses is
 * a race — the test drives a page that has been *rendered* but not yet
 * *hydrated* — and a race that reproduces on a loaded CI runner two times in
 * six will not reproduce on an idle laptop however many times it is run. With
 * `CG_HYDRATION_DELAY_MS=4000` the race becomes certain: without the hydration
 * gate below, the submit click escapes React and the browser natively submits
 * the composer's form as `GET /?`, replacing the document and taking the turn
 * with it. With the gate, the same delay passes.
 */
const HYDRATION_DELAY_MS = Number(process.env.CG_HYDRATION_DELAY_MS ?? "0");

/**
 * Has React taken ownership of the controls this test drives?
 *
 * ## Why this exists (#152)
 *
 * Everything this test clicks and types into is in the server-rendered HTML
 * before any JavaScript runs: the page is a server component, and the
 * authorization card the test waits for is rendered by the *server* when the
 * gateway challenges `Loan_GetLoan`. So `waitFor("initial authorization card")`
 * proves the HTML arrived and proves nothing about React.
 *
 * Measured, on a passing run, at the moment the old test clicked Send — with a
 * throwaway probe into React's internals, used to *find* the bug and
 * deliberately not kept to gate on:
 *
 *     {"docKeys":["__reactContainer$…"],"bodyKeys":[],"announcer":false,
 *      "formHydrated":false,"textareaHydrated":false}
 *
 * `__reactContainer$` on `document` but no fiber on any node: `hydrateRoot()`
 * had been *called* — so React's root listener was installed — but hydration
 * had not committed. The click therefore worked only because React captures
 * discrete events on the root container before hydration and replays them
 * afterwards. That replay is the entire reason the test usually passed.
 *
 * The flake is the window *before* `hydrateRoot()`. There is no root listener
 * then, so the click reaches the browser instead, and `<form onSubmit={send}>`
 * — whose `preventDefault` lives in React — submits natively. Holding the
 * client chunks back makes that certain; the failure state is exact:
 *
 *     {"prompt":"Approve the loan for $95K and double-check your work…",
 *      "documentReplaced":true,"screenHydrated":true,
 *      "navigationEntries":["http://127.0.0.1:51472/?"]}
 *
 * The document marker set immediately before the click is gone while the window
 * name survives, and the navigation entry ends in `?` — a GET submission of a
 * form with no `action` and no named fields. The page reloaded, so the composer
 * holds the default prompt again and no turn ever ran. That is precisely the
 * state PR154's reviewer reported.
 *
 * ## What is checked
 *
 * Not a timeout, and not a weaker assertion: the precondition itself, through
 * the screen's own `data-hydrated` attribute. A parent's mount effect runs
 * after its children have committed, so the container saying it is hydrated
 * means the composer and the loan cards under it are hydrated too, with their
 * handlers attached.
 *
 * It was `.cg-split`, set by `components/shell/SplitScreen.tsx`. #155 deleted
 * that shell along with the split view, and the marker moved to the container
 * that inherited the job: `.bank`, set by `components/bank/BankPane.tsx`, now
 * the outermost element on `/`. The property being proved is unchanged, and
 * `test/home-screen.test.tsx` still holds the other half of it — that the
 * server never emits the attribute itself.
 *
 * The third control checked here was `[data-action="continue-loan-authorization"]`
 * until #157 retired it. A loan card stands in its place: it is rendered by
 * `LoanFilesView`, which is the client component that owns the polling, so its
 * presence under a hydrated `.bank` says the same thing the button did — the
 * subtree this test drives is live — and says one thing more, that the new read
 * path works in a real browser against the real loan book.
 *
 * Round 1 of this review rejected an earlier version that read React's private
 * `__reactProps$…` properties off the DOM nodes, and was right to: those are
 * React's internal bookkeeping, renamed or removed at React's discretion, and a
 * readiness proof resting on them is one minor upgrade from silently passing
 * without checking anything. The attribute is a contract this repo owns.
 *
 * The three controls this test drives are checked for existence in the same
 * pass, so the gate fails loudly rather than waiting out its budget if the
 * shell is ever hydrated without them.
 */
async function waitForHydration(cdp: Cdp): Promise<void> {
  await waitFor(
    "the screen to report itself hydrated, with the composer and the authorization card present",
    async () =>
      evaluate<boolean>(
        cdp,
        `(() => {
          if (document.querySelector('.bank[data-hydrated="true"]') === null) return false;
          return document.querySelector('textarea[aria-label="Message the assistant"]') !== null
            && document.querySelector('form.chat-composer') !== null
            && document.querySelector('.bank-file[data-loan="LN-2291"]') !== null;
        })()`,
      ),
  );
}

/**
 * This is a required measurement wherever a browser can be had, which since
 * #152 includes CI: `.github/workflows/ci.yml` installs Chrome in the `check`
 * job and `browserRequired()` turns a miss there into a failure. It skips only
 * on a developer machine with no browser at all, and says so when it does.
 */
test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "hydrates before the composer is driven, so a turn is never lost to a native form submit",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const CHROME = chromeResolution.path;
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
        // Since #157 the loan cards read the bank's own API rather than the
        // gateway, so this page needs the loan book's address. It is the
        // harness's real `apps/loan-app`, which validates the bearer below
        // against the harness's real dev IdP.
        LOAN_APP_PUBLIC_HOST: harness.loanAppHost,
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
          // The laptop this demo is given on. Asserted below rather than
          // assumed: headless Chrome's own default is 800x600, and #150's
          // reviewer had to capture the 1440x900 evidence by hand because this
          // test never said what size the screen was.
          `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
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
        // The IdP bearer the loan cards are read with (#157). The harness's
        // identity provider is the repo's dev stub, which answers
        // `/oauth2/userinfo` for `dev:<email>` — the real code path in
        // `apps/loan-app/src/actor.ts`, with a fixture issuer behind it.
        idp: {
          access_token: `${DEV_IDP_TOKEN_PREFIX}${DANA}`,
          expires_at: Date.now() + 3_600_000,
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
      // `--window-size` sizes the window; this sizes the *page*, and does it
      // identically on macOS and on a Linux runner with no window manager.
      await cdp.command("Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
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
          if (HYDRATION_DELAY_MS > 0 && request.url?.includes("/_next/static/chunks/")) {
            void Bun.sleep(HYDRATION_DELAY_MS).then(() =>
              cdp?.command("Fetch.continueRequest", { requestId }).catch(() => undefined),
            );
            return;
          }
          void cdp?.command("Fetch.continueRequest", { requestId }).catch(() => undefined);
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

      await cdp.command("Page.navigate", { url: origin });
      await waitFor("the server-rendered loan card", async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('.bank-file[data-loan="LN-2291"]') !== null`),
      );
      // That card is server-rendered — `app/page.tsx` reads the loan book
      // before it returns — so it says nothing about React. Every interaction
      // below needs React's handlers to exist, so wait for the handlers.
      await waitForHydration(cdp);
      // The screen this evidence was measured on, read back from the page
      // rather than assumed from the launch flag.
      expect(await evaluate<{ width: number; height: number }>(cdp, `({ width: window.innerWidth, height: window.innerHeight })`)).toEqual(
        { width: VIEWPORT.width, height: VIEWPORT.height },
      );

      // #157, from the browser rather than from a unit: one `tools/list` for
      // act 1's widget and **no** governed tool call, because nothing this page
      // draws goes through the gateway any more.
      const initialCounts = { lists: harness.lists.length, calls: harness.calls.length };
      expect(initialCounts.lists).toBe(1);
      expect(initialCounts.calls).toBe(0);
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

      // Stamp the document immediately before submitting. `window.name`
      // survives a same-origin navigation and a `documentElement` dataset entry
      // does not, so if this turn ever goes missing again the diagnostic below
      // can say whether the page was replaced underneath it — which is exactly
      // how #152's flake was identified.
      await evaluate<void>(
        cdp,
        `(() => {
          window.name = 'cg-window-marker';
          document.documentElement.dataset.cgDocMarker = 'pre-submit';
        })()`,
      );
      // The local response creates one completed turn without touching an
      // external model, giving the refresh assertion real chat history.
      // Scoped to the Assistant, not the first submit button on the page. Since
      // #155 gave `/` two columns the sign-in panel's "Sign out" precedes Send
      // in document order, and a bare selector signed the browser out instead
      // of sending — which then looked exactly like a chat that never answered.
      await evaluate<void>(
        cdp,
        `document.querySelector('[aria-label="Assistant"] button[type="submit"]')?.click()`,
      );
      try {
        await waitFor("completed chat history", async () =>
          evaluate<boolean>(cdp as Cdp, `document.querySelectorAll('[data-role="assistant"]').length === 1`),
        );
      } catch (cause) {
        const state = await evaluate<Record<string, unknown>>(
          cdp,
          `(() => {
            return {
              prompt: document.querySelector('textarea')?.value,
              sendDisabled: document.querySelector('[aria-label="Assistant"] button[type="submit"]')?.hasAttribute('disabled'),
              failures: document.querySelector('[role="alert"]')?.textContent,
              fetchStatus: document.readyState,
              // Marker gone while the window name survives means the document
              // was replaced: the composer's form submitted natively, so React
              // was not holding it when the click landed.
              documentReplaced: document.documentElement.dataset.cgDocMarker === undefined && window.name === 'cg-window-marker',
              navigationEntries: performance.getEntriesByType('navigation').map((entry) => entry.name),
              screenHydrated: document.querySelector('.bank[data-hydrated="true"]') !== null,
            };
          })()`,
        );
        throw new Error(`${String(cause)}; browser chat state: ${JSON.stringify(state)}`);
      }
      // The turn completed, so the composer is empty again — and the page was
      // never replaced. Both halves of #152's failure state, asserted rather
      // than inferred from the turn having worked: the pre-submit marker is
      // still on the document, and no navigation entry was added.
      expect(
        await evaluate<{ marker: string | undefined; entries: string[] }>(
          cdp,
          `({
             marker: document.documentElement.dataset.cgDocMarker,
             entries: performance.getEntriesByType('navigation').map((entry) => entry.name),
           })`,
        ),
      ).toEqual({ marker: "pre-submit", entries: [`${origin}/`] });

      // And the loan cards are what #157 replaced the governed reads with: two
      // applications, read from the bank's own API as this browser's person,
      // with no governed tool call behind them. The counts are the gateway
      // stand-in's own record.
      expect(
        await evaluate<string[]>(
          cdp,
          `Array.from(document.querySelectorAll('.bank-file-borrower')).map((node) => node.textContent)`,
        ),
      ).toEqual(["Northwind Bakery LLC", "Meridian Physical Therapy"]);
      expect(harness.lists.length - initialCounts.lists).toBe(0);
      expect(harness.calls.length - initialCounts.calls).toBe(0);
      // The route the cards actually poll, named. `/api/loan-context` was
      // #109's browser fetch and has been gone since; `/api/loans` is what
      // replaced the governed read on #157, and a page that had quietly stopped
      // polling would still pass every assertion above.
      const fetched = await evaluate<string[]>(
        cdp,
        `performance.getEntriesByType('resource').map((entry) => entry.name)`,
      );
      expect(fetched.filter((name) => name.includes("/api/loan-context"))).toEqual([]);
      expect(fetched.some((name) => name.includes("/api/loans"))).toBe(true);
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

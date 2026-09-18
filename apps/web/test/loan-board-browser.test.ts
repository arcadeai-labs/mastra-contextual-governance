/**
 * The beat the 2026-09-18 rehearsal found missing, in a real browser.
 *
 * Somebody else approves a loan, and the screen the room is looking at changes
 * on its own. That is the whole of #157 from an audience's point of view, and
 * it is not a claim a render test can make: it needs a real Next server, a real
 * poll over a real socket, and a real decision written to a real `loans.db` by
 * a different person on a different connection.
 *
 * So: `apps/idp` and `apps/loan-app` are real subprocesses, `next dev` serves
 * the actual pages, headless Chrome holds the sealed session a real sign-in
 * produced, and the approval is a `POST /loans/:id/approve` made with Charlie's
 * own IdP bearer — the same call the approval page makes. Nothing is mocked and
 * nothing is injected into the page.
 *
 * **Without reload** is asserted rather than assumed: the test writes a marker
 * onto `document.documentElement` before the approval and requires it to still
 * be there afterwards. A navigation, a `router.refresh()` or a full remount
 * would take it with them.
 *
 * The rig is the repo's, not this file's: `test/cdp.ts` drives the browser and
 * `test/chrome.ts` finds one. Since #152 a missing browser is a **failure** on
 * CI rather than a silent skip, and `.github/workflows/ci.yml` installs Chrome,
 * so this runs on every merge alongside the hydration regression. It skips only
 * on a developer machine with no browser at all, and says where it looked when
 * it does.
 */
import { spawn, type Subprocess } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";
import { chunk, chunkName, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { LOAN_POLL_INTERVAL_MS } from "../lib/loan-context/loans.ts";
import { SESSION_COOKIE, type Session } from "../lib/identity/session.ts";
import { Browser, PEOPLE, SESSION_SECRET, signInAs, startIdentityHarness, type IdentityHarness } from "./identity-harness.ts";
import { readPort } from "./harness.ts";

const WEB = join(import.meta.dir, "..");
const REPO_ROOT = join(WEB, "..", "..");

/** Alice's card beside the chat, and Charlie's decision on the control application. */
const ON_THE_CARDS = "LN-2299";
/** The $95,000 application, decided while the board is on screen. */
const ON_THE_BOARD = "LN-2291";

/**
 * How long a decision may take to appear.
 *
 * One poll interval plus room for a round trip and a React commit. Written off
 * the constant rather than as a number, so a poll somebody quietly doubles
 * fails here instead of being absorbed.
 */
const WITHIN_ONE_POLL_MS = LOAN_POLL_INTERVAL_MS + 4_000;

const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
// A skip that says nothing is the failure mode #152 was opened about.
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "an approval by somebody else reaches the card and the board without a reload",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const CHROME = chromeResolution.path;
    let identity: IdentityHarness | undefined;
    let loanApp: Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let next: Subprocess | undefined;
    let chrome: Subprocess | undefined;
    let cdp: Cdp | undefined;
    let profile: string | undefined;
    let workspace: string | undefined;
    try {
      identity = await startIdentityHarness();
      workspace = join(tmpdir(), `cg-loan-board-${crypto.randomUUID()}`);
      mkdirSync(workspace, { recursive: true });

      loanApp = spawn({
        cmd: ["bun", join(REPO_ROOT, "apps", "loan-app", "src", "index.ts")],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: "0",
          LOANS_DB_PATH: join(workspace, "loans.db"),
          IDP_PUBLIC_HOST: new URL(identity.idpUrl).host,
          NODE_ENV: "test",
        },
        stdout: "pipe",
        stderr: "pipe",
      }) as Subprocess<"ignore", "pipe", "pipe">;
      const { port: loanPort } = await readPort(loanApp);
      const loanAppHost = `localhost:${loanPort}`;

      const webPort = freePort();
      const debugPort = freePort();
      const origin = `http://127.0.0.1:${webPort}`;

      next = spawn({
        cmd: ["bun", "run", "next", "dev", "--port", String(webPort)],
        cwd: WEB,
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: String(webPort),
          PUBLIC_URL: origin,
          SESSION_SECRET,
          IDP_ISSUER: identity.idpUrl,
          IDP_CLIENT_ID: identity.config.identity.idpClientId,
          IDP_CLIENT_SECRET: identity.config.identity.idpClientSecret,
          LOAN_APP_PUBLIC_HOST: loanAppHost,
          // So the decision line can name the person rather than the address.
          PERSONA_LOAN_OFFICER_EMAIL: PEOPLE.dana.email,
          PERSONA_CREDIT_ANALYST_EMAIL: PEOPLE.sam.email,
          PERSONA_VP_CREDIT_EMAIL: PEOPLE.riley.email,
          PERSONA_CHIEF_CREDIT_OFFICER_EMAIL: PEOPLE.morgan.email,
          // The gateway is not configured on purpose: nothing about the loan
          // cards depends on hop 1 since #157, and a page that still needed it
          // would fail here rather than quietly keep working.
          ANTHROPIC_API_KEY: "not-used-by-this-suite",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(next.stdout as ReadableStream).text();
      void new Response(next.stderr as ReadableStream).text();
      await waitForHttp(`${origin}/`);

      profile = mkdtempSync(join(tmpdir(), "cg-loan-board-chrome-"));
      chrome = spawn({
        cmd: [
          CHROME,
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          // 1920x1080: the board is sized for a projector and this is the
          // measurement the PR screenshot is taken at.
          "--window-size=1920,1080",
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${debugPort}`,
          "about:blank",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(chrome.stdout as ReadableStream).text();
      void new Response(chrome.stderr as ReadableStream).text();
      await waitFor(
        `Chrome DevTools on ${debugPort}`,
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
          } catch {
            return false;
          }
        },
        30_000,
      );

      // Alice's browser, holding the cookie a real sign-in produced — a real
      // authorization-code flow against the real `apps/idp`, with a real
      // password, through the real handlers.
      const alice = await sessionFor(identity, "dana");
      const cookies = chunk(await seal(alice, SESSION_SECRET)).map((value, index) => ({
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

      // Charlie's bearer, from Charlie's own sign-in. The approval below is
      // made as him and `apps/loan-app` derives the actor from this token.
      const charlie = await sessionFor(identity, "riley");
      const charlieBearer = charlie.idp?.access_token;
      if (charlieBearer === undefined) throw new Error("Charlie's session carries no IdP token");

      // ---- Alice's card on `/` -------------------------------------------
      await cdp.command("Page.navigate", { url: origin });
      await waitFor(`the ${ON_THE_CARDS} card`, async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('[data-loan="${ON_THE_CARDS}"]') !== null`),
      );
      expect(await cardText(cdp, ON_THE_CARDS)).toContain("pending");

      await mark(cdp, "home");
      const homeAt = Date.now();
      expect(await approve(loanAppHost, ON_THE_CARDS, 88_000, charlieBearer)).toBe(200);

      try {
        await waitFor(
          `${ON_THE_CARDS} to show Charlie's approval`,
          async () => (await cardText(cdp as Cdp, ON_THE_CARDS)).includes("approved"),
          WITHIN_ONE_POLL_MS,
        );
      } catch (cause) {
        const diagnostics = await evaluate<unknown>(
          cdp,
          `JSON.stringify({
             polls: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/loans')),
             card: document.querySelector('.bank-file[data-loan="${ON_THE_CARDS}"]')?.innerText,
             body: document.body.innerText.slice(0, 600),
           })`,
        );
        throw new Error(`${String(cause)}; browser: ${String(diagnostics)}`);
      }
      const homeElapsed = Date.now() - homeAt;
      const card = await cardText(cdp, ON_THE_CARDS);
      expect(card).toContain("approved");
      expect(card).toContain("Charlie");
      expect(card).toMatch(/UTC/);
      expect(homeElapsed).toBeLessThan(WITHIN_ONE_POLL_MS);
      // The page never navigated: same document, same React tree.
      expect(await marked(cdp, "home")).toBe(true);

      // ---- the board on `/loans` -----------------------------------------
      await cdp.command("Page.navigate", { url: `${origin}/loans` });
      await waitFor("the board", async () =>
        evaluate<boolean>(cdp as Cdp, `document.querySelector('.bank-board-grid') !== null`),
      );
      // The whole book, not just the two beside the chat.
      expect(await evaluate<number>(cdp, `document.querySelectorAll('.bank-board-card').length`)).toBeGreaterThan(2);
      // Charlie's decision from a moment ago is already on it.
      expect(await boardText(cdp, ON_THE_CARDS)).toContain("Charlie");
      expect(await boardText(cdp, ON_THE_BOARD)).toContain("Awaiting a decision");

      await mark(cdp, "board");
      const boardAt = Date.now();
      expect(await approve(loanAppHost, ON_THE_BOARD, 95_000, charlieBearer)).toBe(200);

      await waitFor(
        `${ON_THE_BOARD} to turn over on the board`,
        async () => (await boardText(cdp as Cdp, ON_THE_BOARD)).includes("approved"),
        WITHIN_ONE_POLL_MS,
      );
      const boardElapsed = Date.now() - boardAt;
      const tile = await boardText(cdp, ON_THE_BOARD);
      expect(tile).toContain("approved");
      expect(tile).toContain("Charlie");
      expect(boardElapsed).toBeLessThan(WITHIN_ONE_POLL_MS);
      expect(await marked(cdp, "board")).toBe(true);

      // The board is the bank's screen. Nothing on it belongs to the control
      // plane — no `cg-` class, and none of the panel's vocabulary.
      const board = await evaluate<string>(cdp, `document.body.innerHTML`);
      expect(board).not.toMatch(/class="[^"]*\bcg-/);
      expect(await evaluate<string>(cdp, `document.body.innerText`)).not.toMatch(
        /governance|control plane|policy|hook|Arcade/i,
      );
      // And act 3's and act 4's subjects are not in the page source at all.
      for (const field of ["bank_account_number", "tax_id", "underwriter_notes"]) {
        expect(board).not.toContain(field);
      }
    } finally {
      cdp?.close();
      await stopProcess(chrome);
      await stopProcess(next);
      await stopProcess(loanApp);
      await identity?.stop();
      if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
      if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
    }
  },
  300_000,
);

/** A real sign-in, unsealed back into the `Session` a browser would be carrying. */
async function sessionFor(harness: IdentityHarness, persona: keyof typeof PEOPLE): Promise<Session> {
  const browser = new Browser();
  await signInAs(browser, harness, persona, { stopAt: "/api/arcade/start" });
  const session = await openSealed<Session>(joinChunks(SESSION_COOKIE, browser.cookies), SESSION_SECRET);
  if (session === null) throw new Error(`signing in as ${persona} left no session`);
  return session;
}

/** `POST /loans/:id/approve`, as the person whose bearer this is. */
async function approve(host: string, loanId: string, amount: number, bearer: string): Promise<number> {
  const response = await fetch(`http://${host}/loans/${loanId}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  return response.status;
}

/**
 * The card's text as the DOM holds it, not as CSS renders it.
 *
 * `textContent`, deliberately: the status box is `text-transform: uppercase`,
 * so `innerText` would come back `APPROVED` and a test matching the loan book's
 * own `approved` would fail for a reason that has nothing to do with the loan
 * book.
 */
function cardText(cdp: Cdp, loanId: string): Promise<string> {
  return evaluate<string>(cdp, `document.querySelector('.bank-file[data-loan="${loanId}"]')?.textContent ?? ''`);
}

function boardText(cdp: Cdp, loanId: string): Promise<string> {
  return evaluate<string>(cdp, `document.querySelector('.bank-board-card[data-loan="${loanId}"]')?.textContent ?? ''`);
}

/** Put a marker on the document so a navigation or a remount can be detected. */
function mark(cdp: Cdp, name: string): Promise<void> {
  return evaluate<void>(cdp, `document.documentElement.setAttribute('data-cg-mark', ${JSON.stringify(name)})`);
}

function marked(cdp: Cdp, name: string): Promise<boolean> {
  return evaluate<boolean>(cdp, `document.documentElement.getAttribute('data-cg-mark') === ${JSON.stringify(name)}`);
}

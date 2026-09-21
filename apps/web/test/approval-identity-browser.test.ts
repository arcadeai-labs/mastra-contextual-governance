/**
 * #180, as the human reported it, in a real browser.
 *
 * > Alice escalates a loan above her authority. The approval is routed to
 * > Charlie and a Slack DM goes out with the approval link. **Alice opens that
 * > link herself and approves the loan.** It succeeds.
 *
 * Every word of that is driven here and nothing is stood in for except Arcade's
 * transport. `apps/idp` is a real subprocess and Alice's session is the one a
 * real authorization-code flow left behind after a real password was typed into
 * a real login form. `apps/hooks` is a real subprocess answering `/pre` from the
 * real policy. `next dev` serves the actual page. Headless Chrome opens the
 * link and **presses the button**, which is the part a render test cannot do:
 * the defect was never in what the page displayed, it was in the `user_id` the
 * server action chose when nobody had chosen one.
 *
 * ## Why it is written this way and not more cheaply
 *
 * This file imports nothing that #180 added. That is deliberate and it is the
 * evidence: the same file, dropped unchanged into a worktree at `ab21b48`,
 * compiles and runs, and Alice's Approve is **recorded** instead of refused.
 * A test that could only fail there by failing to import would prove nothing
 * about the defect.
 *
 * ## Both directions, because one is not a control
 *
 * A refusal that fires on everybody is indistinguishable from a page that is
 * simply broken, which on this project is the recurring failure mode. So
 * Charlie — the routed approver, signed in as himself, opening the same link —
 * has to still get through. The second half of this test is what makes the
 * first half mean something.
 *
 * The rig is the repo's: `test/cdp.ts` drives the browser and `test/chrome.ts`
 * finds one. Since #152 a missing browser is a failure on CI rather than a
 * silent skip.
 */
import { spawn, type Subprocess } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";
import { chunk, chunkName, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, type Session } from "../lib/identity/session.ts";
import {
  Browser,
  PEOPLE,
  SESSION_SECRET,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
  type PersonaKey,
} from "./identity-harness.ts";
import { DANA, HOOK_SECRET, RILEY, startHarness, type Harness } from "./harness.ts";

const WEB = join(import.meta.dir, "..");

const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "Alice opens her own approval link, presses Approve, and the pre-hook refuses her by name",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const CHROME = chromeResolution.path;

    let identity: IdentityHarness | undefined;
    let control: Harness | undefined;
    let next: Subprocess | undefined;
    let chrome: Subprocess | undefined;
    let cdp: Cdp | undefined;
    let profile: string | undefined;

    try {
      // The real IdP, and the real control plane with a stand-in Arcade that
      // works by *calling the real pre-hook*.
      [identity, control] = await Promise.all([startIdentityHarness(), startHarness()]);

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
          // The key the sealed sessions below are sealed under. A mismatch here
          // is indistinguishable from "not signed in", which is exactly the
          // state this test is trying to tell apart from a real identity.
          SESSION_SECRET,
          IDP_ISSUER: identity.idpUrl,
          IDP_CLIENT_ID: identity.config.identity.idpClientId,
          IDP_CLIENT_SECRET: identity.config.identity.idpClientSecret,
          HOOKS_PUBLIC_HOST: control.hooksHost,
          APPROVALS_STORE_TOKEN: control.config.approvalsStoreToken,
          ARCADE_API_URL: control.config.arcadeApiUrl,
          ARCADE_API_KEY: control.config.arcadeApiKey,
          ARCADE_APPROVALS_TOOLKIT: control.config.approvalsToolkit,
          PERSONA_LOAN_OFFICER_EMAIL: PEOPLE.dana.email,
          PERSONA_CREDIT_ANALYST_EMAIL: PEOPLE.sam.email,
          PERSONA_VP_CREDIT_EMAIL: PEOPLE.riley.email,
          PERSONA_CHIEF_CREDIT_OFFICER_EMAIL: PEOPLE.morgan.email,
          ANTHROPIC_API_KEY: "not-used-by-this-suite",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(next.stdout as ReadableStream).text();
      void new Response(next.stderr as ReadableStream).text();
      await waitForHttp(`${origin}/`);

      profile = mkdtempSync(join(tmpdir(), "cg-approval-identity-chrome-"));
      chrome = spawn({
        cmd: [
          CHROME,
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--window-size=1440,900",
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

      cdp = new Cdp((await browserTarget(debugPort)).webSocketDebuggerUrl);
      await cdp.command("Page.enable");
      await cdp.command("Runtime.enable");
      await cdp.command("Network.enable");

      // ---- the escalation, exactly as `tools/approvals` writes it ---------
      // Alice raised it; routing sent it to Charlie and left Michael alone.
      const request = await control.escalate();
      const id = String(request.id);
      expect(request.requester_id).toBe(DANA);
      expect(request.approver_id).toBe(RILEY);
      const link = `${origin}/approvals/${id}`;

      // ---- Alice, signed in as Alice, opens her own link ------------------
      // Her own Chrome profile, holding the cookie her own password produced.
      // Nothing on the page and nothing in this test tells it who she is.
      await useSession(cdp, await sessionFor(identity, "dana"));
      await cdp.command("Page.navigate", { url: link });
      await waitForButtons(cdp);

      // The page says whose decision it is about to make, and it is hers.
      const aliceHeader = await evaluate<string>(cdp, `document.body.innerText`);
      expect(aliceHeader).toContain("Alice");
      expect(aliceHeader).not.toContain("Signed in as Charlie");

      await pressApprove(cdp);
      const refusal = await waitForOutcome(cdp);

      // The control that #180 says was never consulted about her.
      expect(refusal).toContain("CHECK_FAILED");
      expect(refusal).toContain("separation of duties");
      expect(refusal).toContain("The request is unchanged.");

      // Nothing was decided. This is the assertion the reported bug fails.
      expect(await control.read(id)).toMatchObject({ status: "pending", decided_by: null });

      // The call reached the pre-hook as **Alice** — not as the routed
      // approver the page used to assume the opener was.
      expect(control.preCalls).toEqual([{ user_id: DANA, tool: "Approvals.Decide" }]);

      // And the audit row names her. A row naming Charlie for a decision
      // Charlie was not present for is worse than no row: it is wrong in a way
      // indistinguishable from the correct case.
      const denials = await audit(control.hooksHost, { hook: "pre", decision: "deny", tool: "Approvals.Decide" });
      expect(denials.length).toBe(1);
      expect(denials[0]).toMatchObject({ user_id: DANA });
      expect(JSON.stringify(denials[0])).toContain("decide-not-by-the-requester");
      // Nobody signed in as Charlie has touched this request.
      expect(denials.some((row) => row.user_id === RILEY)).toBe(false);

      // ---- Charlie, on the same link, still gets through ------------------
      // A refusal that fires on everybody is not a control. This is the half
      // that says the rule discriminates rather than blocks.
      control.preCalls.length = 0;
      await useSession(cdp, await sessionFor(identity, "riley"));
      await cdp.command("Page.navigate", { url: link });
      await waitForButtons(cdp);

      expect(await evaluate<string>(cdp, `document.body.innerText`)).toContain("Charlie");

      await pressApprove(cdp);
      const recorded = await waitForOutcome(cdp);

      expect(recorded).toContain("Decision recorded");
      expect(recorded).not.toContain("CHECK_FAILED");
      expect(await control.read(id)).toMatchObject({ status: "approved", decided_by: RILEY });
      expect(control.preCalls).toEqual([{ user_id: RILEY, tool: "Approvals.Decide" }]);
    } finally {
      cdp?.close();
      await stopProcess(chrome);
      await stopProcess(next);
      await control?.stop();
      await identity?.stop();
      if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
    }
  },
  420_000,
);

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/** A real sign-in, unsealed back into the `Session` a browser would be carrying. */
async function sessionFor(harness: IdentityHarness, persona: PersonaKey): Promise<Session> {
  const browser = new Browser();
  await signInAs(browser, harness, persona, { stopAt: "/api/arcade/start" });
  const session = await openSealed<Session>(joinChunks(SESSION_COOKIE, browser.cookies), SESSION_SECRET);
  if (session === null) throw new Error(`signing in as ${persona} left no session`);
  return session;
}

/**
 * Put this session in the browser, and only this session.
 *
 * Cleared first: one persona per browser is the design (`DESIGN.md` → Gateway
 * token storage), and a leftover chunk from a longer session would join onto a
 * shorter new one and refuse to open — which reads as "not signed in" and would
 * quietly turn the second half of this test into a repeat of the first.
 */
async function useSession(cdp: Cdp, session: Session): Promise<void> {
  await cdp.command("Network.clearBrowserCookies");
  await cdp.command("Network.setCookies", {
    cookies: chunk(await seal(session, SESSION_SECRET)).map((value, index) => ({
      name: chunkName(SESSION_COOKIE, index),
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    })),
  });
}

const APPROVE = 'document.querySelector(\'button[value="approved"]\')';

async function waitForButtons(cdp: Cdp): Promise<void> {
  await waitFor("the Approve button", async () => evaluate<boolean>(cdp, `${APPROVE} !== null`), 60_000);
}

/**
 * Press Approve. **Once.**
 *
 * Exactly once, and the emphasis is the point: a retry would be a second
 * decision, and the second decision on a request that has just been recorded is
 * refused for a completely different reason — "already been decided" — which
 * would put a refusal on screen in the half of this test that is supposed to
 * prove a decision gets *through*.
 *
 * One click reaches the server action either way. Hydrated, `useActionState`
 * intercepts it; unhydrated, the same click is an ordinary form POST that Next
 * answers by re-rendering with the action's result. What neither does is answer
 * instantly under `next dev`, which compiles the route on the first request —
 * hence the wait rather than a retry.
 */
async function pressApprove(cdp: Cdp): Promise<void> {
  await evaluate<void>(cdp, `${APPROVE}.click()`);
}

async function waitForOutcome(cdp: Cdp): Promise<string> {
  await waitFor(
    "the outcome panel",
    async () => evaluate<boolean>(cdp, `document.querySelector('[role="status"]') !== null`),
    120_000,
  );
  return evaluate<string>(cdp, `document.querySelector('[role="status"]').innerText`);
}

/** `GET /audit` on the real control plane, with Arcade's bearer. */
async function audit(
  hooksHost: string,
  filters: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`http://${hooksHost}/audit?${new URLSearchParams(filters)}`, {
    headers: { authorization: `Bearer ${HOOK_SECRET}` },
  });
  if (!response.ok) throw new Error(`audit: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
}

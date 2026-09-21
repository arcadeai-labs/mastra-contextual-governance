/**
 * The Slack link, opened in a browser with no session.
 *
 * `DESIGN.md` has each persona in their own Chrome profile, and a link posted
 * to Slack gets opened wherever the person happens to be — so "no session" is
 * the ordinary case rather than the edge, and the human's decision (#180, the
 * driver's call, 2026-09-21) is that it is an ordinary **sign-in** rather than
 * an error:
 *
 * - the request renders exactly as it does for a signed-in opener, because
 *   reading is not deciding and an approver should see what they are being
 *   asked to approve before being asked for a password;
 * - Approve and Deny are replaced by a distinct `Sign in to decide`, never a
 *   greyed-out Approve — a disabled Approve on a governance page reads as a
 *   refusal nothing made;
 * - and signing in comes back to the same link.
 *
 * That last part is **followed**, not read off the handlers. `safeNext`
 * returning a path is not the claim; the claim is that a person who opens a
 * link, types a password at `cg-idp`, and comes back can press the button. So
 * this drives the whole chain — `next dev` serves the page, the real
 * `apps/idp` asks for the password, and the same cookie jar arrives back on the
 * approval page with the buttons on it.
 *
 * No browser here on purpose: every hop is a redirect and an HTML form, which
 * the suite's own cookie jar follows, and the thing being proved is a route
 * rather than a rendering. `approval-identity-browser.test.ts` is where a real
 * Chrome presses a real button.
 */
import { spawn, type Subprocess } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import { freePort, stopProcess, waitForHttp } from "./cdp.ts";
import {
  Browser,
  SESSION_SECRET,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
} from "./identity-harness.ts";
import { RILEY, startHarness, type Harness } from "./harness.ts";

const WEB = join(import.meta.dir, "..");

let identity: IdentityHarness;
let control: Harness;
let next: Subprocess | undefined;
let origin: string;

beforeAll(async () => {
  // Reserved before the IdP starts, because `apps/idp` has to be told to accept
  // this origin's callback: Better Auth checks the redirect URI against the
  // registered list, and pointing the sign-in at a server that does not serve
  // the page under test would be testing around that rather than through it.
  const webPort = freePort();
  origin = `http://localhost:${webPort}`;

  [identity, control] = await Promise.all([
    startIdentityHarness({ extraWebRedirectUris: [`${origin}/api/auth/callback`] }),
    startHarness(),
  ]);

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
      HOOKS_PUBLIC_HOST: control.hooksHost,
      APPROVALS_STORE_TOKEN: control.config.approvalsStoreToken,
      ARCADE_API_URL: control.config.arcadeApiUrl,
      ARCADE_API_KEY: control.config.arcadeApiKey,
      ARCADE_APPROVALS_TOOLKIT: control.config.approvalsToolkit,
      ANTHROPIC_API_KEY: "not-used-by-this-suite",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(next.stdout as ReadableStream).text();
  void new Response(next.stderr as ReadableStream).text();
  await waitForHttp(`${origin}/`);
}, 300_000);

afterAll(async () => {
  await stopProcess(next);
  await control?.stop();
  await identity?.stop();
});

const read = async (browser: Browser, path: string) => (await browser.fetch(`${origin}${path}`)).text();

test("an opener with no session sees the request, and a sign-in instead of the buttons", async () => {
  const id = String((await control.escalate()).id);
  const html = await read(new Browser(), `/approvals/${id}`);

  expect(html).toContain("Sign in to decide");
  // The same fields a signed-in opener gets. Not trimmed because signed-out
  // feels sensitive, and not widened either: whether this link should disclose
  // the request at all is a separate question, and it is not answered
  // differently per viewer here.
  expect(html).toContain("LN-2291");
  expect(html).toContain("$95,000");
  expect(html).toContain("Eleven years in business");
  expect(html).toContain("approve_loan");
  // There is no button to press, and nothing that reads as one having been
  // refused.
  expect(html).not.toMatch(/value="approved"/);
  expect(html).not.toContain("disabled");
  expect(html).not.toContain("CHECK_FAILED");
});

test("signing in from that link comes back to the same request, with the buttons", async () => {
  const id = String((await control.escalate()).id);
  const browser = new Browser();

  const cold = await read(browser, `/approvals/${id}`);
  const href = /href="([^"]*api\/auth\/signin[^"]*)"/.exec(cold)?.[1];
  if (href === undefined) throw new Error(`no sign-in link on the signed-out page:\n${cold.slice(0, 800)}`);

  // Followed from the page's own link, not from a URL this test composed — a
  // test that builds its own destination proves its own arithmetic.
  const landed = await signInAs(browser, identity, "riley", {
    from: new URL(href.replace(/&amp;/g, "&"), origin).toString(),
    // Stop on the redirect *to* the approval page. Letting `follow` fetch it
    // would make it fill and post the decide form, which is a decision this
    // test never asked for.
    stopAt: `/approvals/${id}`,
  });

  expect(landed.url).toBe(`${origin}/approvals/${id}`);
  // A real password was typed at the IdP and nowhere else.
  expect(browser.pageHosts).toContain(new URL(identity.idpUrl).host);

  const warm = await read(browser, `/approvals/${id}`);
  expect(warm).toContain("Signed in as");
  expect(warm).toContain("Charlie");
  expect(warm).toContain(RILEY);
  expect(warm).toContain('value="approved"');
  expect(warm).not.toContain("Sign in to decide");
  // Still no way to act as anybody else.
  expect(warm).not.toContain("Act as");
  expect(warm).not.toContain("<select");
}, 120_000);

test("a link nobody recognises says so without costing a password", async () => {
  const html = await read(new Browser(), "/approvals/apr_nosuchthing");

  expect(html).toContain("Nothing to decide");
  expect(html).not.toContain("Sign in to decide");
});

/**
 * The co-branded frame (#177), measured rather than described.
 *
 * Almost nothing this slice claims is a claim about markup. "The composer is
 * still above the fold", "the two marks are the same height", "the
 * misconfiguration banner is under the bar and not behind it" are all claims
 * about *layout at a stated viewport*, and `renderToStaticMarkup` cannot be
 * asked any of them — so the browser half of this file drives the real Next
 * server in a real Chrome at 1920×1080, the projector the demo is given on.
 *
 * Two of these would pass on a frame that did nothing at all, so they are
 * written as differences rather than as absences:
 *
 * - **The height budget.** The bar's own height plus the surface's height is
 *   the viewport exactly. That fails both if the frame costs more than it says
 *   and if it costs nothing because the surface still takes `100dvh` and the
 *   document scrolls.
 * - **The cap match.** The two marks' *ink* is measured off a canvas, per mark,
 *   in the band the tall element occupies — Arcade's capital "A" and Mastra's
 *   glyph. Comparing the two `<img>` boxes would compare the numbers this
 *   slice chose with themselves; the aspect ratios are 3.8:1 and 6.4:1, so
 *   equal boxes are the one thing that is certainly wrong.
 *
 * The cheap half — that the frame is on the keep side of the fork seam, and
 * that neither mark was recolored to sit on the bar — runs everywhere, browser
 * or not. A control that silently does not run is this project's recurring
 * failure, and a skipped file would take the source assertions with it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";

const WEB = join(import.meta.dir, "..");
const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

/** The projector. #177 names this viewport and the composer is measured against it. */
const VIEWPORT = { width: 1920, height: 1080 } as const;

/** What `frame.css` says the frame costs. Asserted, not assumed. */
const BAR_HEIGHT = 34;

/**
 * A deployment with nothing missing, so `/` renders without #84's banner.
 *
 * None of these values is used against anything: no page in this file signs
 * anybody in, opens a gateway session or sends a message. They exist because
 * `configurationProblems` counts absences, and the banner is the subject of the
 * last test rather than a fixture of the first three.
 */
const CONFIGURED: Record<string, string> = {
  IDP_ISSUER: "http://127.0.0.1:1/idp-not-called-by-this-test",
  IDP_CLIENT_ID: "web",
  IDP_CLIENT_SECRET: "not-used-by-this-test",
  ARCADE_GATEWAY_ID: "cg-demo-us",
  ARCADE_API_KEY: "not-used-by-this-test",
  ARCADE_LOAN_TOOLKIT: "Loan",
  ARCADE_APPROVALS_TOOLKIT: "Approvals",
  ANTHROPIC_API_KEY: "not-used-by-this-test",
  MODEL_ID: "claude-sonnet-5",
  SESSION_SECRET: "frame-test-session-secret-at-least-32-chars",
};

interface Browser {
  cdp: Cdp;
  origin: string;
  /** Load a path at 1920×1080 and wait for the frame to exist. */
  open: (path: string) => Promise<void>;
}

/**
 * Boot Next and Chrome, hand them to `body`, and take both down afterwards.
 *
 * No session cookie and no stand-ins. Every page under test answers without a
 * network call when nobody is signed in — `homeSurface` and `readLoanBook` both
 * short-circuit on a `null` session — so the frame can be measured against the
 * real App Router without an IdP, a gateway or a loan book behind it. The
 * surfaces' own tests own the rest.
 */
async function withBrowser(
  env: Record<string, string>,
  body: (browser: Browser) => Promise<void>,
): Promise<void> {
  let next: Subprocess | undefined;
  let chrome: Subprocess | undefined;
  let cdp: Cdp | undefined;
  let profile: string | undefined;
  try {
    const webPort = freePort();
    const debugPort = freePort();
    const origin = `http://127.0.0.1:${webPort}`;
    const environment: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NODE_ENV: "development",
      PORT: String(webPort),
      PUBLIC_URL: origin,
      // A port this process bound and released: the loan read is refused by the
      // kernel and the book comes back unavailable. It may not default to
      // `LOAN_APP_PUBLIC_HOST` — that port belongs to whichever sibling
      // worktree is running, and this one would read its loan book.
      LOAN_APP_PUBLIC_HOST: `localhost:${freePort()}`,
      ...env,
    };
    for (const name of ["GOVERNANCE_STREAM", "HOOKS_PUBLIC_HOST"]) delete environment[name];
    for (const [name, value] of Object.entries(env)) {
      if (value === "") delete environment[name];
    }

    next = Bun.spawn({
      cmd: ["bun", "run", "next", "dev", "--port", String(webPort)],
      cwd: WEB,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    void new Response(next.stdout as ReadableStream).text();
    void new Response(next.stderr as ReadableStream).text();
    await waitForHttp(`${origin}/`);

    profile = mkdtempSync(join(tmpdir(), "cg-frame-chrome-"));
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
    await cdp.command("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const client = cdp;
    await body({
      cdp: client,
      origin,
      open: async (path) => {
        await client.command("Page.navigate", { url: `${origin}${path}` });
        await waitFor(`the frame on ${path}`, async () =>
          evaluate<boolean>(
            client,
            `document.querySelector('.frame-bar img.frame-mark-mastra')?.complete === true`,
          ),
        );
        // The fonts and the client bundle, so a measured rect is the settled one.
        await Bun.sleep(1_000);
      },
    });
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(next);
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  }
}

/** `getBoundingClientRect` for one selector, rounded, or `null` when it is absent. */
const rectOf = (selector: string) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (node === null) return null;
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) };
})()`;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
}

/**
 * The ink height of one mark, in CSS pixels, within a horizontal band of it.
 *
 * The band is how the tall element is isolated: Arcade's letters are a single
 * connected outline — they touch along the baseline flourish — so there is no
 * sub-path to measure and no gap to segment on at the glyph level. Measured off
 * the file, the capital "A" occupies 5%–22% of the mark's width and the "r"
 * begins at 24.5%; Mastra's glyph occupies 0%–25% and its "m" begins at 34%.
 *
 * Drawn at twenty times the rendered size so antialiasing costs a fortieth of a
 * CSS pixel rather than a whole one, then divided back down.
 */
const inkHeight = (selector: string, from: number, to: number) => `(async () => {
  const img = document.querySelector(${JSON.stringify(selector)});
  const rect = img.getBoundingClientRect();
  const scale = 20;
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const source = new Image();
  source.src = img.currentSrc || img.src;
  await source.decode();
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const x0 = Math.floor(width * ${from});
  const x1 = Math.ceil(width * ${to});
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 20) { if (top < 0) top = y; bottom = y; break; }
    }
  }
  return { box: rect.height, ink: (bottom - top + 1) / scale };
})()`;

describe("the frame's source and its assets", () => {
  /**
   * The fork seam. `app/Frame.tsx` is on the keep side of it — a developer
   * deletes `components/bank` and the frame still brands what is left — and it
   * may no more reach into the panel than the bank may.
   */
  test("the frame imports no surface", () => {
    const source = readFileSync(join(WEB, "app/Frame.tsx"), "utf8");

    for (const surface of ["components/bank", "components/governance", "components/chat"]) {
      expect({ surface, imports: source.includes(`from "../${surface}`) }).toEqual({
        surface,
        imports: false,
      });
    }
  });

  /**
   * And its stylesheet styles nothing but itself — the rule `bank.css` is held
   * to, for the same reason. A `.frame-stage > *` that named a surface would be
   * the frame knowing what it wraps.
   */
  test("the frame's stylesheet names no surface", () => {
    const css = readFileSync(join(WEB, "app/frame.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    for (const selector of css.matchAll(/^\.([a-z-]+)/gm)) {
      expect(selector[1]).toStartWith("frame");
    }
    for (const surface of [".bank", ".cg-"]) {
      expect({ surface, styled: css.includes(surface) }).toEqual({ surface, styled: false });
    }
  });

  /**
   * Neither mark is recolored.
   *
   * Both files are white-only — measured, and the reason the bar is black
   * rather than a taste call. This is the assertion that a later slice cannot
   * quietly walk back by tinting a fill to make the frame match something.
   */
  test("every fill in both marks is white", () => {
    for (const mark of ["arcade-wordmark-white.svg", "mastra-wordmark.svg"]) {
      const svg = readFileSync(join(WEB, "public", mark), "utf8");
      const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((match) => match[1]);

      expect({ mark, fills: [...new Set(fills)].sort() }).toEqual({ mark, fills: ["none", "white"] });
    }
  });
});

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "the frame wraps every surface and costs exactly 34px of the viewport",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));

    await withBrowser(CONFIGURED, async (browser) => {
      // `/panel` brings `.cg-page`, the other two bring `.bank`; both ask for
      // `height: 100dvh` and both have to end up with the stage's height
      // instead. That is the whole of the height contract.
      const surfaces: ReadonlyArray<readonly [string, string]> = [
        ["/", ".bank"],
        ["/loans", ".bank"],
        ["/panel", ".cg-page"],
      ];

      for (const [path, root] of surfaces) {
        await browser.open(path);

        const bar = await evaluate<Rect>(browser.cdp, rectOf(".frame-bar"));
        const surface = await evaluate<Rect>(browser.cdp, rectOf(root));

        expect({ path, bar }).toEqual({
          path,
          bar: { x: 0, y: 0, width: VIEWPORT.width, height: BAR_HEIGHT, bottom: BAR_HEIGHT },
        });
        // In flow, not over: the surface starts where the bar ends, and the two
        // together are the viewport and nothing more.
        expect({ path, surface }).toEqual({
          path,
          surface: {
            x: 0,
            y: BAR_HEIGHT,
            width: VIEWPORT.width,
            height: VIEWPORT.height - BAR_HEIGHT,
            bottom: VIEWPORT.height,
          },
        });

        // Both marks, from the files their owners drew, in the order
        // `brand-kit` specifies: Arcade, separator, Mastra.
        const lockup = await evaluate<string[]>(
          browser.cdp,
          `[...document.querySelectorAll('.frame-lockup > *')].map((node) => node.getAttribute('src') ?? node.className)`,
        );
        expect({ path, lockup }).toEqual({
          path,
          lockup: ["/arcade-wordmark-white.svg", "frame-divider", "/mastra-wordmark.svg"],
        });

        // Nothing scrolls. A frame that had been added to a `100dvh` surface
        // without taking anything off it would show up here and nowhere else.
        const scrolls = await evaluate<boolean>(
          browser.cdp,
          `document.documentElement.scrollHeight > window.innerHeight`,
        );
        expect({ path, scrolls }).toEqual({ path, scrolls: false });
      }

      // And the bank page, which is the one the frame could break, still keeps
      // its composer on screen: what the room watches, at the viewport #177
      // names.
      await browser.open("/");
      const composer = await evaluate<Rect>(
        browser.cdp,
        rectOf('textarea[aria-label="Message the assistant"]'),
      );
      expect(composer.bottom).toBeLessThanOrEqual(VIEWPORT.height);
      expect(composer.height).toBeGreaterThan(0);

      // The frame adds no `cg-` class to `/`. The panel's namespace stays the
      // panel's, which `home-full-screen-browser.test.ts` asserts about the
      // page and this asserts about the thing now wrapped around it.
      const html = await evaluate<string>(browser.cdp, `document.documentElement.outerHTML`);
      expect(html).not.toMatch(/class="[^"]*\bcg-[a-z]/);
      // The bank chrome, unchanged inside the frame.
      expect(html).toContain("Loan Origination System");
      expect(html).toContain("Rel. 7.2.1");
    });
  },
  240_000,
);

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "the two marks are matched by rendered cap height, not by box",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));

    await withBrowser(CONFIGURED, async (browser) => {
      await browser.open("/");

      const arcade = await evaluate<{ box: number; ink: number }>(
        browser.cdp,
        inkHeight(".frame-mark-arcade", 0.05, 0.23),
      );
      const mastra = await evaluate<{ box: number; ink: number }>(
        browser.cdp,
        inkHeight(".frame-mark-mastra", 0, 0.3),
      );

      // The measurement this test exists for: the "A" and the glyph render the
      // same number of pixels tall, to a third of one.
      expect(Math.abs(arcade.ink - mastra.ink)).toBeLessThan(0.34);

      // And they got there by *not* being the same box, which is the issue's
      // point and the thing an equal-heights frame would fail. The caps are
      // 0.9843 and 0.9963 of their own boxes, so Arcade's box is 1.22% taller.
      expect(arcade.box).toBeGreaterThan(mastra.box);
      expect(Math.abs(arcade.box / mastra.box - 0.9963 / 0.9843)).toBeLessThan(0.002);

      // And neither is so small that matching them means nothing: an 18px cap
      // on a 34px bar is what was measured for the projector.
      expect(Math.round(arcade.ink)).toBe(18);
      expect(Math.round(mastra.ink)).toBe(18);
    });
  },
  240_000,
);

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "a half-configured deployment still meets the banner first",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));

    // #84 round 2: a deployment that renders a perfectly normal page and fails
    // at the point of use. The banner is the answer to it, and the frame may
    // not bury it, push it below the bank's chrome, or cover it.
    await withBrowser({ ...CONFIGURED, ARCADE_GATEWAY_ID: "" }, async (browser) => {
      await browser.open("/");

      const html = await evaluate<string>(browser.cdp, `document.documentElement.outerHTML`);
      expect(html).toContain("This deployment is not fully configured");
      expect(html).toContain("ARCADE_GATEWAY_ID is not set");

      // Order in the served document: the bar, then the banner, then the bank's
      // own chrome. Not a screenshot — the order itself.
      const bar = html.indexOf("frame-bar");
      const banner = html.indexOf("This deployment is not fully configured");
      const chrome = html.indexOf("Loan Origination System");
      expect({ barBeforeBanner: bar < banner, bannerBeforeChrome: banner < chrome }).toEqual({
        barBeforeBanner: true,
        bannerBeforeChrome: true,
      });

      // And in the viewport: fully on screen, directly under the bar, with
      // nothing of the frame's on top of it at any point along its top edge.
      const alert = await evaluate<Rect>(browser.cdp, rectOf('[role="alert"]'));
      expect(alert.y).toBe(BAR_HEIGHT);
      expect(alert.bottom).toBeLessThanOrEqual(VIEWPORT.height);
      const covered = await evaluate<string[]>(
        browser.cdp,
        `(() => {
          const alert = document.querySelector('[role="alert"]');
          const r = alert.getBoundingClientRect();
          const points = [0.02, 0.5, 0.98].map((fraction) => [r.x + r.width * fraction, r.y + 2]);
          return points.map(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit === null ? "nothing" : alert.contains(hit) || hit === alert ? "banner" : hit.className;
          });
        })()`,
      );
      expect(covered).toEqual(["banner", "banner", "banner"]);
    });
  },
  240_000,
);

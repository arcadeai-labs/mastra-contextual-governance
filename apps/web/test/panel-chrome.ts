/**
 * How much of the screen the panel spends on chrome before the first lane,
 * measured in a real Chrome rather than read off a screenshot (#158, round 2).
 *
 * ## Why this file exists
 *
 * Round 1 of PR #165 claimed the chrome above the first lane went 417px → 90px
 * at 1920×1080 and 316px → 71px at 1440×900, and offered four cropped PNGs as
 * the evidence. The PNGs are exactly 417, 90, 316 and 71 pixels tall. A crop
 * whose height *is* the number it is evidence for cannot corroborate it — it
 * restates it — and the reviewer, measuring the same page in real Chrome, got
 * different figures in every state they could reach.
 *
 * So the number is produced here, by code anyone can run, and pinned by
 * `panel-chrome-height.test.ts` so it cannot decay quietly the way an assertion
 * living only in a PR body can.
 *
 * ## What is measured
 *
 * `.cg-lane`'s top edge relative to `.cg-panel`'s, which is the reviewer's
 * definition and the honest one: everything the panel draws before the first
 * lane begins. `.cg-panel` is the flex column, `.cg-lanes` is its second child
 * and has no padding of its own, so this is exactly the header's border-box
 * height — but it is taken as the difference of two `getBoundingClientRect()`
 * calls rather than as a header height, so it stays correct if the structure
 * between them ever changes.
 *
 * ## No credential, and no external state
 *
 * `cg-hooks` is a local stub here: it answers `GET /health` with a report in
 * the shape `lib/governance/control-plane.ts` parses, and `GET /events` with
 * #5's fixture sequence over the real SSE frame format, so the lanes under the
 * chrome hold real cards. `RESET_TOKEN` is a throwaway string in the Next
 * process's own environment — the same shape `home-loan-next-browser.test.ts`
 * already uses for `APPROVALS_STORE_TOKEN` — and it authorizes nothing, because
 * the only thing that would accept it is the stub. Nothing is deployed,
 * provisioned, or authenticated, and no reset is ever POSTed.
 *
 * That matters for one state in particular. The Reset control renders only when
 * this service holds a token *and* the control plane reports `reset: enabled`,
 * and it is the state both round-1 live-strip screenshots were taken in — so it
 * is the state the claim has to be checked against. A reviewer with no
 * credentials cannot reach it against a real `cg-hooks`; against the stub,
 * anybody can.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { aGovernanceEventSequence } from "@cg/policy-schema";

import { GOVERNANCE_EVENT_NAME } from "../lib/governance/subscribe.ts";
import { browserTarget, Cdp, evaluate, freePort, stopProcess, waitFor, waitForHttp } from "./cdp.ts";
import { resolveChrome } from "./chrome.ts";

/** The two screens #158 asks for, and the only two this reports on. */
export const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
] as const;

export type Viewport = (typeof VIEWPORTS)[number];

/**
 * A named, reachable state of the panel.
 *
 * Named because "it was 90 on my screen" is not a measurement: a figure about
 * this surface is meaningless without saying which stream the panel is on and
 * what the control plane said about itself, since those are what decide whether
 * there is a health strip above the lanes and whether it carries a Reset
 * control. Reachable because every one of these is produced by the flags below
 * and nothing else — no hand-editing, no dashboard, no credential.
 */
export interface PanelState {
  readonly name: string;
  /** One line, for the PR comment and the screenshot caption. */
  readonly description: string;
  /** The page, including its query string. */
  readonly path: string;
  /**
   * Whether this service holds a `RESET_TOKEN`, which is what decides if the
   * Reset control is drawn. Read per request by the route but taken from the
   * process environment, so each value needs its own Next server.
   */
  readonly resetToken: boolean;
  /**
   * Whether a health strip is expected above the lanes. Declared rather than
   * inferred from the path: it is the whole difference between two of these
   * states, and a measurement that waited for a strip that was never coming
   * would time out somewhere far from the reason.
   */
  readonly strip: boolean;
}

/**
 * The three states worth a number.
 *
 * `fixture-replay` is what every other committed `158-*` screenshot shows: no
 * control plane behind it, so no strip at all. `live-healthy-no-reset` is what a
 * deployment with no `RESET_TOKEN` shows, which is what the round-1 reviewer
 * could reach. `live-healthy-reset` is the state both round-1 live-strip
 * screenshots were actually taken in, and therefore the one the 417→90 / 316→71
 * claim has to be judged against.
 */
export const PANEL_STATES: readonly PanelState[] = [
  {
    name: "fixture-replay",
    description: "/panel?fixture=1 — the built-in replay, which has no control plane and so no health strip",
    path: "/panel?fixture=1",
    resetToken: false,
    strip: false,
  },
  {
    name: "live-healthy-no-reset",
    description: "/panel on the live stream, control plane healthy, RESET_TOKEN unset so no Reset control is drawn",
    path: "/panel",
    resetToken: false,
    strip: true,
  },
  {
    name: "live-healthy-reset",
    description: "/panel on the live stream, control plane healthy, RESET_TOKEN set so the Reset control is drawn",
    path: "/panel",
    resetToken: true,
    strip: true,
  },
];

/**
 * What the stub answers `GET /health` with.
 *
 * The values are the ones the round-1 live-strip screenshots show against the
 * implementer's own `apps/hooks` — revision 19, injection detection armed over
 * 6 patterns — so the strip renders the same sentence those shots do. The
 * sentence's *length* is the only way its content could reach the measurement,
 * by wrapping to a second line, and `stripLines` below asserts it does not.
 */
const HEALTH = {
  status: "healthy",
  reset: "enabled",
  warnings: [],
  policy: { status: "ready", revision: 19, error: null },
  fixture_drift: null,
  injection_detection: { state: "armed", patterns: 6 },
} as const;

/** One measurement of one state at one viewport. */
export interface PanelChromeMeasurement {
  readonly state: string;
  readonly description: string;
  readonly viewport: Viewport;
  /** The number: `.cg-lane` top minus `.cg-panel` top, in CSS pixels. */
  readonly laneTop: number;
  readonly headerHeight: number;
  /** `-1` when there is no health strip, which is a state rather than a gap. */
  readonly stripHeight: number;
  readonly stripState: string;
  /** How many `.cg-control-plane-button`s are on the page. */
  readonly resetControls: number;
  /** Line boxes in the strip's own sentence. More than one means it wrapped. */
  readonly stripLines: number;
  /**
   * Did the header wrap? With `align-items: center` and no wrap every child is
   * vertically centred, so the union of the children is exactly as tall as the
   * tallest child. Taller means a row broke — the one way this measurement can
   * grow without anything being added to the panel.
   */
  readonly headerWrapped: boolean;
  readonly panelFontSize: string;
  readonly cards: number;
}

export interface MeasureOptions {
  /** Which `apps/web` to run. Defaults to this one; the evidence script points it at an older commit. */
  readonly webDir?: string;
  readonly states?: readonly PanelState[];
  readonly viewports?: readonly Viewport[];
  /**
   * When set, a full-viewport PNG of every state is written here with the
   * measurement drawn over it — so the picture shows where the number came
   * from instead of being cropped to it.
   */
  readonly evidenceDir?: string;
  /** Prefix for those filenames, e.g. `158-after-live-strip`. */
  readonly evidencePrefix?: string;
  /** Printed into the caption, so a shot says which tree it is of. */
  readonly label?: string;
}

const DEFAULT_WEB = join(import.meta.dir, "..");

/** The SSE frames the stub sends, built once. */
function fixtureFrames(): string {
  return aGovernanceEventSequence()
    .map(
      (event) =>
        `event: ${GOVERNANCE_EVENT_NAME}\n` + `id: ${event.id}\n` + `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

/**
 * The CORS headers `apps/hooks/src/events.ts` sends, for the reason it states:
 * the panel puts `cache-control` on its first connect and `last-event-id` on
 * every resume, neither of which is a safelisted request header, so the browser
 * preflights. Without them the stream fails to open in a browser while
 * everything server-side keeps passing — which is exactly how this harness
 * first failed, with an empty live panel and no error anywhere.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, cache-control, last-event-id",
  "access-control-max-age": "600",
};

/** A local stand-in for `cg-hooks`: enough of `/health` and `/events`, and nothing else. */
function startStubControlPlane(port: number) {
  const frames = fixtureFrames();
  const encoder = new TextEncoder();
  return Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      // `/health` is read by the Next route, server to server, so it needs no
      // CORS — but it costs nothing and keeps the stub honest about what it
      // is standing in for.
      if (url.pathname === "/health") return Response.json(HEALTH, { headers: CORS_HEADERS });
      if (url.pathname !== "/events") return new Response(null, { status: 404, headers: CORS_HEADERS });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let open = true;
          request.signal.addEventListener("abort", () => {
            open = false;
          });
          const send = (text: string) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              open = false;
            }
          };
          // A comment first so the client reports itself live immediately, then
          // the story.
          send(": stub control plane\n\n");
          send(frames);
          // Then hold the connection open, exactly as the fixture route does.
          // Returning here ends the response, and the panel reads that as the
          // control plane going away: it reports `Reconnecting`, drops back to
          // an empty timeline, and reopens on a timer — so the page being
          // measured would be a reconnect loop rather than a live panel.
          while (open) {
            await Bun.sleep(5_000);
            send(": keep-alive\n\n");
          }
          try {
            controller.close();
          } catch {
            // Already closed by the client going away.
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          ...CORS_HEADERS,
        },
      });
    },
  });
}

/** The one expression that produces the number, so every caller measures the same thing. */
const MEASURE = `(() => {
  const panel = document.querySelector('.cg-panel');
  const lane = document.querySelector('.cg-lane');
  const header = document.querySelector('.cg-header');
  if (panel === null || lane === null || header === null) throw new Error('panel, lane or header missing');
  const panelBox = panel.getBoundingClientRect();
  const laneBox = lane.getBoundingClientRect();
  const strip = document.querySelector('.cg-control-plane');
  const line = document.querySelector('.cg-control-plane-line');
  const children = Array.from(header.children).map((child) => child.getBoundingClientRect());
  const union = Math.max(...children.map((box) => box.bottom)) - Math.min(...children.map((box) => box.top));
  const tallest = Math.max(...children.map((box) => box.height));
  return {
    laneTop: laneBox.top - panelBox.top,
    headerHeight: header.getBoundingClientRect().height,
    stripHeight: strip === null ? -1 : strip.getBoundingClientRect().height,
    stripState: strip === null ? 'none' : String(strip.dataset.state),
    resetControls: document.querySelectorAll('.cg-control-plane-button').length,
    stripLines: line === null ? 0 : line.getClientRects().length,
    headerWrapped: union > tallest + 0.5,
    panelFontSize: getComputedStyle(panel).fontSize,
    cards: document.querySelectorAll('.cg-lane .cg-event').length,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
})()`;

/**
 * Wait until the drawn card count stops moving.
 *
 * Not "wait for N cards": a lane draws at most `VISIBLE_PER_LANE` and #156
 * folds a whole `tools/list` into one card, so the number on screen is not the
 * number of events and pinning it here would couple this measurement to two
 * other slices' display rules. What matters is only that the page has finished
 * arriving before it is measured, and a count that has held still across two
 * polls says that without naming a figure.
 *
 * #158 settles a new card in over 250ms, so the quiet window is longer than
 * that: a measurement taken mid-settle is a measurement of an animation.
 */
async function settledCardCount(cdp: Cdp, quietMs = 1_500): Promise<number> {
  const count = async () =>
    evaluate<number>(cdp, `document.querySelectorAll('.cg-lane .cg-event').length`);
  let seen = await count();
  let stable = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await Bun.sleep(quietMs);
    const now = await count();
    stable = now === seen ? stable + 1 : 0;
    seen = now;
    // Two quiet windows, each longer than the replay's 900ms pacing, so a
    // gap between two acts cannot be mistaken for the end of the story.
    if (stable >= 2 && seen > 0) return seen;
  }
  throw new Error(`the panel never settled on a card count (last saw ${seen})`);
}

/**
 * Draws the measurement onto the page, in `position: fixed` layers appended to
 * `<body>`, and returns nothing.
 *
 * Fixed and out of flow on purpose: an annotation that changed the layout would
 * make the screenshot evidence for a page that only exists while it is being
 * photographed. `.cg-panel` starts at the top of the viewport, so a fixed
 * offset and the measured offset are the same number — which the caption states
 * rather than assumes, by printing `.cg-panel` top as well.
 */
function annotation(measurement: PanelChromeMeasurement, caption: string): string {
  const top = measurement.laneTop;
  const text = `${top.toFixed(2)}px of chrome above the first lane`;
  return `(() => {
    const px = ${JSON.stringify(top)};
    const add = (style, html) => {
      const node = document.createElement('div');
      node.setAttribute('data-cg-annotation', '');
      node.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 13px/1.4 Helvetica,Arial,sans-serif;' + style;
      node.innerHTML = html;
      document.body.appendChild(node);
      return node;
    };
    // The rule at the measured edge, all the way across, so the reader can see
    // it land exactly on the top of the lanes.
    add('left:0;right:0;top:' + (px - 1) + 'px;height:2px;background:#d7ff3e;', '');
    add('left:0;right:0;top:0;height:2px;background:#d7ff3e;opacity:0.75;', '');
    // The caliper: a translucent band over exactly the span being reported.
    add('left:0;width:340px;top:0;height:' + px + 'px;background:rgba(215,255,62,0.16);box-shadow:inset 0 0 0 2px #d7ff3e;', '');
    // Centred on the rule and pushed to the trailing edge: it straddles the
    // boundary it names, so it points at the measurement instead of sitting on
    // top of a lane title, and at both viewports it lands in the lane head's
    // own padding rather than over the word in it.
    add(
      'right:16px;top:' + (px - 11) + 'px;height:22px;box-sizing:border-box;color:#0b0b0b;background:#d7ff3e;padding:3px 8px;font-size:12px;line-height:16px;',
      ${JSON.stringify(text)},
    );
    add(
      'left:0;bottom:0;right:0;color:#d7ff3e;background:rgba(0,0,0,0.88);padding:8px 12px;border-top:2px solid #d7ff3e;font-weight:400;',
      ${JSON.stringify(caption)},
    );
  })()`;
}

/**
 * Boot a Next server and a real Chrome, and measure every state at every
 * viewport.
 *
 * States are grouped by `resetToken` and one Next server is started per group,
 * because the route reads the token from its own process environment at request
 * time — there is no way to change it in place, and faking the answer with a
 * request interception would make the measurement synthetic in exactly the
 * place the claim is disputed. One Chrome is reused throughout.
 */
export async function measurePanelChrome(options: MeasureOptions = {}): Promise<PanelChromeMeasurement[]> {
  const webDir = options.webDir ?? DEFAULT_WEB;
  const states = options.states ?? PANEL_STATES;
  const viewports = options.viewports ?? VIEWPORTS;
  const chromePath = resolveChrome().path;
  if (chromePath === null) throw new Error("no Chrome or Chromium executable; set CG_CHROME_BIN");

  const hooksPort = freePort();
  const debugPort = freePort();
  const hooks = startStubControlPlane(hooksPort);

  let chrome: Subprocess | undefined;
  let cdp: Cdp | undefined;
  let profile: string | undefined;
  const measurements: PanelChromeMeasurement[] = [];

  try {
    profile = mkdtempSync(join(tmpdir(), "cg-panel-chrome-"));
    chrome = Bun.spawn({
      cmd: [
        chromePath,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        // The panel is `height: 100dvh` and never scrolls; a scrollbar gutter
        // would narrow the viewport the evidence claims to be at.
        "--hide-scrollbars",
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

    for (const withToken of [false, true]) {
      const group = states.filter((state) => state.resetToken === withToken);
      if (group.length === 0) continue;

      const webPort = freePort();
      const origin = `http://127.0.0.1:${webPort}`;
      let next: Subprocess | undefined;
      // Drained into a buffer rather than into `void`, so a server that never
      // answers can say why. A boot failure that prints "timed out waiting for
      // HTTP" and nothing else is a morning of guessing.
      const log: string[] = [];
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          log.push(decoder.decode(value, { stream: true }));
        }
      };
      try {
        next = Bun.spawn({
          cmd: ["bun", "run", "next", "dev", "--port", String(webPort)],
          cwd: webDir,
          env: {
            ...process.env,
            NODE_ENV: "development",
            PORT: String(webPort),
            PUBLIC_URL: origin,
            // The live stream, pointed at the stub. Without this the page
            // resolves to the replay and there is no health strip to measure.
            GOVERNANCE_STREAM: "hooks",
            HOOKS_PUBLIC_HOST: `127.0.0.1:${hooksPort}`,
            // A throwaway string that authorizes nothing: the only service it
            // would ever be presented to is the stub above, which ignores it.
            // Set or unset is the whole difference between the last two states.
            RESET_TOKEN: withToken ? "panel-chrome-measurement-not-a-credential" : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        void drain(next.stdout as ReadableStream<Uint8Array>);
        void drain(next.stderr as ReadableStream<Uint8Array>);
        try {
          await waitForHttp(`${origin}/panel?fixture=1`, 180_000);
        } catch (cause) {
          throw new Error(
            `${String(cause)}\n--- next dev output (${webDir}, RESET_TOKEN ${withToken ? "set" : "unset"}) ---\n` +
              log.join("").slice(-4000),
          );
        }

        for (const state of group) {
          for (const viewport of viewports) {
            // Sizes the *page*, identically on macOS and on a Linux runner
            // with no window manager.
            await cdp.command("Emulation.setDeviceMetricsOverride", {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await cdp.command("Page.navigate", { url: `${origin}${state.path}` });
            await waitFor(
              `${state.name} lanes at ${viewport.width}×${viewport.height}`,
              async () => evaluate<boolean>(cdp as Cdp, `document.querySelector('.cg-lane') !== null`),
              120_000,
            );
            if (state.strip) {
              // The strip is a poll, and its arrival is what changes the height
              // being measured. Wait for the state itself rather than a duration
              // — a `sleep` long enough today is a flake on a slower machine.
              await waitFor(
                `${state.name} health strip`,
                async () =>
                  (await evaluate<string | null>(
                    cdp as Cdp,
                    `document.querySelector('.cg-control-plane')?.dataset.state ?? null`,
                  )) === "healthy",
                60_000,
              );
            }
            await settledCardCount(cdp);

            const raw = await evaluate<Omit<PanelChromeMeasurement, "state" | "description" | "viewport"> & {
              innerWidth: number;
              innerHeight: number;
            }>(cdp, MEASURE);
            if (raw.innerWidth !== viewport.width || raw.innerHeight !== viewport.height) {
              throw new Error(
                `asked for ${viewport.width}×${viewport.height}, the page reports ${raw.innerWidth}×${raw.innerHeight}`,
              );
            }
            const measurement: PanelChromeMeasurement = {
              state: state.name,
              description: state.description,
              viewport,
              laneTop: raw.laneTop,
              headerHeight: raw.headerHeight,
              stripHeight: raw.stripHeight,
              stripState: raw.stripState,
              resetControls: raw.resetControls,
              stripLines: raw.stripLines,
              headerWrapped: raw.headerWrapped,
              panelFontSize: raw.panelFontSize,
              cards: raw.cards,
            };
            measurements.push(measurement);

            if (options.evidenceDir !== undefined) {
              const caption =
                `${options.label ?? "apps/web"} · state ${state.name} · ${viewport.width}×${viewport.height} · ` +
                `.cg-panel top = 0.00px · .cg-lane top = ${measurement.laneTop.toFixed(2)}px · ` +
                `panel font-size ${measurement.panelFontSize} · ${measurement.cards} cards · ` +
                `measured by apps/web/test/panel-chrome.ts in headless Chrome`;
              await evaluate<void>(cdp, annotation(measurement, caption));
              const shot = await cdp.command<{ data: string }>("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false,
              });
              const name = `${options.evidencePrefix ?? "panel-chrome"}-${state.name}-${viewport.width}x${viewport.height}.png`;
              await Bun.write(join(options.evidenceDir, name), Buffer.from(shot.data, "base64"));
              await evaluate<void>(
                cdp,
                `document.querySelectorAll('[data-cg-annotation]').forEach((node) => node.remove())`,
              );
            }
          }
        }
      } finally {
        await stopProcess(next);
      }
    }
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    hooks.stop(true);
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  }

  return measurements;
}

/** One line per measurement, for a test's output and for the PR comment. */
export function formatMeasurements(measurements: readonly PanelChromeMeasurement[]): string {
  return measurements
    .map(
      (m) =>
        `${m.state.padEnd(22)} ${String(m.viewport.width).padStart(4)}×${String(m.viewport.height).padEnd(5)} ` +
        `lane top ${m.laneTop.toFixed(2).padStart(7)}px  strip ${m.stripState.padEnd(9)} ` +
        `reset controls ${m.resetControls}  strip lines ${m.stripLines}  header wrapped ${m.headerWrapped}`,
    )
    .join("\n");
}

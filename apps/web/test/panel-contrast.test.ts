/**
 * Every text style on the panel, measured against the background it is actually
 * drawn on, at WCAG AA or better (#158: ≥ 4.5:1).
 *
 * ## Why this is a test and not a note on the PR
 *
 * The panel is projected. Contrast is not an accessibility box to tick here so
 * much as the difference between a rule id being readable from the back of a
 * room and not — and the two ways it decays are both invisible to the person
 * making the change. A colour is nudged, or a background is tinted a little
 * deeper, and every pair drawn on it moves at once. #158 found exactly that:
 * `--deny` red on the red hatched mask measured **3.08:1**, on the one element
 * whose whole job is being read as *withheld* rather than as a value.
 *
 * ## How it is grounded
 *
 * The colours are **parsed out of `app/globals.css`**, not copied here. Change
 * `--deny-tint` and this file recomputes; that is the whole point, and a table
 * of literals would have been a second source of truth that agrees with the
 * first until the day it matters.
 *
 * The pairs — which colour is drawn on which background — are written down,
 * because CSS does not say that anywhere a test could read. Each one names the
 * selector it stands for, so a pair that stops being true is a pair somebody has
 * to come and delete rather than one that quietly stops matching anything. That
 * failure mode, a rule that matches nothing and therefore permits everything, is
 * the one this repository is organised against.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");

type Rgba = readonly [number, number, number, number];

/** `--name` from the `:root` block, as parsed colour. Throws if it is not there. */
function token(name: string): Rgba {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  if (match === null) throw new Error(`globals.css declares no --${name}`);
  return parse((match[1] ?? "").trim());
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1] as string;
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
      1,
    ];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba !== null) {
    const parts = (rgba[1] as string).split(",").map((part) => Number(part.trim()));
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return [r, g, b, a];
  }
  throw new Error(`cannot parse the colour ${value}`);
}

/** Source over destination, both premultiplied by nothing — plain CSS layering. */
function over(source: Rgba, destination: Rgba): Rgba {
  const alpha = source[3];
  return [
    source[0] * alpha + destination[0] * (1 - alpha),
    source[1] * alpha + destination[1] * (1 - alpha),
    source[2] * alpha + destination[2] * (1 - alpha),
    1,
  ];
}

/** Stack of layers, bottom first. */
function stack(...layers: readonly Rgba[]): Rgba {
  return layers.reduce((below, above) => over(above, below));
}

function relativeLuminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

// --- the colours, read off the stylesheet ------------------------------------

const INK = token("ink");
const WHITE = token("white");
const NEUTRAL = token("neutral");
const CHARTREUSE = token("chartreuse");
const ALLOW = token("allow");
const DENY = token("deny");
const MODIFY = token("modify");

// --- the backgrounds, composed the way the browser composes them -------------

const CARD = {
  none: stack(INK, parse("rgba(255, 255, 255, 0.035)")),
  allow: stack(INK, token("allow-tint")),
  deny: stack(INK, token("deny-tint")),
  modify: stack(INK, token("modify-tint")),
} as const;

/** `.cg-rule` punches its chip out on near-black, over whichever card it is on. */
const CHIP = {
  allow: stack(CARD.allow, parse("rgba(0, 0, 0, 0.62)")),
  deny: stack(CARD.deny, parse("rgba(0, 0, 0, 0.62)")),
  modify: stack(CARD.modify, parse("rgba(0, 0, 0, 0.62)")),
} as const;

/**
 * The darkest point of the hatched mask: a stripe of `rgba(255,0,55,0.34)` over
 * the field's own `rgba(255,0,55,0.14)`, over the modify card it is drawn on.
 * Worst case rather than average, because the text crosses the stripes.
 */
const MASK = stack(CARD.modify, parse("rgba(255, 0, 55, 0.14)"), parse("rgba(255, 0, 55, 0.34)"));

const STRIP = {
  healthy: stack(INK, parse("rgba(255, 255, 255, 0.03)")),
  degraded: stack(INK, token("modify-tint")),
  unreachable: stack(INK, token("deny-tint")),
} as const;

const CONFIRM = stack(STRIP.healthy, parse("rgba(0, 0, 0, 0.45)"));
const BADGE_LIVE = CHARTREUSE;
const TAKEOVER = stack(INK, token("deny-tint"));

// --- every text style, and what it sits on -----------------------------------

interface Pair {
  readonly what: string;
  readonly fg: Rgba;
  readonly bg: Rgba;
}

const PAIRS: readonly Pair[] = [
  // The one row of chrome.
  { what: ".cg-title", fg: NEUTRAL, bg: INK },
  { what: ".cg-connection", fg: NEUTRAL, bg: INK },
  { what: ".cg-mode (fixture replay)", fg: NEUTRAL, bg: INK },
  { what: ".cg-mode[data-mode=hooks]", fg: INK, bg: BADGE_LIVE },
  { what: ".cg-mode[data-mode=unconfigured]", fg: DENY, bg: INK },

  // Lane headers — the structure.
  { what: ".cg-lane-name", fg: CHARTREUSE, bg: INK },
  { what: ".cg-lane-gloss", fg: NEUTRAL, bg: INK },
  { what: ".cg-lane-count (label)", fg: NEUTRAL, bg: INK },
  { what: ".cg-lane-count-value allow", fg: ALLOW, bg: INK },
  { what: ".cg-lane-count-value deny", fg: DENY, bg: INK },
  { what: ".cg-lane-count-value modify", fg: MODIFY, bg: INK },
  { what: ".cg-lane-behind", fg: NEUTRAL, bg: INK },
  { what: ".cg-lane-empty", fg: NEUTRAL, bg: INK },

  // A card, on each of the three tints it can carry.
  { what: ".cg-event-meta on allow", fg: NEUTRAL, bg: CARD.allow },
  { what: ".cg-event-meta on deny", fg: NEUTRAL, bg: CARD.deny },
  { what: ".cg-event-meta on modify", fg: NEUTRAL, bg: CARD.modify },
  { what: ".cg-event-count", fg: WHITE, bg: CARD.deny },
  { what: ".cg-tool on allow", fg: WHITE, bg: CARD.allow },
  { what: ".cg-tool on deny", fg: WHITE, bg: CARD.deny },
  { what: ".cg-tool on modify", fg: WHITE, bg: CARD.modify },
  // The tightest pair on the panel: a decision label on its own tint.
  { what: ".cg-decision allow", fg: ALLOW, bg: CARD.allow },
  { what: ".cg-decision deny", fg: DENY, bg: CARD.deny },
  { what: ".cg-decision modify", fg: MODIFY, bg: CARD.modify },
  { what: ".cg-rule on allow", fg: CHARTREUSE, bg: CHIP.allow },
  { what: ".cg-rule on deny", fg: CHARTREUSE, bg: CHIP.deny },
  { what: ".cg-rule on modify", fg: CHARTREUSE, bg: CHIP.modify },
  { what: ".cg-why summary", fg: NEUTRAL, bg: CARD.deny },
  { what: ".cg-reason", fg: WHITE, bg: CARD.deny },
  { what: ".cg-event-members", fg: NEUTRAL, bg: CARD.allow },
  { what: ".cg-event-members summary", fg: WHITE, bg: CARD.allow },
  { what: ".cg-event-ids", fg: NEUTRAL, bg: CARD.allow },

  // The listing card (#156), restyled in the same language by this slice.
  { what: ".cg-listing-tally allow", fg: ALLOW, bg: CARD.deny },
  { what: ".cg-listing-tally deny", fg: DENY, bg: CARD.deny },
  { what: ".cg-listing-hidden-tool", fg: WHITE, bg: CARD.deny },
  { what: ".cg-listing-none", fg: WHITE, bg: CARD.allow },
  { what: ".cg-listing-rest", fg: NEUTRAL, bg: CARD.deny },
  { what: ".cg-listing-note", fg: NEUTRAL, bg: CARD.deny },

  // Act 3's evidence.
  { what: ".cg-diff-path", fg: WHITE, bg: CARD.modify },
  { what: ".cg-diff-label", fg: NEUTRAL, bg: CARD.modify },
  { what: ".cg-diff-value after", fg: ALLOW, bg: CARD.modify },
  { what: ".cg-diff-absent", fg: NEUTRAL, bg: CARD.modify },
  { what: ".cg-diff-rule", fg: CHARTREUSE, bg: CARD.modify },
  { what: ".cg-diff-empty", fg: NEUTRAL, bg: CARD.modify },
  { what: ".cg-mask (darkest stripe)", fg: WHITE, bg: MASK },

  // The control plane's own health, in the header row.
  { what: ".cg-control-plane-badge healthy", fg: NEUTRAL, bg: STRIP.healthy },
  { what: ".cg-control-plane-badge degraded", fg: MODIFY, bg: STRIP.degraded },
  { what: ".cg-control-plane-badge unreachable", fg: DENY, bg: STRIP.unreachable },
  { what: ".cg-control-plane-line", fg: WHITE, bg: STRIP.degraded },
  { what: ".cg-control-plane-detail", fg: NEUTRAL, bg: STRIP.degraded },
  { what: ".cg-control-plane code", fg: CHARTREUSE, bg: STRIP.degraded },
  { what: ".cg-control-plane-button", fg: WHITE, bg: STRIP.healthy },
  { what: ".cg-control-plane-button[primary]", fg: CHARTREUSE, bg: CONFIRM },
  { what: ".cg-control-plane-confirm line", fg: WHITE, bg: CONFIRM },

  // The panel with no stream (#81) — it replaces the lanes, so it is on screen
  // alone when it is on screen at all.
  { what: ".cg-stream-error-title", fg: WHITE, bg: TAKEOVER },
  { what: ".cg-stream-error-problem", fg: WHITE, bg: TAKEOVER },
  { what: ".cg-stream-error-note", fg: NEUTRAL, bg: TAKEOVER },
  { what: ".cg-stream-error code", fg: CHARTREUSE, bg: TAKEOVER },
];

const AA = 4.5;

describe("every text style clears 4.5:1 against what it is drawn on", () => {
  for (const pair of PAIRS) {
    test(`${pair.what}`, () => {
      const measured = contrast(pair.fg, pair.bg);
      expect([pair.what, Number(measured.toFixed(2)) >= AA]).toEqual([pair.what, true]);
    });
  }

  /**
   * The list has to keep covering the panel. A pair silently disappearing would
   * leave this file passing over a surface it no longer describes — the same
   * shape of failure as a policy rule that matches nothing.
   */
  test("the table still covers every card state and both status strips", () => {
    const named = PAIRS.map((pair) => pair.what).join(" ");

    for (const required of [".cg-decision allow", ".cg-decision deny", ".cg-decision modify",
      ".cg-mask", ".cg-rule on deny", ".cg-control-plane-badge unreachable"]) {
      expect([required, named.includes(required)]).toEqual([required, true]);
    }
    expect(PAIRS.length).toBeGreaterThanOrEqual(50);
  });
});

/**
 * The measured numbers, printed rather than only asserted, because #158 asks
 * for the values on the PR and a number transcribed by hand from a spreadsheet
 * is a number nobody can check. `bun test apps/web/test/panel-contrast.test.ts`
 * prints the table this slice's evidence comment quotes.
 */
describe("the measured table", () => {
  test("prints every ratio", () => {
    const rows = PAIRS.map((pair) => `${pair.what.padEnd(38)} ${contrast(pair.fg, pair.bg).toFixed(2)}:1`);
    console.log(`\n${rows.join("\n")}\n`);

    const worst = PAIRS.map((pair) => ({ pair, ratio: contrast(pair.fg, pair.bg) })).sort(
      (a, b) => a.ratio - b.ratio,
    )[0];
    console.log(`tightest: ${worst?.pair.what} at ${worst?.ratio.toFixed(2)}:1\n`);

    expect(worst?.ratio ?? 0).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * The chrome above the first lane, pinned (#158, round 2).
 *
 * #158's whole instruction was *cut, do not add*, and the only way to say
 * whether it was followed is a number. Round 1 of PR #165 put that number in
 * the PR body and four cropped PNGs — the PNGs being exactly as tall as the
 * number they were offered as evidence for, which makes them the claim rather
 * than a check on it. This test is the check: it drives a real headless Chrome
 * against a real Next server and measures `.cg-lane`'s top relative to
 * `.cg-panel`'s, in three named states, at both of #158's viewports.
 *
 * Run it on its own with:
 *
 *     bun test apps/web/test/panel-chrome-height.test.ts
 *
 * `apps/web/test/panel-chrome.ts` has the harness and the reasons the states
 * are the states; `apps/web/scripts/panel-chrome-evidence.ts` runs the same
 * measurement with the screenshots turned on.
 *
 * ## Why a tolerance, and why it is this one
 *
 * The health strip is `align-items: baseline`, so its height depends on the
 * ascent of whichever font actually resolved. This laptop has GT Cinetype
 * installed and CI does not — there is no `@font-face`, the stack falls through
 * to Helvetica or Arial or whatever the runner ships. Measured, by overriding
 * `--font-ui` in the page: GT Cinetype gives 81.27px at 1920×1080, Helvetica
 * 79.27px, Arial 80.27px; at 1440×900 it is 62.42px against 60.42px. So the
 * spread a font can account for is about 2px, and `TOLERANCE` is 4px — twice
 * the observed spread, and an order of magnitude below anything a regression
 * would cost. Putting the global tally row back is +100px; letting the header
 * wrap to a second row is +30px. Neither could hide in here.
 *
 * The exact measurement is printed on every run, so the figure in the PR is
 * always re-derivable rather than remembered.
 */
import { expect, test } from "bun:test";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { formatMeasurements, measurePanelChrome, type PanelChromeMeasurement } from "./panel-chrome.ts";

const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

/**
 * Measured on 2026-09-18 at b54ec78, on macOS with GT Cinetype installed, by
 * the harness this test runs. Every figure here came out of
 * `getBoundingClientRect()` in headless Chrome; none was read off an image.
 *
 * The two live figures reproduce PR #165's round-1 reviewer exactly (69.45 /
 * 52.58 and 81.27 / 62.42), which is the point: the same two numbers from two
 * people who set the page up differently is a measurement, and a number only
 * one person has ever seen is not.
 */
const EXPECTED: Record<string, Record<string, number>> = {
  "fixture-replay": { "1920x1080": 62.47, "1440x900": 47.36 },
  "live-healthy-no-reset": { "1920x1080": 69.45, "1440x900": 52.58 },
  "live-healthy-reset": { "1920x1080": 81.27, "1440x900": 62.42 },
};

/** Twice the spread a font substitution was measured to account for. */
const TOLERANCE = 4;

const key = (m: PanelChromeMeasurement) => `${m.viewport.width}x${m.viewport.height}`;

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "the chrome above the first lane is the size the PR says it is, in real Chrome, in three named states",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));

    const measurements = await measurePanelChrome();
    console.log(`\n.cg-lane top relative to .cg-panel:\n${formatMeasurements(measurements)}\n`);

    // Every state, at every viewport, and no silent gaps: a matrix that
    // measured four of six cells would pass while saying nothing about the two
    // that regressed.
    expect(measurements.map((m) => `${m.state}@${key(m)}`).sort()).toEqual(
      [
        "fixture-replay@1440x900",
        "fixture-replay@1920x1080",
        "live-healthy-no-reset@1440x900",
        "live-healthy-no-reset@1920x1080",
        "live-healthy-reset@1440x900",
        "live-healthy-reset@1920x1080",
      ].sort(),
    );

    for (const measurement of measurements) {
      const expected = EXPECTED[measurement.state]?.[key(measurement)];
      expect(expected).toBeDefined();
      const drift = Math.abs(measurement.laneTop - (expected as number));
      if (drift > TOLERANCE) {
        throw new Error(
          `${measurement.state} at ${key(measurement)}: the chrome above the first lane measures ` +
            `${measurement.laneTop.toFixed(2)}px, and this test pins ${expected}px ±${TOLERANCE}. ` +
            `If the panel changed on purpose, re-measure with ` +
            `\`bun test apps/web/test/panel-chrome-height.test.ts\`, update EXPECTED, and update the ` +
            `figure on the PR — the number in the PR body and the number here are the same claim.`,
        );
      }

      // The panel is measured at the size it was asked for, not at whatever
      // headless Chrome defaulted to. `clamp(18px, 1.5vw, 30px)` is the panel's
      // root, and it is the reason the two viewports differ at all.
      expect(measurement.panelFontSize).toBe(measurement.viewport.width === 1920 ? "28.8px" : "21.6px");

      // The lanes are what the chrome is being measured against; a panel that
      // drew no cards would make every figure above meaningless.
      expect(measurement.cards).toBeGreaterThan(0);

      // #158's "one line of chrome at the top", asserted rather than admired.
      // This is the invariant the number rests on: the header holds one row,
      // and the strip's own sentence is one line inside it.
      expect(measurement.headerWrapped).toBe(false);
    }

    const byState = new Map(
      measurements.map((m) => [`${m.state}@${key(m)}`, m] as const),
    );

    // The states have to be distinguishable, or the matrix is measuring one
    // page three times. `fixture-replay` has no control plane behind it (#81),
    // so no strip; the two live states differ by the Reset control alone.
    for (const viewport of ["1920x1080", "1440x900"]) {
      const replay = byState.get(`fixture-replay@${viewport}`) as PanelChromeMeasurement;
      const noReset = byState.get(`live-healthy-no-reset@${viewport}`) as PanelChromeMeasurement;
      const reset = byState.get(`live-healthy-reset@${viewport}`) as PanelChromeMeasurement;

      expect(replay.stripState).toBe("none");
      expect(replay.resetControls).toBe(0);
      expect(noReset.stripState).toBe("healthy");
      expect(noReset.resetControls).toBe(0);
      expect(reset.stripState).toBe("healthy");
      expect(reset.resetControls).toBe(1);
      expect(noReset.stripLines).toBe(1);
      expect(reset.stripLines).toBe(1);

      // Ordered, and strictly: a health strip costs height, and the Reset
      // control costs more. If these ever tie, two of the three states have
      // stopped being different pages and the figures above stopped meaning
      // what they say.
      expect(replay.laneTop).toBeLessThan(noReset.laneTop);
      expect(noReset.laneTop).toBeLessThan(reset.laneTop);
    }
  },
  600_000,
);

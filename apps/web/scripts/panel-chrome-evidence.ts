/**
 * The screenshots behind #158's chrome measurement, and the JSON behind them.
 *
 * Round 1 of PR #165 offered four PNGs cropped to the exact height they were
 * evidence for, which is circular: a picture whose only content is the number
 * cannot check the number. These are full-viewport instead, with the measured
 * span drawn over the page — the caliper down the left edge spans exactly the
 * reported distance, the rule across the shot sits on `.cg-lane`'s top edge,
 * and the caption carries the figure, the state and the viewport. The number in
 * the picture is read out of the same `getBoundingClientRect()` call that
 * produces the number in the JSON, so the two cannot drift apart.
 *
 * Usage:
 *
 *     bun apps/web/scripts/panel-chrome-evidence.ts \
 *       --out docs/evidence --prefix 158-after --label "slice/158-panel-restyle"
 *
 * `--web-dir` runs a different checkout's `apps/web`, which is how the "before"
 * half is produced without editing anything:
 *
 *     git worktree add --detach /tmp/cg-before f4130c3
 *     (cd /tmp/cg-before && bun install)
 *     bun apps/web/scripts/panel-chrome-evidence.ts \
 *       --web-dir /tmp/cg-before/apps/web --out docs/evidence \
 *       --prefix 158-before --label "main at f4130c3"
 *
 * It starts a Next dev server and a headless Chrome on OS-assigned ports and
 * stops both; `cg-hooks` is the local stub in `test/panel-chrome.ts`. Nothing is
 * deployed, provisioned or authenticated, and no reset is ever POSTed.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  formatMeasurements,
  measurePanelChrome,
  PANEL_STATES,
  type PanelChromeMeasurement,
} from "../test/panel-chrome.ts";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

const outDir = resolve(flag("out"));
const prefix = flag("prefix");
const label = flag("label", "apps/web");
const webDir = process.argv.includes("--web-dir") ? resolve(flag("web-dir")) : undefined;
/** `--state live-healthy-reset,live-healthy-no-reset` narrows the run; absent means all of them. */
const only = process.argv.includes("--state") ? flag("state").split(",").map((name) => name.trim()) : undefined;

mkdirSync(outDir, { recursive: true });

const states = only === undefined ? PANEL_STATES : PANEL_STATES.filter((state) => only.includes(state.name));
if (states.length === 0) throw new Error(`no state named ${only?.join(", ")}`);

const measurements: PanelChromeMeasurement[] = await measurePanelChrome({
  ...(webDir === undefined ? {} : { webDir }),
  states,
  evidenceDir: outDir,
  evidencePrefix: prefix,
  label,
});

console.log(`\n.cg-lane top relative to .cg-panel — ${label}\n${formatMeasurements(measurements)}\n`);
console.log(`wrote ${measurements.length} screenshots to ${outDir}`);
console.log(JSON.stringify({ label, webDir: webDir ?? "apps/web", measurements }, null, 2));

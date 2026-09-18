/**
 * Where the browser regression finds a browser (#152).
 *
 * The committed form of `home-loan-next-browser.test.ts` looked only at
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, so on
 * `ubuntu-latest` it did not run — and said nothing about not running. A
 * regression that silently skips in the only environment that gates merges is
 * the same failure this repo keeps naming elsewhere: a control that matches
 * nothing is indistinguishable from a control that permits.
 *
 * So resolution is explicit and its result is reportable:
 *
 * - `CG_CHROME_BIN` wins, always. An override that points at nothing is an
 *   error rather than a fallback — someone asked for a specific binary.
 * - Otherwise the usual command names are looked up on `PATH`
 *   (`google-chrome`, `google-chrome-stable`, `chromium`, …), then the
 *   platform's usual absolute paths. That covers `browser-actions/setup-chrome`
 *   and a distro package on Linux and a developer laptop on macOS.
 * - Nothing found is only skippable off CI. `browserRequired()` says when a
 *   miss has to fail instead, and the skip prints where it looked.
 */
import { existsSync } from "node:fs";

/** Command names, tried on `PATH` first because that is what CI installs. */
const COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

const PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export interface ChromeResolution {
  /** The executable, or `null` when this machine has none. */
  path: string | null;
  /** Everything that was tried, in order, so a miss can say where it looked. */
  searched: string[];
}

/**
 * Resolve a Chrome/Chromium executable.
 *
 * `env` and `platform` are parameters rather than reads of the ambient process
 * so `chrome.test.ts` can exercise the macOS and Linux branches from either
 * machine — the portability claim in #152 is otherwise only ever tested on
 * whichever laptop ran it last.
 */
export function resolveChrome(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  which: (command: string) => string | null = (command) => Bun.which(command),
): ChromeResolution {
  const override = env.CG_CHROME_BIN?.trim();
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(`CG_CHROME_BIN points at ${override}, which does not exist`);
    }
    return { path: override, searched: [override] };
  }

  const searched: string[] = [];
  for (const command of COMMANDS) {
    searched.push(`${command} (on PATH)`);
    const found = which(command);
    if (found !== null && found !== "" && exists(found)) return { path: found, searched };
  }
  for (const candidate of PATHS[platform] ?? []) {
    searched.push(candidate);
    if (exists(candidate)) return { path: candidate, searched };
  }
  return { path: null, searched };
}

/**
 * Is a missing browser a failure rather than a skip?
 *
 * Yes on any CI, and yes whenever someone asks for it by hand. A developer
 * laptop without Chrome is the only case that may skip, and #152 is explicit
 * that it must say so out loud.
 */
export function browserRequired(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CG_REQUIRE_BROWSER === "1") return true;
  if (env.CG_REQUIRE_BROWSER === "0") return false;
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

/** The sentence a skip prints, so a silent skip is never what happens. */
export function missingBrowserMessage(resolution: ChromeResolution): string {
  return [
    "No Chrome or Chromium executable found, so the production Next browser regression",
    "(apps/web/test/home-loan-next-browser.test.ts) cannot run. Set CG_CHROME_BIN to one,",
    "or install Chrome. Looked at:",
    ...resolution.searched.map((entry) => `  - ${entry}`),
  ].join("\n");
}

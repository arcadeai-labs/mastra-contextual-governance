/**
 * #152: the browser regression has to find a browser on both machines that
 * matter — a developer's macOS laptop and `ubuntu-latest` — and a miss has to
 * be loud rather than a silent skip. Both platform branches are exercised from
 * whichever platform is running this file, because a portability claim only
 * ever tested on the author's laptop is not a portability claim.
 */
import { describe, expect, test } from "bun:test";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";

/** Nothing on `PATH`, so only the absolute-path branch can answer. */
const noPath = () => null;

describe("resolveChrome", () => {
  test("prefers CG_CHROME_BIN over everything else", () => {
    const resolution = resolveChrome(
      { CG_CHROME_BIN: "/opt/custom/chrome" },
      "linux",
      (path) => path === "/opt/custom/chrome" || path === "/usr/bin/google-chrome",
      () => "/usr/bin/google-chrome",
    );
    expect(resolution.path).toBe("/opt/custom/chrome");
  });

  test("refuses a CG_CHROME_BIN that does not exist instead of falling back", () => {
    expect(() => resolveChrome({ CG_CHROME_BIN: "/nope/chrome" }, "linux", () => false, noPath)).toThrow(
      /CG_CHROME_BIN points at \/nope\/chrome/,
    );
  });

  test("finds the macOS application bundle", () => {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const resolution = resolveChrome({}, "darwin", (path) => path === mac, noPath);
    expect(resolution.path).toBe(mac);
  });

  test("finds a Linux install through PATH, the way setup-chrome provides one", () => {
    const resolution = resolveChrome(
      {},
      "linux",
      (path) => path === "/opt/hostedtoolcache/chromium/chrome",
      (command) => (command === "google-chrome" ? "/opt/hostedtoolcache/chromium/chrome" : null),
    );
    expect(resolution.path).toBe("/opt/hostedtoolcache/chromium/chrome");
  });

  test("finds a Linux distro package when PATH has nothing", () => {
    const resolution = resolveChrome({}, "linux", (path) => path === "/usr/bin/chromium", noPath);
    expect(resolution.path).toBe("/usr/bin/chromium");
  });

  test("reports every place it looked when there is no browser", () => {
    const resolution = resolveChrome({}, "linux", () => false, noPath);
    expect(resolution.path).toBeNull();
    expect(resolution.searched).toContain("google-chrome (on PATH)");
    expect(resolution.searched).toContain("/usr/bin/chromium");
    expect(missingBrowserMessage(resolution)).toContain("/usr/bin/chromium");
    expect(missingBrowserMessage(resolution)).toContain("CG_CHROME_BIN");
  });

  test("resolves an executable on the machine running this suite, or says why not", () => {
    const resolution = resolveChrome();
    if (resolution.path === null) expect(resolution.searched.length).toBeGreaterThan(0);
    else expect(resolution.path.length).toBeGreaterThan(0);
  });
});

describe("browserRequired", () => {
  test("a missing browser fails rather than skips on CI", () => {
    expect(browserRequired({ CI: "true" })).toBe(true);
    expect(browserRequired({ GITHUB_ACTIONS: "true" })).toBe(true);
  });

  test("a developer laptop may skip", () => {
    expect(browserRequired({})).toBe(false);
  });

  test("either side can be demanded by hand", () => {
    expect(browserRequired({ CG_REQUIRE_BROWSER: "1" })).toBe(true);
    expect(browserRequired({ CI: "true", CG_REQUIRE_BROWSER: "0" })).toBe(false);
  });
});

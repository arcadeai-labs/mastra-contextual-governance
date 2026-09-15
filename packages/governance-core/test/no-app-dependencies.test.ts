/**
 * The forkability boundary, enforced rather than documented.
 *
 * `packages/governance-core` must never reach into an app. If it does, a forker
 * cannot replace the governed app with their own business system without
 * rewriting the governance layer — which is the whole promise of the template.
 *
 * Two layers here. `importedSpecifiers` is pure and has its own coverage table,
 * because a guard that silently stops recognising a syntax form is worse than
 * no guard: the first suite below pins every form that can create a dependency.
 * The second walks the real package.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

/**
 * Every module specifier in `source`, across all five forms that create a
 * dependency: `from "x"` (static import and re-export), bare `import "x"`,
 * dynamic `import("x")`, and `require("x")`.
 *
 * The dynamic-import branch is ordered before the bare-import branch so
 * `import("x")` is not mistaken for `import "x"`.
 */
export function importedSpecifiers(source: string): string[] {
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

/** Does `specifier` address `app`, by package name or by path into `apps/`? */
function addressesApp(specifier: string, apps: readonly string[]): boolean {
  return (
    apps.some((app) => specifier === app || specifier.startsWith(`${app}/`)) ||
    specifier.includes("apps/")
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Package names declared by everything under `apps/`.
 *
 * A directory with no `package.json` is skipped rather than thrown on. Renames
 * leave the old directory behind holding an untracked `node_modules/` — the
 * `apps/records-mcp` → `apps/records-app` rename in #34 did exactly that — and an
 * ENOENT here reads as a broken build rather than as stale scratch. Two people
 * lost time to it on the same day (#41). `packages/policy-schema`'s workspace
 * sweep already guards this way.
 */
function appPackageNames(): string[] {
  const appsDir = join(REPO_ROOT, "apps");
  return readdirSync(appsDir)
    .filter((entry) => statSync(join(appsDir, entry)).isDirectory())
    .filter((entry) => existsSync(join(appsDir, entry, "package.json")))
    .map((entry) => readJson(join(appsDir, entry, "package.json")).name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Every TypeScript file in the package — not just `src/`, so a new top-level
 * directory cannot slip past the guard by existing.
 *
 * This file is skipped: the coverage table below contains violating specifiers
 * as literal test data, and scanning them would trip the guard on itself.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "node_modules") return [];
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) return [];
    return basename(path) === basename(import.meta.path) ? [] : [path];
  });
}

describe("importedSpecifiers recognises every form that creates a dependency", () => {
  // A stand-in app name. Deliberately not a real one: `packages/` carries no
  // business-domain vocabulary, and #24 greps for it.
  const APP = "@cg/governed-app";

  const cases: ReadonlyArray<readonly [label: string, source: string]> = [
    ["static import", `import { x } from "${APP}";`],
    ["type-only import", `import type { X } from "${APP}";`],
    ["default import", `import x from "${APP}";`],
    ["namespace import", `import * as x from "${APP}";`],
    ["re-export", `export * from "${APP}";`],
    ["named re-export", `export { x } from "${APP}";`],
    ["bare side-effect import", `import "${APP}";`],
    ["dynamic import", `const m = await import("${APP}");`],
    ["dynamic import, spaced", `const m = await import ( "${APP}" );`],
    ["require", `const m = require("${APP}");`],
    ["single quotes", `import { x } from '${APP}';`],
  ];

  for (const [label, source] of cases) {
    it(`catches a ${label}`, () => {
      expect(importedSpecifiers(source)).toContain(APP);
    });
  }

  it("catches a relative path that climbs into apps/", () => {
    const source = `import { x } from "../../../apps/governed-app/src/index.ts";`;
    const [specifier] = importedSpecifiers(source);
    expect(specifier).toBeDefined();
    expect(addressesApp(specifier as string, [APP])).toBe(true);
  });

  it("leaves innocent specifiers alone", () => {
    const source = [
      `import { z } from "zod";`,
      `import { readFileSync } from "node:fs";`,
      `import type { Decision } from "@cg/policy-schema";`,
    ].join("\n");
    const specifiers = importedSpecifiers(source);
    expect(specifiers).toEqual(["zod", "node:fs", "@cg/policy-schema"]);
    expect(specifiers.some((s) => addressesApp(s, [APP]))).toBe(false);
  });
});

describe("governance-core is independent of every app", () => {
  const apps = appPackageNames();

  it("finds the apps it is supposed to stay away from", () => {
    // Guards the two checks below: if the lookup silently found nothing they
    // would pass vacuously.
    expect(apps.length).toBeGreaterThan(0);
  });

  it("declares no dependency on an app package", () => {
    const manifest = readJson(join(PACKAGE_ROOT, "package.json"));
    const declared = new Set(
      (
        [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ] as const
      ).flatMap((field) => Object.keys((manifest[field] ?? {}) as object)),
    );

    expect(apps.filter((app) => declared.has(app))).toEqual([]);
  });

  it("imports nothing from an app, in any file or any syntax", () => {
    const files = sourceFiles(PACKAGE_ROOT);
    // Same vacuity guard: an empty walk must not read as a pass.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.flatMap((file) =>
      importedSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => addressesApp(specifier, apps))
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });
});

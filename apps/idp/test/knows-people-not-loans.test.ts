/**
 * This service knows people, not loans and not policy. It is the enterprise's
 * identity provider, standing in for the real one, and a forker deletes it —
 * so nothing in the template may depend on it and it must depend on nothing in
 * the template.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Comments are stripped before matching, as in the loan book's sibling test:
 * a comment's job here is partly to say what this service does *not* know.
 * Block comments and whole-line `//` comments only.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files = [];
  for (const dir of ["src", "scripts"]) {
    for await (const path of new Glob("**/*.ts").scan(join(ROOT, dir))) {
      files.push({
        path: `${dir}/${path}`,
        text: stripComments(await Bun.file(join(ROOT, dir, path)).text()),
      });
    }
  }
  return files;
}

describe("apps/idp knows people, not loans", () => {
  test.each([
    ["loan", /\bloans?\b/i],
    ["borrower", /\bborrower/i],
    ["underwriter", /\bunderwrit/i],
    ["approve", /\bapprov(e|al)/i],
  ])("no source file mentions %s", async (_word, pattern) => {
    const offenders = (await sourceFiles()).filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("imports nothing from the governance packages", async () => {
    const offenders = (await sourceFiles())
      .filter((f) => /from\s+["']@cg\//.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("declares no @cg/* dependency and is flagged external for the policy-schema sweep", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(declared.filter((name) => name.startsWith("@cg/"))).toEqual([]);
    expect(manifest.cg?.external).toBe(true);
  });

  /**
   * The other half. Until #187 this service sat outside the root workspace,
   * which made depending on it impossible by construction. It is a member now,
   * so the rule has to be stated: no other workspace declares it, and no other
   * workspace's source imports it by name or by relative path.
   */
  test("nothing else in the template depends on it", async () => {
    const REPO = join(ROOT, "..", "..");
    const name = (await Bun.file(join(ROOT, "package.json")).json()).name as string;

    const manifests: string[] = [];
    for await (const path of new Glob("{apps,packages}/*/package.json").scan(REPO)) {
      if (path !== "apps/idp/package.json") manifests.push(path);
    }
    // Vacuous if the scan found nothing to check.
    expect(manifests.length).toBeGreaterThan(0);

    const declaring = [];
    for (const path of manifests) {
      const manifest = await Bun.file(join(REPO, path)).json();
      if (name in { ...manifest.dependencies, ...manifest.devDependencies }) declaring.push(path);
    }
    expect(declaring).toEqual([]);

    const importing = [];
    let scanned = 0;
    const specifier = new RegExp(`from\\s+["'](${name}(/[^"']*)?|[^"']*apps/idp/[^"']*|(\\.\\./)+idp/[^"']*)["']`);
    for await (const path of new Glob("{apps,packages}/*/{src,lib,app,scripts}/**/*.{ts,tsx}").scan(REPO)) {
      if (path.startsWith("apps/idp/")) continue;
      scanned += 1;
      if (specifier.test(stripComments(await Bun.file(join(REPO, path)).text()))) importing.push(path);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(importing).toEqual([]);
  });
});

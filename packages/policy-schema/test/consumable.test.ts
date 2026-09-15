/**
 * The package is only "the frozen contract every other slice builds against"
 * if every other slice can actually import it. Four things have to hold, and
 * all four are the kind that break silently in a monorepo.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { version as zodVersion } from "zod/package.json";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const PACKAGE_NAME = "@cg/policy-schema";

interface Manifest {
  name?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  /** See `isGoverned` and `isExternal`. */
  cg?: { governed?: boolean; external?: boolean };
}

/**
 * The business system under governance opts out of this package entirely.
 *
 * It is the one workspace that must *not* be able to import the governance
 * vocabulary: `DESIGN.md` promises that forking means replacing the governed
 * app and "touching nothing under `packages/`", and that only holds if the
 * dependency does not run the other way. `apps/records-app` enforces its own half
 * in `test/knows-nothing-about-governance.test.ts`.
 *
 * Read off a flag rather than matched on a name on purpose — `packages/`
 * carries no business-domain vocabulary, and a forker marking their own app
 * `"cg": { "governed": true }` inherits both halves of the boundary.
 */
function isGoverned(manifest: Manifest): boolean {
  return manifest.cg?.governed === true;
}

/**
 * A stand-in for a system outside the template — `apps/idp`, the enterprise's
 * identity provider (#36). A forker deletes it and points at their own, so it
 * neither depends on anything under `packages/` nor is depended on. It is not
 * a workspace member either (it needs zod 4, which the root override forbids),
 * but this sweep reads directories rather than the workspace list, so it has
 * to be exempted here by the same kind of flag.
 */
function isExternal(manifest: Manifest): boolean {
  return manifest.cg?.external === true;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Every workspace manifest in the repo, keyed by directory. */
function workspaces(): Array<{ dir: string; manifest: Manifest }> {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group))
      .map((entry) => join(REPO_ROOT, group, entry))
      .filter((dir) => statSync(dir).isDirectory())
      .filter((dir) => existsSync(join(dir, "package.json")))
      .map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) })),
  );
}

describe("resolvable by package name", () => {
  it("exposes every schema the contract promises", async () => {
    // By name, not by relative path: this is how every consumer imports it, and
    // it is what exercises the workspace link and the `exports` map.
    const contract = (await import(PACKAGE_NAME)) as Record<string, { parse?: unknown }>;

    for (const name of [
      "Subject",
      "PolicyRule",
      "OutputRule",
      "RedactionRecord",
      "RedactionKind",
      "Decision",
      "Grant",
      "ApprovalRequest",
      "GovernanceEvent",
      "PreHookRequest",
      "PreHookResult",
      "PostHookRequest",
      "PostHookResult",
      "AccessHookRequest",
      "AccessHookResult",
    ]) {
      expect(typeof contract[name]?.parse).toBe("function");
    }
  });

  it("exposes the fixture builders the UI lane and the pure modules need", async () => {
    const contract = (await import(PACKAGE_NAME)) as Record<string, unknown>;
    for (const name of [
      "aSubject",
      "aPolicyRule",
      "anOutputRule",
      "aRedactionRecord",
      "aDecision",
      "aGrant",
      "anApprovalRequest",
      "aGovernanceEvent",
      "aGovernanceEventSequence",
      "aHookExchange",
    ]) {
      expect(typeof contract[name]).toBe("function");
    }
  });
});

describe("consumable without a build step", () => {
  it("points its export map at source that exists", () => {
    const manifest = readJson(join(PACKAGE_ROOT, "package.json"));
    const entry = manifest.exports?.["."];
    expect(entry).toBeDefined();
    expect(existsSync(join(PACKAGE_ROOT, entry as string))).toBe(true);
  });

  it("is declared by every workspace that may consume it", () => {
    // "Consumable from every workspace" is the acceptance criterion, and a
    // workspace that does not declare the dependency cannot import it —
    // `bun -e 'import ... from "@cg/policy-schema"'` exits 1 there. Checking
    // only the workspaces that already declare it would make this vacuous.
    //
    // A version range rather than `workspace:*` would resolve against the
    // registry, where this private package does not exist, and would fail only
    // at install time in CI.
    //
    // Governed apps are exempt, and that is the point rather than a hole: see
    // `isGoverned`. This sweep originally covered them too, which put a
    // governance dependency inside the business system the demo claims cannot
    // influence its own governance. #33.
    const consumers = workspaces().filter(
      ({ manifest }) =>
        manifest.name !== PACKAGE_NAME && !isGoverned(manifest) && !isExternal(manifest),
    );

    expect(consumers.length).toBeGreaterThan(0);

    for (const { dir, manifest } of consumers) {
      expect(`${dir}: ${manifest.dependencies?.[PACKAGE_NAME]}`).toBe(
        `${dir}: workspace:*`,
      );
    }
  });

  it("is not declared by an external stand-in either", () => {
    for (const { dir, manifest } of workspaces().filter(({ manifest }) => isExternal(manifest))) {
      expect(`${dir}: ${manifest.dependencies?.[PACKAGE_NAME]}`).toBe(`${dir}: undefined`);
    }
  });

  it("is not declared by the governed app, whatever it is called", () => {
    const governed = workspaces().filter(({ manifest }) => isGoverned(manifest));

    // If this is empty the exemption above has gone vacuous — a renamed or
    // un-flagged app would silently rejoin the sweep and reacquire the
    // dependency the boundary forbids.
    expect(governed.length).toBeGreaterThan(0);

    for (const { dir, manifest } of governed) {
      expect(`${dir}: ${manifest.dependencies?.[PACKAGE_NAME]}`).toBe(
        `${dir}: undefined`,
      );
    }
  });
});

describe("Zod 3", () => {
  it("resolves zod 3, not 4", () => {
    // Zod 4 changes internals the Arcade/Mastra path does not support yet, so
    // the root manifest overrides every transitive copy to one 3.x version.
    expect(zodVersion.startsWith("3.")).toBe(true);
  });

  it("pins the same zod version the rest of the repo pins", () => {
    const pinned = readJson(join(REPO_ROOT, "package.json")).overrides?.zod;
    expect(pinned).toMatch(/^3\./);
    expect(readJson(join(PACKAGE_ROOT, "package.json")).dependencies?.zod).toBe(pinned);
  });
});

/**
 * Three faces, three jobs, and the display face has exactly one selector.
 *
 * #158's rule is "at most one display face (lane titles), one sans, one mono",
 * and it asks for it to be *asserted* rather than eyeballed — which is the
 * right instinct, because this is the kind of rule that decays one reasonable
 * change at a time. Before this slice the serif set the panel title, the
 * decision label, the global tally numerals and the per-lane counters, and
 * every one of those was a defensible-looking line on its own.
 *
 * So the stylesheet is read as text and its `font-family` declarations are
 * counted. That is a class test rather than a rendering test on purpose: no
 * browser here has GT Sectra installed, so a screenshot cannot tell the rule
 * from its fallback, while the declaration is the thing the rule is actually
 * about.
 *
 * Scoped to `app/globals.css`, which is the panel's whole stylesheet. The bank
 * app (`components/bank/bank.css`) is a deliberately different visual language
 * — DESIGN.md: "bank app deliberately boring enterprise UI; control plane
 * unmistakably Arcade" — and is not what this rule governs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "..", "app", "globals.css"), "utf8");

/** Every `selector { … font-family: X … }` in the sheet, as (selector, face). */
function fontFamilyRules(): Array<{ selector: string; face: string }> {
  const rules: Array<{ selector: string; face: string }> = [];
  // Rule bodies are flat here — no nesting — so a brace pair is a rule.
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, rawSelector = "", body = ""] = match;
    const declaration = /font-family:\s*([^;]+);/.exec(body);
    if (declaration === null) continue;
    // Drop comments, then collapse whitespace, so a commented selector cannot
    // be mistaken for a real one.
    const selector = rawSelector.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " ");
    rules.push({ selector, face: (declaration[1] ?? "").trim() });
  }
  return rules;
}

/** The token definitions themselves: `--font-display: …` and friends. */
function declaredFaces(): string[] {
  return [...CSS.matchAll(/--font-([a-z]+):/g)].map(([, name]) => `--font-${name}`);
}

describe("the panel declares three faces and no more", () => {
  test("display, ui and mono, and nothing else", () => {
    expect(new Set(declaredFaces())).toEqual(
      new Set(["--font-display", "--font-ui", "--font-mono"]),
    );
  });

  test("every font-family in the sheet is one of those three tokens", () => {
    const faces = fontFamilyRules().filter(({ selector }) => !selector.startsWith(":root"));

    for (const { selector, face } of faces) {
      expect([selector, face]).toEqual([
        selector,
        expect.stringMatching(/^var\(--font-(display|ui|mono)\)$/) as unknown as string,
      ]);
    }
    expect(faces.length).toBeGreaterThan(10);
  });
});

describe("the display face has one job", () => {
  test("exactly one selector claims it, and it is the lane title", () => {
    const display = fontFamilyRules().filter(({ face }) => face === "var(--font-display)");

    expect(display.map(({ selector }) => selector)).toEqual([".cg-lane-name"]);
  });

  /**
   * The four that used to. Named individually rather than as "not display",
   * because the regression this guards against is one of them coming back on
   * its own — and `.cg-stat-value` is on the list so that reintroducing the
   * global tally row cannot slip past in the serif it used to wear.
   */
  test("the panel title, the decision label and the counters are the sans", () => {
    const by = new Map(fontFamilyRules().map(({ selector, face }) => [selector, face]));

    expect(by.get(".cg-title")).toBe("var(--font-ui)");
    expect(by.get(".cg-decision")).toBe("var(--font-ui)");
    expect(by.get(".cg-lane-count-value")).toBe("var(--font-ui)");
    expect(by.get(".cg-listing-tallies")).toBe("var(--font-ui)");
    expect(by.has(".cg-stat-value")).toBe(false);
  });
});

describe("mono is identifiers, and identifiers are mono", () => {
  /**
   * The load-bearing half of "mono only for identifiers" is the *only*: every
   * slot that carries a tool, a rule, a user, a time or an event id is
   * monospace, and this is the list of them. A reason or a gloss appearing here
   * would mean prose had been dressed as an identifier, which is the confusion
   * the three roles exist to prevent.
   */
  test("every identifier slot on a card is monospace", () => {
    const by = new Map(fontFamilyRules().map(({ selector, face }) => [selector, face]));

    for (const selector of [".cg-tool", ".cg-rule", ".cg-event-meta", ".cg-event-ids",
      ".cg-listing-hidden-tool", ".cg-diff-path", ".cg-diff-value", ".cg-diff-rule", ".cg-mask"]) {
      expect([selector, by.get(selector)]).toEqual([selector, "var(--font-mono)"]);
    }
  });

  test("and no prose slot is", () => {
    const by = new Map(fontFamilyRules().map(({ selector, face }) => [selector, face]));

    for (const selector of [".cg-reason", ".cg-lane-gloss", ".cg-listing-note"]) {
      expect([selector, by.get(selector)]).not.toEqual([selector, "var(--font-mono)"]);
    }
  });
});

/**
 * The role and authority beside a persona's name, and where they come from.
 *
 * Two properties, and the first one is the one that would rot quietly.
 *
 * **The table does not drift from the policy.** `apps/web` carries its own copy
 * of each persona's `role` and `clearance` because it does not depend on
 * `apps/hooks` in the package graph and should not start to — the same trade
 * `lib/config.ts` makes for `DEV_STORE_TOKEN`, with the same remedy: this file
 * reads the other service's seed fixture and fails when the two disagree. A UI
 * that said "$50,000" while the policy seeded something else would be a control
 * surface misreporting the control.
 *
 * **The address comes from the environment.** Never from this repo. Four
 * variables, the same four `apps/idp` and `apps/hooks` seed from, so the string
 * on screen is the string the hooks decide on (`DESIGN.md` rule 3).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERSONAS } from "../lib/identity/personas.ts";
import {
  formatAuthority,
  personaEmailVariable,
  personaFor,
  roster,
  unconfiguredPersonas,
} from "../lib/identity/roster.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface SeedSubject {
  persona: string;
  display_name: string;
  role: string;
  clearance: number;
}

function seededSubjects(): SeedSubject[] {
  const path = join(REPO_ROOT, "apps", "hooks", "src", "fixtures", "governance.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { subjects: SeedSubject[] }).subjects;
}

describe("the role/limit table matches what apps/hooks seeds", () => {
  test("same four people, same roles, same clearances", () => {
    const seeded = seededSubjects();

    expect(PERSONAS.map((persona) => persona.key)).toEqual(seeded.map((subject) => subject.persona));
    for (const subject of seeded) {
      const persona = PERSONAS.find((each) => each.key === subject.persona);
      expect(persona).toBeDefined();
      expect(persona?.name).toBe(subject.display_name);
      // `roleKey` is what `access.analysts-cannot-see-approve` matches on;
      // `role` is what a person reads. Only the first can be wrong silently.
      expect(persona?.roleKey).toBe(subject.role);
      expect(persona?.clearance).toBe(subject.clearance);
    }
  });

  test("the cast is DESIGN.md's, figures included", () => {
    // Written out rather than derived, so an edit to both the fixture and the
    // table still has to be a deliberate edit to `DESIGN.md` → Cast as well.
    expect(PERSONAS.map((persona) => [persona.name, persona.role, persona.clearance])).toEqual([
      ["Dana Okafor", "Loan Officer", 50_000],
      ["Sam Reyes", "Credit Analyst", 0],
      ["Riley Chen", "VP Credit", 250_000],
      ["Morgan Ellis", "Chief Credit Officer", 5_000_000],
    ]);
  });

  test("no email is written down here", () => {
    // The buttons name a persona; the identity is whatever the IdP asserts.
    // A hardcoded address would be one refactor away from being trusted.
    const source = readFileSync(join(import.meta.dir, "..", "lib", "identity", "personas.ts"), "utf8");
    expect(source).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});

describe("looking a persona up from the address the IdP asserted", () => {
  const env = {
    PERSONA_DANA_EMAIL: "Dana.Okafor@megaforce.example",
    PERSONA_SAM_EMAIL: "sam.reyes@megaforce.example",
  };

  test("the address is matched case-insensitively, as the join key is everywhere else", () => {
    // #58: `PERSONA_<KEY>_EMAIL` carries whatever capitalisation somebody
    // typed, and the session's email is lowercase. A roster keyed on the raw
    // value is a roster the lookup can never hit.
    expect(personaFor("dana.okafor@megaforce.example", env)?.key).toBe("dana");
    expect(personaFor("  DANA.OKAFOR@MEGAFORCE.EXAMPLE  ", env)?.key).toBe("dana");
  });

  test("an address the environment does not name is null, never a guess", () => {
    expect(personaFor("someone.else@megaforce.example", env)).toBeNull();
    expect(personaFor("", env)).toBeNull();
    expect(personaFor(null, env)).toBeNull();
    // Not a fallback to the first persona, and not a blank authority: the card
    // says it cannot name this person rather than labelling them wrongly.
    expect(roster(env).size).toBe(2);
  });

  test("the unset variables are reported, so 'unknown persona' is not mistaken for a bug", () => {
    expect(unconfiguredPersonas(env)).toEqual(["PERSONA_RILEY_EMAIL", "PERSONA_MORGAN_EMAIL"]);
    expect(unconfiguredPersonas({})).toHaveLength(4);
    expect(personaEmailVariable("morgan")).toBe("PERSONA_MORGAN_EMAIL");
  });

  test("a blank variable is unset, not an address", () => {
    expect(personaFor("dana.okafor@megaforce.example", { PERSONA_DANA_EMAIL: "   " })).toBeNull();
  });
});

describe("the authority as a person reads it", () => {
  test("dollars with separators, and zero says zero", () => {
    expect(formatAuthority(50_000)).toBe("$50,000");
    expect(formatAuthority(0)).toBe("$0");
    expect(formatAuthority(5_000_000)).toBe("$5,000,000");
  });
});

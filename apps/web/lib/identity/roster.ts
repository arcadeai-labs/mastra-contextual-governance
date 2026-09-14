/**
 * Email → the person, for display only.
 *
 * The sign-in panel's buttons carry no email on purpose (`personas.ts`): the
 * identity on the session is the one `apps/idp` asserted, never the one a
 * browser picked. This module runs in the opposite direction — it takes an
 * address that is *already* on the sealed session and finds the name, role and
 * seeded authority to put next to it.
 *
 * That direction is what makes it safe, and it is the only direction offered.
 * There is no `emailFor(persona)` here, because a caller holding one would be
 * one refactor away from signing somebody in as a persona the browser named.
 *
 * ## The addresses come from the environment
 *
 * `PERSONA_DANA_EMAIL`, `PERSONA_SAM_EMAIL`, `PERSONA_RILEY_EMAIL`,
 * `PERSONA_MORGAN_EMAIL` — the same four variables `apps/idp` and `apps/hooks`
 * seed from, so the address on screen, the OAuth subject, Arcade's `user_id`
 * and `governance.db`'s subject row are one string (`DESIGN.md` rule 3). None
 * of them is written down in this repo and none is defaulted here.
 *
 * ## An unknown address is said out loud
 *
 * `null`, and the card says the deployment's `PERSONA_*_EMAIL` names nobody at
 * this address. The alternative — falling back to the first persona, or showing
 * a blank authority — would put a role and a dollar figure next to a person the
 * control plane may know nothing about, on a screen whose whole job is to say
 * who the agent is acting as. A label that can be wrong is worse than a label
 * that is missing.
 */
import { PERSONAS, type PersonaButton } from "./personas.ts";

/** `dana` → `PERSONA_DANA_EMAIL`. */
export function personaEmailVariable(key: string): string {
  return `PERSONA_${key.toUpperCase()}_EMAIL`;
}

/**
 * Every persona this deployment configured an address for, keyed by the
 * lowercased address.
 *
 * Lowercased on the way in by the same rule `apps/hooks` applies on the way out
 * (#58): `PERSONA_<KEY>_EMAIL` carries whatever capitalisation somebody typed,
 * and a roster keyed on `Dana.Okafor@…` is a roster the lookup can never hit.
 */
export function roster(env: Record<string, string | undefined> = process.env): Map<string, PersonaButton> {
  const entries = new Map<string, PersonaButton>();
  for (const persona of PERSONAS) {
    const email = env[personaEmailVariable(persona.key)]?.trim().toLowerCase();
    if (email) entries.set(email, persona);
  }
  return entries;
}

/** The persona at this address, or `null` when the environment names nobody there. */
export function personaFor(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): PersonaButton | null {
  const address = email?.trim().toLowerCase();
  if (!address) return null;
  return roster(env).get(address) ?? null;
}

/**
 * Which of the four addresses this deployment has not set.
 *
 * Reported rather than inferred from a failed lookup: with none of them set,
 * *every* signed-in persona is unknown, and "we cannot name this person"
 * reads as a bug in the lookup rather than as four empty variables.
 */
export function unconfiguredPersonas(env: Record<string, string | undefined> = process.env): string[] {
  return PERSONAS.filter((persona) => !env[personaEmailVariable(persona.key)]?.trim()).map((persona) =>
    personaEmailVariable(persona.key),
  );
}

/** `50000` → `$50,000`; `0` → `$0`. What the card puts next to a role. */
export function formatAuthority(clearance: number): string {
  return `$${clearance.toLocaleString("en-US")}`;
}

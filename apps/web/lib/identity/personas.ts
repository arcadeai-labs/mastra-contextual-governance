/**
 * The four buttons on the sign-in panel, and the role and authority each of
 * them carries.
 *
 * **No emails and no passwords.** That is the point of #82's slice: the persona
 * a button names is a request to start a sign-in, and the identity that comes
 * back is whatever `apps/idp` asserts about whoever typed a password. If this
 * list carried emails, the temptation would be to trust one, and
 * `context.user_id` would become a value the browser chose. The addresses live
 * in `PERSONA_<KEY>_EMAIL` and are read in `roster.ts`, which resolves a label
 * *from* an email the IdP already asserted and never the other way round.
 *
 * The cast is `DESIGN.md`'s. It is a demo fixture in the same category as the
 * IdP itself: a forker deletes both and points at their own directory.
 *
 * ## The authority figure is duplicated, and a test says so
 *
 * `clearance` and `roleKey` are the same values `apps/hooks` seeds
 * `governance.db`'s `subjects` table with. They are copied rather than imported
 * because `apps/web` does not depend on `apps/hooks` in the package graph and
 * should not start to — the same argument, and the same remedy, as
 * `DEV_STORE_TOKEN` in `lib/config.ts`: `test/persona-roster.test.ts` reads
 * `apps/hooks/src/fixtures/governance.json` and fails if the two ever disagree.
 *
 * What that test cannot catch is a clearance a presenter raises live on stage,
 * which `DESIGN.md` explicitly allows (Policy source: *editable live on
 * stage*). So the number rendered beside a persona is labelled as the seeded
 * authority, and the audit row on the panel is what says what the control plane
 * actually decided. A figure presented as live truth would be a UI asserting a
 * policy value it never read.
 */
export interface PersonaButton {
  /** The key the sign-in route echoes back as a label. Never an identity. */
  key: string;
  name: string;
  /** For a human to read. `roleKey` is what the policy matches on. */
  role: string;
  /** `subjects.role` in `governance.db` — what `access.analysts-cannot-see-approve` matches. */
  roleKey: string;
  /** `subjects.clearance`, US dollars, as the fixture seeds it. */
  clearance: number;
}

export const PERSONAS: readonly PersonaButton[] = [
  { key: "dana", name: "Dana Okafor", role: "Loan Officer", roleKey: "loan_officer", clearance: 50_000 },
  { key: "sam", name: "Sam Reyes", role: "Credit Analyst", roleKey: "credit_analyst", clearance: 0 },
  { key: "riley", name: "Riley Chen", role: "VP Credit", roleKey: "vp_credit", clearance: 250_000 },
  {
    key: "morgan",
    name: "Morgan Ellis",
    role: "Chief Credit Officer",
    roleKey: "chief_credit_officer",
    clearance: 5_000_000,
  },
] as const;

/** A persona key the roster knows, or `undefined`. An unknown key is dropped, never echoed. */
export function knownPersona(key: string | null | undefined): string | undefined {
  return PERSONAS.find((persona) => persona.key === key?.trim().toLowerCase())?.key;
}

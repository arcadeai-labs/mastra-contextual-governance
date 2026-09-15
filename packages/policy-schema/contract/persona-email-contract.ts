/**
 * Public persona email configuration contract.
 *
 * The fixture keys and display names are scenario data. Addresses are
 * configured by role so a fork can replace the people without exposing the
 * fictional cast in its environment contract. Keep this mapping explicit:
 * deriving a variable from a fixture name makes a rename look successful
 * while leaving the deployment on the wrong configuration.
 */
export const PERSONA_EMAIL_CONTRACT = [
  {
    key: "dana",
    variable: "PERSONA_LOAN_OFFICER_EMAIL",
    deprecatedVariable: "PERSONA_DANA_EMAIL",
  },
  {
    key: "sam",
    variable: "PERSONA_CREDIT_ANALYST_EMAIL",
    deprecatedVariable: "PERSONA_SAM_EMAIL",
  },
  {
    key: "riley",
    variable: "PERSONA_VP_CREDIT_EMAIL",
    deprecatedVariable: "PERSONA_RILEY_EMAIL",
  },
  {
    key: "morgan",
    variable: "PERSONA_CHIEF_CREDIT_OFFICER_EMAIL",
    deprecatedVariable: "PERSONA_MORGAN_EMAIL",
  },
] as const;

export type PersonaKey = (typeof PERSONA_EMAIL_CONTRACT)[number]["key"];

// Match the whole persona namespace so a typo such as `_EMAL` is rejected
// instead of falling through to a fixture address.
const PERSONA_EMAIL_VARIABLE = /^PERSONA_[A-Z0-9_]+$/;

/** `dana` → `PERSONA_LOAN_OFFICER_EMAIL`. Unknown keys are a contract error. */
export function personaEmailVariable(key: string): string {
  const normalized = key.trim().toLowerCase();
  const entry = PERSONA_EMAIL_CONTRACT.find((candidate) => candidate.key === normalized);
  if (!entry) {
    throw new Error(
      `Unknown persona key "${key}"; the persona email contract only defines ` +
        `${PERSONA_EMAIL_CONTRACT.map((candidate) => candidate.key).join(", ")}`,
    );
  }
  return entry.variable;
}

/**
 * Reads configured role addresses and refuses stale or misspelled variables.
 *
 * Empty role variables are intentionally treated as unset so local runs keep
 * using the checked-in fixture addresses. A deprecated variable is rejected
 * even when empty: its presence is still an obsolete public contract and
 * must not make a deployment appear configured by accident.
 */
export function readPersonaEmailOverrides(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const supported = PERSONA_EMAIL_CONTRACT.map((entry) => entry.variable as string);
  const deprecated = PERSONA_EMAIL_CONTRACT.map((entry) => entry.deprecatedVariable as string);
  const configured = Object.keys(env).filter((key) => PERSONA_EMAIL_VARIABLE.test(key));
  const stale = configured.filter((key) => deprecated.includes(key));
  const unknown = configured.filter((key) => !supported.includes(key) && !deprecated.includes(key));

  if (stale.length > 0 || unknown.length > 0) {
    const details: string[] = [];
    if (stale.length > 0) {
      const replacements = PERSONA_EMAIL_CONTRACT
        .filter((entry) => stale.includes(entry.deprecatedVariable as string))
        .map((entry) => `${entry.deprecatedVariable} → ${entry.variable}`)
        .join(", ");
      details.push(`deprecated variable(s): ${replacements}`);
    }
    if (unknown.length > 0) details.push(`unsupported variable(s): ${unknown.join(", ")}`);
    throw new Error(
      `Invalid persona email configuration (${details.join("; ")}). ` +
        `Use only the four role variables: ${PERSONA_EMAIL_CONTRACT.map((entry) => entry.variable).join(", ")}. ` +
        `Obsolete variables are not read and fixture addresses will not be seeded.`,
    );
  }

  return Object.fromEntries(
    PERSONA_EMAIL_CONTRACT.flatMap((entry) => {
      const value = env[entry.variable]?.trim();
      return value ? [[entry.key, value]] : [];
    }),
  );
}

/**
 * Environment, read in one place. Every variable is documented in the repo's
 * `.env.example`.
 *
 * Two of these are load-bearing in a way that fails silently if wrong, so they
 * are read here and nowhere else: the toolkit names. A policy rule keyed on a
 * toolkit Arcade does not actually call `Loan` matches nothing, and a rule that
 * matches nothing is indistinguishable from a rule that permits. The catalogue
 * built from these values is what lets `compilePolicy` refuse such a rule at
 * boot instead of letting the demo run and enforce nothing.
 */

import { assertPublicHost } from "./public-host.ts";

/**
 * The bearer token Arcade presents on every hook call. Refused under
 * NODE_ENV=production — Render prompts for the real one (`sync: false`).
 */
const DEV_SECRET = "cg-hooks-dev-secret-not-for-production";

/** The same, for the approvals store's own bearer. Never equal to `DEV_SECRET`. */
const DEV_STORE_TOKEN = "cg-approvals-store-dev-token-not-for-production";

export interface HooksConfig {
  port: number;
  dbPath: string;
  /** What `Authorization: Bearer …` must carry on `/access`, `/pre` and `/post`. */
  signingSecret: string;
  /**
   * What `Authorization: Bearer …` must carry on the four `/approvals`
   * endpoints. A *different* secret from `signingSecret` on purpose: Arcade
   * holds one and the deployed approvals toolkit holds the other, and neither
   * should be able to present the other's credential. Refused under
   * NODE_ENV=production when unset — without it the store would accept a
   * record from anyone on the internet, and that record is what a human then
   * acts on.
   */
  approvalsStoreToken: string;
  /** `tool.toolkit` as Arcade files the deployed `tools/loan`. Measured on #35. */
  loanToolkit: string;
  /** `tool.toolkit` for `tools/approvals`. Derived, not observed — confirm on #18. */
  approvalsToolkit: string;
  /**
   * Per-persona email overrides, keyed by the fixture's persona key. Read only
   * when `governance.db` is first seeded: the email is the join key across
   * Arcade `user_id`, the OAuth subject and the loan book's actor, and
   * `apps/idp` reads the same four variables so the two databases cannot
   * disagree about who a persona is.
   */
  personaEmails: Record<string, string>;
  /**
   * Our own budget for answering a hook, well inside Arcade's 5s. A request
   * that runs past it is failed closed and audited as such; the point is to
   * be the one deciding, rather than Arcade timing us out and every tool
   * failing with "policy service could not be reached".
   */
  deadlineMs: number;
  /**
   * How often the cache checks `policy_revision` for a live edit. The hook
   * path itself never reads the database; this is the only policy read.
   */
  policyPollMs: number;
  /**
   * How long a grant issued by an approval stays good, in seconds.
   *
   * A grant is single use *and* time-boxed, and the expiry is the half that
   * still holds when the retry never happens: an approval nobody acted on
   * stops being authority rather than sitting in the table forever (PRD story
   * 22). Short enough that a stale approval cannot be replayed after the demo
   * moves on, long enough for the Slack round trip on stage.
   */
  grantTtlSeconds: number;
  /**
   * Act 4's control run, as a switch (#17).
   *
   * `armed` — the default, and the only value the demo path may boot on
   * silently — runs the `/post` free-text scanners. `disarmed` compiles the
   * output policy *without* them, so an injected instruction sitting in a loan
   * file reaches the model and the audience sees what the control was
   * preventing. Act 3's named-field redaction is untouched either way, which is
   * what makes the contrast about act 4 and nothing else.
   *
   * Off is never quiet: the boot line, `/health` and every policy reload say
   * so. The same is true of the other way to disarm it — `UPDATE output_rules
   * SET enabled = 0` on the live database, which is the on-stage flip because
   * it needs no restart — because what is reported is the *compiled* scanner
   * count, not the value of this variable.
   */
  injectionDetection: ScannerSetting;
  /**
   * The bearer `POST /admin/reset` requires — a third secret, never equal to
   * either of the two above (#106).
   *
   * **Empty means the endpoint is not mounted at all**, and `/health` reports
   * `reset: "disabled"`. Not a default, not a dev fallback: unlike the two
   * secrets above, which have development values so a local run works out of
   * the box, this one guards a button that can empty the audit log and replace
   * the live policy, on a public URL with no other authentication in front of
   * it. A development default would be a published one.
   */
  resetToken: string;
}

/** What `INJECTION_DETECTION` may say. Anything else is refused at boot. */
export type ScannerSetting = "armed" | "disarmed";

/**
 * `INJECTION_DETECTION`, as the presenter writes it.
 *
 * Unset is armed: a rehearsal that forgot the variable runs the control, and
 * the way to lose the protection has to be a thing somebody typed. A value
 * that is neither recognised spelling throws rather than defaulting — reading
 * `INJECTION_DETECTION=false` as "armed" would be a demo protected by a typo,
 * and reading it as "disarmed" would be a demo silently unprotected by one.
 */
const SCANNER_SETTINGS: Record<string, ScannerSetting> = {
  "": "armed",
  on: "armed",
  armed: "armed",
  true: "armed",
  off: "disarmed",
  disarmed: "disarmed",
  false: "disarmed",
};

export function readScannerSetting(raw: string | undefined): ScannerSetting {
  const setting = SCANNER_SETTINGS[(raw ?? "").trim().toLowerCase()];
  if (setting === undefined) {
    throw new Error(
      `INJECTION_DETECTION is "${raw}", which is neither on nor off. ` +
        `Leave it unset to run act 4's scanners, or set it to "off" for the control run.`,
    );
  }
  return setting;
}

export function readConfig(env: Record<string, string | undefined> = process.env): HooksConfig {
  const secret = env.ARCADE_HOOK_SIGNING_SECRET?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("ARCADE_HOOK_SIGNING_SECRET is required in production");
  }

  const storeToken = env.APPROVALS_STORE_TOKEN?.trim();
  if (!storeToken && env.NODE_ENV === "production") {
    throw new Error("APPROVALS_STORE_TOKEN is required in production");
  }

  // Checked here and returned nowhere, deliberately. `render.yaml` sets
  // `LOAN_APP_PUBLIC_HOST` on this service and nothing reads it — #16's
  // redaction runs on the payload Arcade posts, not on a fetch of its own —
  // but the value is wrong from the
  // moment it is set, and #59 is the record of what that costs when it is
  // only discovered at the first call. This is the single place the service
  // reads its environment, so it is the place to say so.
  assertPublicHost("LOAN_APP_PUBLIC_HOST", env.LOAN_APP_PUBLIC_HOST);

  const personaEmails: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^PERSONA_([A-Z0-9_]+)_EMAIL$/.exec(key);
    if (match && value?.trim()) personaEmails[(match[1] as string).toLowerCase()] = value.trim();
  }

  return {
    port: Number(env.PORT ?? 8081),
    dbPath: env.GOVERNANCE_DB_PATH ?? "./governance.db",
    signingSecret: secret || DEV_SECRET,
    approvalsStoreToken: storeToken || DEV_STORE_TOKEN,
    loanToolkit: env.ARCADE_LOAN_TOOLKIT?.trim() || "Loan",
    approvalsToolkit: env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
    personaEmails,
    deadlineMs: Number(env.HOOK_DEADLINE_MS ?? 2500),
    policyPollMs: Number(env.POLICY_POLL_MS ?? 250),
    grantTtlSeconds: Number(env.GRANT_TTL_SECONDS ?? 900),
    injectionDetection: readScannerSetting(env.INJECTION_DETECTION),
    resetToken: env.RESET_TOKEN?.trim() ?? "",
  };
}

export function usingDevSecret(config: HooksConfig): boolean {
  return config.signingSecret === DEV_SECRET;
}

export function usingDevStoreToken(config: HooksConfig): boolean {
  return config.approvalsStoreToken === DEV_STORE_TOKEN;
}

/** Whether `POST /admin/reset` exists on this deployment. */
export function resetEnabled(config: HooksConfig): boolean {
  return config.resetToken.length > 0;
}

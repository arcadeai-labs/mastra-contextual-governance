/**
 * What the panel knows about the control plane that the event stream cannot
 * tell it (#106).
 *
 * `GET /events` carries decisions. It says nothing about whether the service
 * making them is healthy, whether its policy still compiles, or whether the
 * rules on its disk are the rules this deployment shipped — and on 2026-09-14
 * every one of those was wrong at once while the panel looked entirely normal.
 * A lane with no cards in it is what a quiet minute looks like and also what a
 * control plane failing closed looks like.
 *
 * So the panel reads `cg-hooks`' `/health` as well, through a route in this
 * service. Through a route rather than directly from the browser for two
 * reasons, and the second is the load-bearing one:
 *
 * 1. `/health` carries row counts and a compile error; none of that has to
 *    cross into a page, and this trims it to what the strip renders.
 * 2. **`RESET_TOKEN` never reaches the browser.** The Reset control posts to
 *    the same route, which is what holds the bearer. A presenter-only secret
 *    in a client bundle is not presenter-only.
 *
 * ## It fails loud, and it never disappears
 *
 * Every function here answers with a value rather than throwing, including
 * when `cg-hooks` cannot be reached at all. A strip that vanishes on error is
 * indistinguishable from a healthy control plane, which is the exact failure
 * #81 was filed for on this same surface.
 */
import { baseUrl, type WebConfig } from "../config.ts";

/** Where the control plane's health and its reset both live, on this service. */
export const CONTROL_PLANE_PATH = "/api/governance/control-plane";

export const RESET_MODES = ["policy", "demo"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/**
 * Whether the Reset control is rendered, and why not.
 *
 * Three values rather than a boolean because the two ways it can be off are
 * different problems with different owners: `no-token` is this service's
 * environment and means the control is not drawn at all (the spec's "hidden
 * when the env is unset"), while `upstream-disabled` means this service is
 * configured and `cg-hooks` is not — a mismatch a presenter has to be told
 * about, because the button would 404 and the drift would stay.
 */
export type ResetAvailability = "enabled" | "no-token" | "upstream-disabled";

/** The rows that differ from the shipped fixture, as `cg-hooks` reports them. */
export interface FixtureDrift {
  readonly ids: string[];
  readonly changed: string[];
  readonly missing: string[];
  readonly unexpected: string[];
}

/** What the strip renders. Deliberately small; `/health` carries much more. */
export interface ControlPlaneStatus {
  readonly reachable: true;
  /** `cg-hooks`' own roll-up. */
  readonly status: "healthy" | "degraded";
  readonly host: string;
  readonly policy: {
    readonly status: string;
    readonly revision: number | null;
    /** The compiler's problem list, verbatim, when the policy will not load. */
    readonly error: string | null;
  };
  readonly fixture_drift: FixtureDrift | null;
  readonly injection_detection: { readonly state: string; readonly patterns: number };
  readonly reset: ResetAvailability;
  /** Everything `/health` put in `warnings`, in its own words. */
  readonly warnings: string[];
}

/**
 * The control plane could not be asked. Still a rendered state, never an empty
 * one: "we do not know" and "everything is fine" must not look the same.
 */
export interface ControlPlaneUnreachable {
  readonly reachable: false;
  readonly host: string;
  readonly problem: string;
  readonly reset: ResetAvailability;
}

export type ControlPlaneReport = ControlPlaneStatus | ControlPlaneUnreachable;

/** The subset of `cg-hooks`' `/health` this service reads. */
interface HooksHealth {
  status?: unknown;
  reset?: unknown;
  warnings?: unknown;
  policy?: { status?: unknown; revision?: unknown; error?: unknown };
  fixture_drift?: {
    ids?: unknown;
    changed?: unknown;
    missing?: unknown;
    unexpected?: unknown;
  } | null;
  injection_detection?: { state?: unknown; patterns?: unknown };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** This service's half of the reset: the bearer, or the absence of one. */
export function resetToken(env: Record<string, string | undefined> = process.env): string {
  return env.RESET_TOKEN?.trim() ?? "";
}

/**
 * Asks `cg-hooks` how it is, with a short deadline.
 *
 * The deadline matters more here than the answer does: this runs on a poll
 * behind a page a presenter is standing in front of, and a control plane that
 * has stopped answering should produce the unreachable strip within a couple
 * of seconds rather than a spinner for as long as the platform's default
 * socket timeout.
 */
export async function readControlPlane(
  config: Pick<WebConfig, "hooksHost">,
  options: { token?: string; timeoutMs?: number } = {},
): Promise<ControlPlaneReport> {
  const host = config.hooksHost;
  const token = options.token ?? "";
  const available: ResetAvailability = token === "" ? "no-token" : "enabled";

  let response: Response;
  try {
    response = await fetch(`${baseUrl(host)}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      // A health read must never be answered from a cache; the whole question
      // is what is true right now.
      cache: "no-store",
    });
  } catch (cause) {
    return {
      reachable: false,
      host,
      reset: available,
      problem:
        `${host} did not answer GET /health (${String(cause)}). The panel is showing decisions ` +
        `from a control plane it cannot currently ask about itself — an empty lane right now ` +
        `means nothing.`,
    };
  }

  if (!response.ok) {
    return {
      reachable: false,
      host,
      reset: available,
      problem: `${host} answered GET /health with HTTP ${response.status}.`,
    };
  }

  let body: HooksHealth;
  try {
    body = (await response.json()) as HooksHealth;
  } catch (cause) {
    return {
      reachable: false,
      host,
      reset: available,
      problem: `${host} answered GET /health with something that is not JSON (${String(cause)}).`,
    };
  }

  const drift = body.fixture_drift;
  return {
    reachable: true,
    host,
    status: body.status === "healthy" ? "healthy" : "degraded",
    policy: {
      status: typeof body.policy?.status === "string" ? body.policy.status : "unknown",
      revision: typeof body.policy?.revision === "number" ? body.policy.revision : null,
      error: typeof body.policy?.error === "string" ? body.policy.error : null,
    },
    fixture_drift:
      drift === null || drift === undefined
        ? null
        : {
            ids: strings(drift.ids),
            changed: strings(drift.changed),
            missing: strings(drift.missing),
            unexpected: strings(drift.unexpected),
          },
    injection_detection: {
      state: typeof body.injection_detection?.state === "string" ? body.injection_detection.state : "unknown",
      patterns:
        typeof body.injection_detection?.patterns === "number" ? body.injection_detection.patterns : 0,
    },
    // Both sides have to be configured. This service holding a token that
    // cg-hooks will not accept is a 404 at the moment of the press, which is
    // the worst moment to find out.
    reset: token === "" ? "no-token" : body.reset === "enabled" ? "enabled" : "upstream-disabled",
    warnings: strings(body.warnings),
  };
}

export interface ResetOutcome {
  readonly ok: boolean;
  readonly mode: ResetMode;
  /** One sentence for the strip, whichever way it went. */
  readonly detail: string;
}

/** Posts the reset with this service's bearer. Never throws. */
export async function runReset(
  config: Pick<WebConfig, "hooksHost">,
  mode: ResetMode,
  token: string,
  timeoutMs = 10_000,
): Promise<ResetOutcome> {
  try {
    const response = await fetch(`${baseUrl(config.hooksHost)}/admin/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 400);
      return {
        ok: false,
        mode,
        detail:
          response.status === 404
            ? `${config.hooksHost} has no /admin/reset: RESET_TOKEN is unset on cg-hooks, so the ` +
              `endpoint does not exist there. Set the same value on both services.`
            : `${config.hooksHost} refused the reset with HTTP ${response.status}: ${text}`,
      };
    }
    const body = (await response.json()) as { revision?: unknown };
    const revision = typeof body.revision === "number" ? body.revision : null;
    return {
      ok: true,
      mode,
      detail:
        mode === "demo"
          ? `Demo reset: policy replaced from the fixture${revision === null ? "" : ` at revision ${revision}`}, grants, approval requests and the audit log cleared. loans.db is apps/loan-app's and was not touched.`
          : `Policy reset from the fixture${revision === null ? "" : ` at revision ${revision}`}. Grants, approval requests and the audit log were left alone.`,
    };
  } catch (cause) {
    return { ok: false, mode, detail: `${config.hooksHost} could not be reached: ${String(cause)}` };
  }
}

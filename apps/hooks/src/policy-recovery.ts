/**
 * The one case where a durable policy is replaced without anybody asking.
 *
 * #29 decided policy is durable: a clearance raised on stage survives a
 * restart, and a reset is something a human runs. #106 measured the cost of
 * that on a fixture change, and #112 measured the worst version of it. On
 * 2026-09-14 at 15:29Z, #89's compile guard shipped; the Render disk still
 * held the dot-spelled remediation text it refuses; cg-hooks came up
 * `STARTED FAIL-CLOSED`, `/health` answered 503, Render read that as a dead
 * instance and served its own 502 over the top. The control plane was not
 * failing closed, it was *gone*, and the shell command that would have fixed
 * it could not be verified over HTTP. Recovery took a rollback, a hand-written
 * `UPDATE`, and three attempts, two of which reseeded the old image's fixture.
 *
 * So one narrow rule, and the narrowness is the whole of it:
 *
 *     the policy on disk does not compile
 *     AND the rows that fail differ from the fixture in this image
 *     → replace the four policy tables from that fixture, loudly
 *
 * Both halves are load-bearing.
 *
 * *Does not compile* is what makes this not a reset. A stage edit that
 * compiles is serving policy, so this never runs and #29 is untouched. A stage
 * edit that does **not** compile is also replaced, and that is a deliberate
 * choice rather than an oversight: rows the engine refuses are rows no hook
 * will ever evaluate, so there is nothing to preserve — the alternative is
 * preserving an outage. The log says so in those words when it happens.
 *
 * *Differ from the fixture* is what makes it terminate and what makes it
 * honest. If the failing rows already **are** the fixture's, reseeding writes
 * the same bytes back, fails again, and does it every boot. That case is a
 * fixture this build cannot compile — a bug in the image, not stale data — and
 * it gets a different line saying exactly that, because sending a human to run
 * a reset that cannot help is worse than sending them nowhere.
 *
 * The fixture used is always the one compiled into the *booting* image. That
 * is the property a shell command cannot have, and it is precisely what went
 * wrong twice during the incident: a reseed run against a rolled-back image
 * loaded the old text back, so the next deploy failed closed again.
 */
import type { Database } from "bun:sqlite";

import { driftWarning } from "./fixture-drift.ts";
import type { PolicyCache } from "./policy-cache.ts";
import { replacePolicy, type Seed } from "./policy-store.ts";

export interface RecoveryDeps {
  db: Database;
  /** Already `start()`ed: this reads the state that start produced. */
  cache: PolicyCache;
  /** The fixture in this image, loaded once. */
  seed: Seed;
  log: (line: string) => void;
}

export interface RecoveryOutcome {
  /** Whether the four policy tables were replaced. */
  reseeded: boolean;
  /** One line, the same one written to the log. Read back by tests and `/health`. */
  detail: string;
}

/**
 * Runs the rule above. Safe to call on a healthy boot, where it does nothing
 * and says so.
 */
export function recoverStalePolicy(deps: RecoveryDeps): RecoveryOutcome {
  const { db, cache, seed, log } = deps;
  const state = cache.current();
  if (state.status !== "failed") {
    return { reseeded: false, detail: "policy compiles; nothing to recover" };
  }

  const status = cache.status();
  if (!status.fixture_checked) {
    const detail =
      `policy failed to load and no fixture was supplied to compare against, so the stale-row ` +
      `reseed could not run. Hooks are failing closed.`;
    log(`POLICY RECOVERY: ${detail}`);
    return { reseeded: false, detail };
  }

  const drift = status.fixture_drift;
  if (drift === null) {
    const detail =
      `policy failed to load and the rows on disk are byte for byte the fixture shipped in this ` +
      `image, so reseeding would write the same rows back and fail again. This is a fixture this ` +
      `build cannot compile, not a stale disk — fix the fixture and redeploy. Error: ${state.error}`;
    log(`POLICY RECOVERY IMPOSSIBLE: ${detail}`);
    return { reseeded: false, detail };
  }

  log(
    `POLICY RECOVERY: the policy on disk does not compile (${state.error}) and differs from the ` +
      `fixture in this image — ${driftWarning(drift)} Replacing subjects, catalogue, policy_rules ` +
      `and output_rules from the fixture. Rows the engine refuses cannot be served, so a stage ` +
      `edit among them is being discarded on purpose; grants, approval requests and the audit ` +
      `log are untouched.`,
  );

  try {
    replacePolicy(db, seed);
  } catch (cause) {
    const detail = `reseeding the policy tables from the fixture failed: ${String(cause)}`;
    log(`POLICY RECOVERY FAILED: ${detail}`);
    return { reseeded: false, detail };
  }

  const reloaded = cache.reload();
  if (reloaded.status !== "ready") {
    const detail =
      `the policy tables were replaced from the fixture and the result still does not compile: ` +
      `${reloaded.status === "failed" ? reloaded.error : reloaded.status}. Hooks are failing closed.`;
    log(`POLICY RECOVERY FAILED: ${detail}`);
    return { reseeded: false, detail };
  }

  const detail = `policy reseeded from the fixture and loaded at revision ${reloaded.revision}`;
  log(`POLICY RECOVERY: ${detail}`);
  return { reseeded: true, detail };
}

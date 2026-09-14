/**
 * The policy, in memory — and why it has to be.
 *
 * Spike #2 measured `/access` being called with the entire project catalogue,
 * ~1.6 MB, against a 5s fail-closed timeout. Reading `governance.db` on each of
 * those calls does not survive that, and a timeout there does not look like a
 * policy problem: every tool in the project fails with "tool access policy
 * service could not be reached". So the compiled policy and the subject roster
 * live here, and **a hook call touches the database only to append its audit
 * rows**. `current()` is a memory read and nothing else.
 *
 * But the database carries live edits. A presenter raises Dana's clearance in
 * act 1 and expects act 3 to honour it; a rule the cache never picks up is the
 * same failure as losing the edit to a restart. So a background poller reads
 * one integer, `policy_revision` — bumped by triggers on every write to
 * `subjects`, `catalogue`, `policy_rules` or `output_rules`, from any
 * connection — every
 * `pollMs` (default 250 ms) and reloads when it has moved. An edit made with a
 * `sqlite3` shell on the Render disk is live within a quarter of a second, the
 * reload is logged, and `/health` reports `revision`, `loaded_at` and
 * `last_poll_at`, so "did my edit take?" has an answer that is not "rerun the
 * prompt and see".
 *
 * Three states, and only one of them serves policy:
 *
 * - `cold` — `start()` has not run. Every hook fails closed. Boot calls
 *   `start()` before the port opens, so this is never served in practice; it
 *   exists so that a server constructed without a warm cache denies rather
 *   than performing, on Arcade's first 1.6 MB request, exactly the database
 *   load the cache was built to avoid.
 * - `ready` — serving the policy at `revision`.
 * - `failed` — the last reload failed: a hand-edited row that no longer
 *   parses, a rule that no longer compiles because it names a tool the
 *   catalogue lost. Every hook fails closed until the next successful reload,
 *   which the next edit triggers. Not "keep serving the last good policy":
 *   that would be a policy edit silently not taking effect, which is exactly
 *   the failure this design exists to avoid.
 *
 * A *poll* that fails is different from a *reload* that fails. A transient
 * error reading one integer says nothing about the policy in memory, so the
 * cache keeps serving it, logs, and retries next tick. Only when the revision
 * has been unreadable for `maxPollFailures` consecutive ticks (default 20, so
 * ~5 s) does the cache fail closed — at that point it can no longer promise
 * that an edit would be noticed, and that promise is the point.
 */
import type { Database } from "bun:sqlite";

import {
  compileOutputPolicy,
  compilePolicy,
  type CompiledOutputPolicy,
  type CompiledPolicy,
  type ToolCatalogue,
} from "@cg/governance-core";
import type { OutputRule, Subject } from "@cg/policy-schema";

import { readPolicy, readRevision } from "./policy-store.ts";

export type CacheState =
  | { status: "cold" }
  | {
      status: "ready";
      revision: number;
      loaded_at: string;
      policy: CompiledPolicy;
      /**
       * The `/post` rules, compiled (#16). In the same state as `policy` and
       * loaded by the same reload, so a redaction rule that no longer compiles
       * fails the whole cache closed rather than leaving `/pre` serving a
       * policy while `/post` quietly redacts nothing.
       */
      outputPolicy: CompiledOutputPolicy;
      /**
       * The same `/post` rules before compilation, kept for one reason: a
       * compiled rule drops its `reason`, and that sentence is what the audit
       * row and the panel say when the rule fires. Read by id, never evaluated.
       */
      outputRules: ReadonlyMap<string, OutputRule>;
      catalogue: ToolCatalogue;
      /** Keyed by lower-cased `user_id`; see `findSubject`. */
      subjects: ReadonlyMap<string, Subject>;
    }
  | {
      status: "failed";
      /** The revision that failed to load, so `/health` can say which edit broke it. */
      revision: number | null;
      failed_at: string;
      error: string;
    };

/** What `/health` shows about the cache. */
export interface CacheStatus {
  status: CacheState["status"];
  revision: number | null;
  loaded_at: string | null;
  failed_at: string | null;
  error: string | null;
  poll_ms: number;
  last_poll_at: string | null;
  consecutive_poll_failures: number;
}

export interface PolicyCache {
  /** The policy in memory. Never touches the database. */
  current(): CacheState;
  /** Loads the policy now and starts polling the revision. Idempotent. */
  start(): CacheState;
  /** Stops polling. Tests and scripts call it so the process can exit. */
  stop(): void;
  /** Unconditional reload, synchronous. `start()` calls it; tests may too. */
  reload(): CacheState;
  /** One poll tick, synchronous. Exposed so a test can drive it without a clock. */
  poll(): CacheState;
  status(): CacheStatus;
}

export interface PolicyCacheOptions {
  log?: (line: string) => void;
  pollMs?: number;
  maxPollFailures?: number;
}

export function createPolicyCache(db: Database, options: PolicyCacheOptions = {}): PolicyCache {
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? 250;
  const maxPollFailures = options.maxPollFailures ?? 20;

  let state: CacheState = { status: "cold" };
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPollAt: string | null = null;
  let pollFailures = 0;

  const reload = (): CacheState => {
    let revision: number | null = null;
    try {
      const snapshot = readPolicy(db);
      revision = snapshot.revision;
      const policy = compilePolicy({ catalogue: snapshot.catalogue, rules: snapshot.rules });
      const outputPolicy = compileOutputPolicy({
        catalogue: snapshot.catalogue,
        rules: snapshot.output_rules,
      });
      const subjects = new Map(snapshot.subjects.map((s) => [subjectKey(s.user_id), s] as const));
      state = {
        status: "ready",
        revision,
        loaded_at: new Date().toISOString(),
        policy,
        outputPolicy,
        outputRules: new Map(snapshot.output_rules.map((rule) => [rule.id, rule] as const)),
        catalogue: snapshot.catalogue,
        subjects,
      };
      log(
        `policy loaded: revision ${revision}, ${subjects.size} subjects, ` +
          `${snapshot.rules.length} rules, ${snapshot.output_rules.length} output rules, ` +
          `${Object.keys(snapshot.catalogue).length} toolkits`,
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      state = { status: "failed", revision, failed_at: new Date().toISOString(), error };
      log(`policy FAILED to load at revision ${revision ?? "?"} — failing closed: ${error}`);
    }
    return state;
  };

  const poll = (): CacheState => {
    lastPollAt = new Date().toISOString();
    let revision: number;
    try {
      revision = readRevision(db);
    } catch (cause) {
      pollFailures += 1;
      const error = cause instanceof Error ? cause.message : String(cause);
      if (pollFailures >= maxPollFailures && state.status !== "failed") {
        state = { status: "failed", revision: null, failed_at: lastPollAt, error: `policy revision unreadable for ${pollFailures} polls: ${error}` };
        log(`policy revision unreadable for ${pollFailures} polls — failing closed: ${error}`);
      } else if (pollFailures === 1) {
        log(`policy revision unreadable (serving cached revision meanwhile): ${error}`);
      }
      return state;
    }
    pollFailures = 0;
    const loaded = state.status === "cold" ? null : state.revision;
    if (revision !== loaded) reload();
    return state;
  };

  const start = (): CacheState => {
    if (state.status === "cold") reload();
    if (timer === null) {
      timer = setInterval(poll, pollMs);
      // A pending tick must not keep a test or a script alive.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }
    return state;
  };

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const status = (): CacheStatus => ({
    status: state.status,
    revision: state.status === "cold" ? null : state.revision,
    loaded_at: state.status === "ready" ? state.loaded_at : null,
    failed_at: state.status === "failed" ? state.failed_at : null,
    error: state.status === "failed" ? state.error : null,
    poll_ms: pollMs,
    last_poll_at: lastPollAt,
    consecutive_poll_failures: pollFailures,
  });

  return { current: () => state, start, stop, reload, poll, status };
}

/**
 * `user_id` is an email, and the three systems joined on it — Arcade, the OAuth
 * provider, the loan book — do not all promise the same casing. Comparing
 * case-insensitively is a strict superset of the exact join and cannot make
 * two different people the same one.
 */
export function subjectKey(userId: string): string {
  return userId.trim().toLowerCase();
}

export function findSubject(state: CacheState, userId: string | undefined): Subject | null {
  if (state.status !== "ready" || userId === undefined) return null;
  return state.subjects.get(subjectKey(userId)) ?? null;
}

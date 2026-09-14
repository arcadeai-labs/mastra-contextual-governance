/**
 * The control plane. Owns `governance.db`, serves Arcade's `/access`, `/pre`
 * and `/post` hooks, and records every decision it makes.
 *
 *     POST /access   which tools this user may see        → { deny }
 *     POST /pre      may this user make this call          → { code, error_message? }
 *     POST /post     what the model may read of the result → { code, override? }
 *     GET  /events   the live governance stream, SSE         (no auth)
 *     GET  /health   policy revision, counts, fail-closed  (no auth)
 *
 *     POST /admin/reset  put the policy (or the whole demo) back to the
 *                        fixture — bearer RESET_TOKEN, 404 when unset
 *
 * Boot order matters: the policy is loaded into memory *before* the port
 * opens, so the first `/access` Arcade sends — possibly the 1.6 MB one — is
 * served from a warm cache, and a background poll of the database's revision
 * counter picks up live edits. A policy that fails to load does not stop the
 * service from starting; it starts failing closed, says so on `/health`, and
 * reloads on the next edit.
 *
 * `/health` answers **200 whatever it finds** (#112). It said 503 on a failed
 * policy until 2026-09-14, when Render — which health-checks this path — read
 * that as a dead instance and served a 502 over a service that was doing
 * exactly what it was designed to do. Readiness is "the process is up and can
 * say what is wrong"; the refusal belongs to the hooks, and they still refuse.
 *
 * Between the cache warming and the port opening sits one more step, and it is
 * the other half of that day (#106): if the policy on disk does not compile
 * *and* it differs from the fixture in this image, the four policy tables are
 * replaced from that fixture and reloaded, loudly. See `policy-recovery.ts`
 * for why both halves of that condition are load-bearing.
 */
import { createEventBus } from "@cg/governance-core";

import { createApprovalNoticeBus } from "./approval-notices.ts";
import { retentionWarning } from "./audit-log.ts";
import { usingDevSecret, readConfig } from "./config.ts";
import { EVENTS_PATH } from "./events.ts";
import { fixtureDigest } from "./fixture-drift.ts";
import { createPolicyCache } from "./policy-cache.ts";
import { recoverStalePolicy } from "./policy-recovery.ts";
import {
  counts,
  describeMigration,
  loadSeed,
  openGovernance,
  type MigrationReport,
} from "./policy-store.ts";
import { orExitConfig } from "./public-host.ts";
import { createServer, SERVICE } from "./server.ts";

const log = (line: string) => console.log(`[${SERVICE}] ${line}`);

// A cross-service address that cannot resolve is a startup failure, not a
// surprise later — see `public-host.ts`. Every other configuration error still
// propagates as it did.
const config = orExitConfig(SERVICE, readConfig);
// A disk that predates this build is brought forward before anything else
// happens, and says so exactly once — on the boot that did it (#103). The same
// report stays on `/health` for the life of the process, because a boot line
// scrolls away and a Render deploy log is not where somebody checks whether
// 745,000 rows were rewritten.
let migration: MigrationReport | null = null;
const db = openGovernance(config.dbPath, config, (report) => {
  migration = report;
  log(describeMigration(report));
});
// Loaded once, from the image. Both the drift comparison and the reset use
// this and never re-read the file: a reseed driven from the *booting* image's
// fixture is the property a shell command on a rolled-back instance cannot
// have, and #112 is the record of what that costs.
const seed = loadSeed(config);
const cache = createPolicyCache(db, {
  log,
  pollMs: config.policyPollMs,
  scanners: config.injectionDetection,
  fixture: fixtureDigest(config, seed),
});
// Warm before the port opens: Arcade's first /access may be the 1.6 MB one.
let state = cache.start();
// Stale rows that cannot compile are not a stage edit worth preserving (#106).
// Runs before the port opens so the first hook call meets the recovered policy
// rather than a fail-closed one that is about to become healthy.
const recovery = recoverStalePolicy({ db, cache, seed, log });
if (recovery.reseeded) state = cache.current();

// The fan-out for GET /events. A subscriber that throws is the panel's
// problem, never the control plane's, so it is logged and nothing else.
const bus = createEventBus({
  onSubscriberError: (cause) => log(`STREAM SUBSCRIBER FAILED: ${String(cause)}`),
});

// The second fan-out on the same socket: approval decisions (#20's resume
// half). Its own registry because what it carries is not an audit row — see
// `approval-notices.ts`.
const notices = createApprovalNoticeBus({
  onSubscriberError: (cause) => log(`APPROVAL NOTICE SUBSCRIBER FAILED: ${String(cause)}`),
});

const server = createServer({ config, db, cache, bus, notices, log, seed, migration });

const tally = counts(db);
log(
  `listening on :${server.port} — ${config.dbPath}: ${tally.subjects} subjects, ` +
    `${tally.policy_rules} rules, ${tally.audit_log} audit rows; ` +
    `toolkits ${config.loanToolkit}, ${config.approvalsToolkit}; ` +
    `streaming on ${EVENTS_PATH}`,
);
if (state.status === "failed") log(`STARTED FAIL-CLOSED: ${state.error}`);
// The four policy tables against the fixture in this image. A stage edit is
// meant to look like this and to survive; a fixture change that never reached
// this disk looks identical, and that is the silence #106 was filed for.
const drift = cache.status().fixture_drift;
log(
  drift === null
    ? "policy matches the fixture shipped in this image"
    : `FIXTURE DRIFT: ${drift.ids.length} row(s) differ — ${drift.ids.join(", ")}`,
);
log(
  config.resetToken.length > 0
    ? "POST /admin/reset is enabled (bearer RESET_TOKEN)"
    : "POST /admin/reset is disabled: RESET_TOKEN is unset, so the endpoint answers 404",
);
// Act 4's scanners, on the boot line whichever way they are set (#17). The
// warning is printed by the cache on every reload; this is the one a reader
// sees when the service comes up, and it is the reason a control run cannot be
// mistaken for a protected one at a glance.
const scanners = cache.status().scanners;
log(
  `injection detection: ${scanners.state} — ${scanners.patterns} free-text pattern(s) ` +
    `from ${scanners.rules.length} rule(s) (INJECTION_DETECTION=${config.injectionDetection})`,
);
// Nothing prunes `audit_log` — the table is append-only and a compliance log
// that can be quietly shortened is not one. So the bound is the disk, and the
// only useful moment to mention it is the boot before it is reached.
const retention = retentionWarning(tally.audit_log ?? 0);
if (retention !== null) log(`RETENTION: ${retention}`);
if (usingDevSecret(config)) {
  log("ARCADE_HOOK_SIGNING_SECRET is unset — using the development token. Not for production.");
}

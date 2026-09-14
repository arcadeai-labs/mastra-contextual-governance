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
 * Boot order matters: the policy is loaded into memory *before* the port
 * opens, so the first `/access` Arcade sends — possibly the 1.6 MB one — is
 * served from a warm cache, and a background poll of the database's revision
 * counter picks up live edits. A policy that fails to load does not stop the
 * service from starting; it starts failing closed, says so on `/health` with
 * a 503, and reloads on the next edit.
 */
import { createEventBus } from "@cg/governance-core";

import { createApprovalNoticeBus } from "./approval-notices.ts";
import { retentionWarning } from "./audit-log.ts";
import { usingDevSecret, readConfig } from "./config.ts";
import { EVENTS_PATH } from "./events.ts";
import { createPolicyCache } from "./policy-cache.ts";
import { counts, openGovernance } from "./policy-store.ts";
import { orExitConfig } from "./public-host.ts";
import { createServer, SERVICE } from "./server.ts";

const log = (line: string) => console.log(`[${SERVICE}] ${line}`);

// A cross-service address that cannot resolve is a startup failure, not a
// surprise later — see `public-host.ts`. Every other configuration error still
// propagates as it did.
const config = orExitConfig(SERVICE, readConfig);
const db = openGovernance(config.dbPath, config);
const cache = createPolicyCache(db, {
  log,
  pollMs: config.policyPollMs,
  scanners: config.injectionDetection,
});
// Warm before the port opens: Arcade's first /access may be the 1.6 MB one.
const state = cache.start();

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

const server = createServer({ config, db, cache, bus, notices, log });

const tally = counts(db);
log(
  `listening on :${server.port} — ${config.dbPath}: ${tally.subjects} subjects, ` +
    `${tally.policy_rules} rules, ${tally.audit_log} audit rows; ` +
    `toolkits ${config.loanToolkit}, ${config.approvalsToolkit}; ` +
    `streaming on ${EVENTS_PATH}`,
);
if (state.status === "failed") log(`STARTED FAIL-CLOSED: ${state.error}`);
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

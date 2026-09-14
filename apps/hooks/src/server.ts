/**
 * The HTTP layer. Thin on purpose: bearer auth, parse, hand to a handler,
 * append the audit rows, respond. The one piece of behaviour that is its own
 * is the fail-closed net around all of that.
 *
 * Fails closed, and the failure is audited. Whatever goes wrong between the
 * request arriving and the response leaving — an unparseable body, a throw in
 * the engine, the audit write itself failing, our own deadline passing — the
 * answer Arcade gets is a denial, and rows saying why are appended if the
 * store will take them. A `/access` whose body cannot be read at all gets a
 * 5xx, which Arcade's `failure_mode: fail_closed` (set on #13) turns into a
 * denial of every tool the call was about; everything else gets a well-formed
 * denying response, because that is precise where a 5xx is blunt.
 *
 * The deadline is ours, inside Arcade's 5s, and it is a *budget*, checked at
 * every stage boundary: after the body is read (the one asynchronous step,
 * which is raced against a timer), after the policy is evaluated, and before
 * the audit rows are written. JavaScript cannot interrupt synchronous work,
 * so a slow evaluation runs to completion — but its result is then discarded,
 * the call is denied, and the row says `Timeout`. What never happens is an
 * allow being returned late enough that Arcade has already given up, or an
 * allow being recorded for a call that was in fact denied.
 */
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";

import type { EventBus, PublishedEvent } from "@cg/governance-core";
import {
  AccessHookRequest,
  HOOK_CONTRACT_VERSION,
  HOOK_ENDPOINT_PATHS,
  PostHookRequest,
  PreHookRequest,
  type AccessHookResult,
  type ErrorResponse,
  type GovernanceEvent,
  type HookPoint,
  type PreHookResult,
} from "@cg/policy-schema";

import { accessAuditRows, type DecidedTool } from "./access-audit.ts";
import { createApprovalControl } from "./approval-governance.ts";
import type { ApprovalNoticeBus } from "./approval-notices.ts";
import { APPROVALS_PREFIX, handleApprovals } from "./approvals-api.ts";
import { pendingCount } from "./approvals-store.ts";
import { AUDIT_PATH, handleAudit } from "./audit-api.ts";
import { count as auditCount, newEventId, record } from "./audit-log.ts";
import { resetEnabled, type HooksConfig } from "./config.ts";
import { withCorrelation } from "./correlation.ts";
import { EVENTS_PATH, handleEvents, preflight } from "./events.ts";
import {
  governedFor,
  handleAccess,
  handlePost,
  handlePre,
  type HandlerContext,
  type Outcome,
} from "./handlers.ts";
import { driftWarning } from "./fixture-drift.ts";
import type { PolicyCache } from "./policy-cache.ts";
import { counts, type Seed } from "./policy-store.ts";
import { handleReset, RESET_PATH } from "./reset-api.ts";

export const SERVICE = "hooks";

export interface ServerDeps {
  config: HooksConfig;
  db: Database;
  cache: PolicyCache;
  /**
   * The fan-out for `GET /events`. Optional: a server constructed without one
   * governs exactly as before and simply has nobody watching, which is what
   * every test that predates #20 wants.
   */
  bus?: EventBus;
  /**
   * The fan-out for `event: approval` on the same stream (#20's resume half).
   * Optional and independent of `bus`: without it, decisions are recorded
   * exactly as before and nothing is announced.
   */
  notices?: ApprovalNoticeBus;
  log?: (line: string) => void;
  /** Overridden in tests so an idle stream's keep-alive is observable. */
  streamKeepAliveMs?: number;
  /** Overridden in tests to reach the stream's backlog and replay cap cheaply. */
  streamBacklogLimit?: number;
  /**
   * The fixture compiled into this image, for `POST /admin/reset` (#106).
   * Without it the endpoint is not mounted, exactly as an unset `RESET_TOKEN`
   * leaves it unmounted — there is nothing to reset *from*.
   */
  seed?: Seed;
}

type HookPath = (typeof HOOK_ENDPOINT_PATHS)[keyof typeof HOOK_ENDPOINT_PATHS];

const HOOK_BY_PATH: Record<string, HookPoint> = {
  [HOOK_ENDPOINT_PATHS.accessHook]: "access",
  [HOOK_ENDPOINT_PATHS.preHook]: "pre",
  [HOOK_ENDPOINT_PATHS.postHook]: "post",
};

class Timeout extends Error {
  constructor(budgetMs: number, elapsedMs: number, stage: string) {
    super(`${stage} exceeded the ${budgetMs}ms hook budget (${Math.round(elapsedMs)}ms elapsed)`);
    this.name = "Timeout";
  }
}

export function createServer(deps: ServerDeps) {
  const { config, db, cache, bus, notices } = deps;
  const log = deps.log ?? ((line: string) => console.log(`[${SERVICE}] ${line}`));
  /**
   * The audit write is the fan-out seam: rows reach the stream only once the
   * transaction that wrote them has committed. `record` does the publishing
   * itself, so there is no path that appends a row without announcing it.
   */
  const publish =
    bus === undefined ? undefined : (batch: readonly PublishedEvent[]) => bus.publish(batch);
  const ctx: HandlerContext = {
    now: () => new Date().toISOString(),
    newId: newEventId,
    approvals: createApprovalControl(db, {
      toolkit: config.approvalsToolkit,
      grantTtlSeconds: config.grantTtlSeconds,
    }),
    // Only reached while the policy is cold or will not compile — the loaded
    // catalogue wins whenever there is one. See `access-audit.ts`.
    configuredToolkits: new Set([config.loanToolkit, config.approvalsToolkit]),
  };

  /**
   * Constant-time bearer check against one expected secret.
   *
   * Two secrets reach this service and they are deliberately different: Arcade
   * signs the hooks with one, the deployed approvals toolkit and the approval
   * page present the other on `/approvals`. Neither can be used in the other's
   * place, so a leaked store token cannot forge a hook decision.
   */
  const bearerIs = (request: Request, expected: string): boolean => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    // Hash both sides so lengths match, then compare in constant time.
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return token.length > 0 && timingSafeEqual(digest(token), digest(expected));
  };

  const authorized = (request: Request): boolean => bearerIs(request, config.signingSecret);

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });

  /**
   * Parse → handle, for one hook. Throws on anything it cannot turn into a
   * decision; `handleHook` below converts that into the fail-closed response.
   */
  const evaluate = (hook: HookPoint, body: unknown): Outcome<unknown> => {
    const state = cache.current();

    switch (hook) {
      case "access":
        return handleAccess(AccessHookRequest.parse(body), state, ctx);
      case "pre":
        return handlePre(PreHookRequest.parse(body), state, ctx);
      case "post":
        return handlePost(PostHookRequest.parse(body), state, ctx);
    }
  };

  /**
   * The net. Builds the denying response for `hook` and audits the failure,
   * using whatever of the raw body can be read to say who and what it was
   * about. Never throws: if even the audit write fails, the denial still goes
   * out and the log carries both errors.
   */
  const failClosed = (hook: HookPoint, raw: unknown, cause: unknown): Response => {
    const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const id = newEventId();
    const body = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const toolInfo = (body.tool ?? {}) as Record<string, unknown>;
    const context = (body.context ?? {}) as Record<string, unknown>;
    const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

    const userId = hook === "access" ? str(body.user_id) : str(context.user_id);
    const reasonFor = (tool: string): string =>
      `FAIL-CLOSED: the control plane could not evaluate this ${hook} request (${error}). ` +
      `Do not retry ${tool}; report the reference to an administrator.`;
    const ts = ctx.now();
    const row = (eventId: string, tool: string): GovernanceEvent => ({
      id: eventId,
      ts,
      execution_id: str(body.execution_id),
      hook,
      user_id: userId,
      tool,
      decision: "deny",
      reason: reasonFor(tool),
      rule_id: null,
    });
    const audit = (events: GovernanceEvent[]): void => {
      try {
        record(db, events, publish);
      } catch (auditCause) {
        log(`AUDIT WRITE FAILED while failing closed (${id}): ${String(auditCause)}`);
      }
    };

    if (hook === "access") {
      // Deny everything the request named, audited the way the normal path
      // audits it — one row per tool in a governed toolkit, one summary row
      // for the rest (#107). A control plane that is failing closed is the
      // last place that should be writing thousands of rows per call. If even that
      // cannot be read, one row for the request and a 5xx: the one signal
      // left, and Arcade's fail_closed mode makes it a denial.
      const parsed = AccessHookRequest.safeParse(body);
      if (parsed.success) {
        const decided: DecidedTool[] = [];
        for (const [toolkit, info] of Object.entries(parsed.data.toolkits)) {
          for (const name of Object.keys(info.tools ?? {})) {
            decided.push({
              tool: { toolkit, name },
              decision: { effect: "deny", reason: reasonFor(`${toolkit}.${name}`), rule_id: null },
            });
          }
        }
        audit(
          accessAuditRows(decided, {
            governed: governedFor(cache.current(), ctx),
            base: { ts, execution_id: str(body.execution_id), hook, user_id: userId },
            newId: newEventId,
            // Everything in this call was refused for one reason, so the
            // summary carries it too: a fail-closed listing must read as
            // fail-closed on every row it wrote, or the log cannot tell one
            // from a normal one.
            summaryReason: reasonFor,
          }),
        );
        const response: AccessHookResult = { deny: parsed.data.toolkits };
        return json(response);
      }
      audit([row(id, "*")]);
      const response: ErrorResponse = { error: withCorrelation(reasonFor("*"), id), code: "CHECK_FAILED" };
      return json(response, 500);
    }

    const tool = `${str(toolInfo.toolkit, "?")}.${str(toolInfo.name, "?")}`;
    audit([row(id, tool)]);

    const response: PreHookResult = {
      code: "CHECK_FAILED",
      error_message: withCorrelation(reasonFor(tool), id),
    };
    return json(response);
  };

  const handleHook = async (hook: HookPoint, request: Request): Promise<Response> => {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    /** The budget check at a stage boundary. Throws `Timeout` once it is spent. */
    const checkBudget = (stage: string): void => {
      if (elapsed() > config.deadlineMs) throw new Timeout(config.deadlineMs, elapsed(), stage);
    };
    /** The one asynchronous step, raced so a stalled body read cannot hang the call. */
    const readBody = (): Promise<string> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Timeout(config.deadlineMs, elapsed(), "reading the request body")),
          config.deadlineMs,
        );
      });
      return Promise.race([request.text(), deadline]).finally(() => clearTimeout(timer));
    };

    // Read the body once; the fail-closed path needs it for the audit rows.
    let raw: unknown = null;
    let outcome: Outcome<unknown> | null = null;
    let response: Response;
    try {
      const text = await readBody();
      raw = text.length > 0 ? JSON.parse(text) : null;
      checkBudget("parsing the request");
      const evaluated = evaluate(hook, raw);
      // Over budget after evaluating: the decision is discarded, not recorded,
      // and the call is denied. Arcade may already have given up on us; what
      // must not happen is an allow row for a call that was in fact refused.
      checkBudget("evaluating the policy");
      // Recorded before the response leaves. A decision that was made but not
      // written is the one thing a reviewer cannot recover later.
      record(db, evaluated.events, publish);
      outcome = evaluated;
      response = json(outcome.response);
    } catch (cause) {
      response = failClosed(hook, raw, cause);
      log(`${hook} FAILED CLOSED in ${Math.round(elapsed())}ms: ${String(cause)}`);
    }

    const ms = elapsed().toFixed(1);
    if (outcome !== null) {
      const first = outcome.events[0];
      const summary =
        outcome.events.length === 1 && first
          ? `${first.user_id || "?"} ${first.tool} → ${first.decision}${first.rule_id ? ` (${first.rule_id})` : ""}`
          : `${outcome.events.length} decision(s)`;
      log(`${hook} ${response.status} ${ms}ms ${summary}`);
    }
    return response;
  };

  /** Whether `POST /admin/reset` exists on this deployment, and why not. */
  const resetAvailable = resetEnabled(config) && deps.seed !== undefined;

  /**
   * **HTTP 200, always** (#112).
   *
   * This endpoint used to answer 503 while the policy failed to compile, which
   * read correctly as "the control plane is unhealthy" and worked out badly:
   * `render.yaml` points `healthCheckPath` here, so on 2026-09-14 a stale rule
   * that #89's guard refuses took cg-hooks out of rotation and Render served
   * its own 502 page over the top. The control plane was not failing closed,
   * it was unreachable — Arcade reported "tool access policy service could not
   * be reached", the panel went dark, and the one-off fix could not even be
   * verified over HTTP.
   *
   * So readiness here means "the process is up and can tell you what is
   * wrong", which is DESIGN.md's Readiness decision for every service in this
   * repo and the one thing cg-hooks did not do. The refusal lives where it
   * belongs: `/access`, `/pre` and `/post` keep failing closed on exactly the
   * same condition, and `status`, `policy.status`, `policy.error` and
   * `warnings` say so in the body a human can now actually read.
   */
  const health = (): Response => {
    const policy = cache.status();
    const drift = policy.fixture_drift;
    const warnings = [
      ...(policy.scanners.warning === null ? [] : [policy.scanners.warning]),
      ...(policy.status === "ready"
        ? []
        : [
            `the policy is ${policy.status} and every /access, /pre and /post call is being ` +
              `refused${policy.error === null ? "" : `: ${policy.error}`}`,
          ]),
      ...(drift === null ? [] : [driftWarning(drift)]),
      ...(policy.fixture_checked
        ? []
        : ["the on-disk policy was never compared to the shipped fixture, so drift is unknown"]),
    ];
    const body = {
      // `healthy` or `degraded`, both at 200 — `unhealthy` is gone, because
      // the only thing that ever set it is the case this endpoint now exists
      // to report rather than to disappear over. Both spellings are in the
      // generated HealthResponse vocabulary, so Arcade's periodic check still
      // reads it.
      status: policy.status === "ready" && drift === null ? "healthy" : "degraded",
      service: SERVICE,
      hook_contract: HOOK_CONTRACT_VERSION,
      policy,
      // Act 4's control, named rather than implied (#17). Not folded into
      // `status`: a service running the control run is working exactly as
      // asked, and 503-ing it would take the demo down instead of telling a
      // reader what is switched off. The warning is what makes it impossible
      // to boot with the scanners off and nobody the wiser.
      injection_detection: policy.scanners,
      // The four policy tables against the fixture in this image (#106), by
      // rule id. `null` is "the same policy, row for row". Anything else is
      // either a stage edit that is meant to survive a deploy or a fixture
      // change that never reached this disk, and the two are indistinguishable
      // from here — which is why this field names the rows instead of judging
      // them.
      fixture_drift: drift,
      // Named even when it is off, so the 404 a presenter gets from the Reset
      // button has somewhere to be explained.
      reset: resetAvailable ? "enabled" : "disabled",
      warnings,
      counts: counts(db),
      pending_approvals: pendingCount(db),
      audit_rows: auditCount(db),
      // "Did the panel actually connect?" needs an answer that is not the
      // panel itself, which is the surface most likely to be lying.
      stream_clients: bus?.subscribers ?? 0,
      failure_mode: "fail-closed",
    };
    return json(body);
  };

  return Bun.serve({
    port: config.port,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === HOOK_ENDPOINT_PATHS.healthCheck) {
        return request.method === "GET" ? health() : json({ error: "Method not allowed" }, 405);
      }

      if (pathname === RESET_PATH) {
        // Unset token, or no fixture to reset from: the route does not exist.
        // A 404 and not a 403, so an unconfigured deployment is
        // indistinguishable from one that never had the endpoint — see the
        // header comment in `reset-api.ts`. /health says `reset: "disabled"`,
        // which is where the explanation lives.
        const seed = deps.seed;
        if (!resetAvailable || seed === undefined) return json({ error: "Not found" }, 404);
        if (!bearerIs(request, config.resetToken)) return json({ error: "Unauthorized" }, 401);
        return handleReset(request, url, { db, cache, seed, log });
      }

      if (pathname === APPROVALS_PREFIX || pathname.startsWith(`${APPROVALS_PREFIX}/`)) {
        // The store's own bearer, not Arcade's. Refused before the path is
        // even matched, so an unauthorized caller cannot learn which ids exist
        // from the difference between a 404 and a 401.
        if (!bearerIs(request, config.approvalsStoreToken)) {
          return json({ error: "Unauthorized" }, 401);
        }
        const answered = await handleApprovals(request, pathname, {
          db,
          cache,
          now: ctx.now,
          ...(notices === undefined
            ? {}
            : { publishNotice: (notice) => notices.publish([notice]) }),
        });
        if (answered !== null) return answered;
        return json({ error: "Not found" }, 404);
      }

      if (pathname === AUDIT_PATH) {
        // Arcade's bearer, not the store's: these rows are the hooks' own
        // record, and the secret that writes them is the one that reads them.
        // The read is `db` directly and never the policy cache's handle — the
        // cache serves the hot path from memory and a reviewer paging the log
        // must not put a query back on it.
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
        return handleAudit(url, db);
      }

      if (pathname === EVENTS_PATH) {
        // No bearer, by decision — see the header comment in `events.ts`. The
        // preflight matters as much as the GET: the panel's browser asks
        // before it sends `last-event-id`.
        if (bus === undefined) return json({ error: "Not found" }, 404);
        if (request.method === "OPTIONS") return preflight();
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return handleEvents(request, {
          db,
          bus,
          ...(notices === undefined ? {} : { notices }),
          log,
          ...(deps.streamKeepAliveMs !== undefined && { keepAliveMs: deps.streamKeepAliveMs }),
          ...(deps.streamBacklogLimit !== undefined && { backlogLimit: deps.streamBacklogLimit }),
        });
      }

      const hook = HOOK_BY_PATH[pathname as HookPath];
      if (hook === undefined) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

      return handleHook(hook, request);
    },
  });
}

/**
 * `GET /audit` — the audit log, read over HTTP (#62).
 *
 *     GET /audit?user_id=dana.okafor@bank.example&hook=pre&decision=deny&limit=20
 *     Authorization: Bearer $ARCADE_HOOK_SIGNING_SECRET
 *
 *     { "rows": [ …GovernanceEvent… ], "count": 20, "total": 8278,
 *       "limit": 20, "order": "newest_first",
 *       "filters": { "user_id": "dana.okafor@bank.example", "hook": "pre", "decision": "deny" } }
 *
 * `rows` are `audit_log` rows exactly as the table holds them — the same
 * `GovernanceEvent` the stream carries, not the panel's derived shape, because
 * the question this endpoint answers is "what did the control plane decide, and
 * why", and a summary is the wrong thing to hand someone asking that.
 *
 * ## Three choices that are all the same choice
 *
 * A filter that does not do what its author thinks it does is this project's
 * recurring failure: a rule keyed on `get_loan` matches nothing, and nothing is
 * indistinguishable from permitted. The same trap is one query string away
 * here, so the endpoint refuses to be quietly approximate.
 *
 * - **An unknown query parameter is a 400**, not an ignored one. `?toolname=…`
 *   silently answered with the unfiltered log is a reviewer concluding the
 *   whole log is one tool's decisions.
 * - **A `limit` over the bound is a 400**, not a clamp. Clamping answers a
 *   question nobody asked and looks like an answer to the one they did.
 * - **`total` is counted without the limit.** A page that stops at the bound
 *   cannot, on its own, tell one listing's 8,278 denials from a runaway loop,
 *   which is precisely the question #62 was opened to answer — and #107's.
 *
 * ## Bearer, and which one
 *
 * The hook secret, the same one Arcade signs `/access`, `/pre` and `/post`
 * with — not the approvals store's. Rows carry decision reasons, which say
 * more than the model was told. They never carry a redacted value — a `/post`
 * row names the paths it removed and the rule that removed them, and nothing
 * else (#16) — so the bearer is about the reasons, not about secrets in the
 * rows. `/events` deliberately has none: it is fetched from a browser, and a
 * token shipped to a browser is not a token.
 */
import type { Database } from "bun:sqlite";

import { Effect, HookPoint } from "@cg/policy-schema";

import { search, type AuditFilter } from "./audit-log.ts";

export const AUDIT_PATH = "/audit";

/** Rows returned when the caller does not say. */
export const AUDIT_DEFAULT_LIMIT = 100;

/**
 * The most rows one request may ask for.
 *
 * A whole-project `/access` used to write a row per catalogue entry — 10,804
 * in the bench's 1.6 MB fixture, and 8,278 across the four calls of one live
 * `tools/list` — so a page
 * cannot promise to hold a burst; `total` is what says how much was left
 * behind, and `since` is how you walk the rest.
 */
export const AUDIT_MAX_LIMIT = 1000;

/** Exactly the parameters this endpoint understands. Anything else is a 400. */
const KNOWN_PARAMS = ["user_id", "tool", "hook", "decision", "since", "limit"] as const;

interface Rejected {
  readonly error: string;
}

export interface AuditResponseBody {
  readonly rows: unknown[];
  readonly count: number;
  readonly total: number;
  readonly limit: number;
  readonly order: "newest_first";
  /** The filters as applied, normalised. Absent keys were not filtered on. */
  readonly filters: Record<string, string>;
}

/**
 * Answer one `GET /audit`. Authorization has already happened in `server.ts`;
 * a request that reaches here carried the hook secret.
 */
export function handleAudit(url: URL, db: Database): Response {
  const json = (body: unknown, status = 200): Response => Response.json(body, { status });

  const parsed = parseFilter(url.searchParams);
  if ("error" in parsed) return json(parsed, 400);

  const { filter, echo } = parsed;
  const page = search(db, filter);

  const body: AuditResponseBody = {
    rows: page.rows,
    count: page.rows.length,
    total: page.total,
    limit: filter.limit,
    order: "newest_first",
    filters: echo,
  };
  return json(body);
}

interface ParsedFilter {
  readonly filter: AuditFilter;
  readonly echo: Record<string, string>;
}

function parseFilter(params: URLSearchParams): ParsedFilter | Rejected {
  for (const name of params.keys()) {
    if (!(KNOWN_PARAMS as readonly string[]).includes(name)) {
      return {
        error:
          `unknown query parameter '${name}'. ` +
          `This endpoint filters on ${KNOWN_PARAMS.join(", ")} and nothing else — ` +
          `ignoring it would answer with the whole log and look like a filtered one.`,
      };
    }
  }

  const echo: Record<string, string> = {};
  const filter: {
    user_id?: string;
    tool?: string;
    hook?: string;
    decision?: string;
    since?: string;
    limit: number;
  } = { limit: AUDIT_DEFAULT_LIMIT };

  const userId = params.get("user_id")?.trim();
  if (userId !== undefined && userId !== "") {
    filter.user_id = userId;
    echo.user_id = userId;
  }

  const tool = params.get("tool")?.trim();
  if (tool !== undefined && tool !== "") {
    filter.tool = tool;
    echo.tool = tool;
  }

  const hook = params.get("hook")?.trim();
  if (hook !== undefined && hook !== "") {
    const known = HookPoint.safeParse(hook);
    if (!known.success) {
      return { error: `unknown hook '${hook}'. Expected one of ${HookPoint.options.join(", ")}.` };
    }
    filter.hook = known.data;
    echo.hook = known.data;
  }

  const decision = params.get("decision")?.trim();
  if (decision !== undefined && decision !== "") {
    const known = Effect.safeParse(decision);
    if (!known.success) {
      return {
        error: `unknown decision '${decision}'. Expected one of ${Effect.options.join(", ")}.`,
      };
    }
    filter.decision = known.data;
    echo.decision = known.data;
  }

  const since = params.get("since")?.trim();
  if (since !== undefined && since !== "") {
    // Normalised to the exact form the column holds, so `since=2026-09-10` is
    // a usable filter and a lexicographic comparison is a chronological one.
    const at = new Date(since);
    if (Number.isNaN(at.getTime())) {
      return { error: `since '${since}' is not a date. Expected an ISO 8601 instant.` };
    }
    filter.since = at.toISOString();
    echo.since = filter.since;
  }

  const limit = params.get("limit")?.trim();
  if (limit !== undefined && limit !== "") {
    if (!/^\d+$/.test(limit)) {
      return { error: `limit '${limit}' is not a whole number.` };
    }
    const n = Number(limit);
    if (n < 1 || n > AUDIT_MAX_LIMIT) {
      return {
        error:
          `limit ${n} is outside 1..${AUDIT_MAX_LIMIT}. ` +
          `A limit outside the bound is refused rather than quietly clamped: ` +
          `read 'total' to see how many rows matched, and narrow with 'since'.`,
      };
    }
    filter.limit = n;
  }

  return { filter, echo };
}

/**
 * The tool list the page shows — **from the gateway, for this session**.
 *
 * Act 1's entire claim is that `Loan_ApproveLoan` is *absent* for Sam rather
 * than present-and-refused, and a list assembled in the browser could not make
 * that claim about anything. So this is one real `tools/list` over MCP with the
 * signed-in persona's gateway bearer, which is the same call
 * `lib/agent/handlers.ts` makes before a turn and the same call the agent's
 * toolset is built from. There is no second source and no client-side filter:
 * what a person reads on screen is what the model was handed.
 *
 * That is worth stating as a rule rather than an implementation detail. A UI
 * that filtered `ApproveLoan` out of a full catalogue would render exactly the
 * same pixels while proving the opposite thing, and everyone in the room would
 * be looking at a screenshot of a control that does nothing.
 *
 * ## What is filtered here, and why that is not the same filtering
 *
 * Two of the eight entries a live `tools/list` carries are Arcade's own —
 * `System_ManageAuthorization` and `Arcade_ListApps` (`DESIGN.md` → Tool
 * surface, measured on #82). They are dropped by `selectGoverned`'s allow-list
 * on the project's toolkits, exactly as the agent drops them, and they are
 * **reported** rather than silently removed: `filtered` is rendered under the
 * list so nobody has to take "eight became six" on trust. Hiding the fact of a
 * filter is the thing this module is careful about; hiding two gateway
 * built-ins from a loan officer is not.
 *
 * ## Every failure is named
 *
 * An empty list and a broken gateway look identical on a screen, and one of
 * them means "the control plane hid everything" while the other means nothing
 * at all. So the result is a union: either tools, or a sentence saying what
 * went wrong. Nothing here returns `[]` to mean "we could not ask".
 *
 * **Three sentences, not one, for the empty case (#94).** A gateway that has
 * stopped accepting this browser's bearer answers `listToolsets()` with the
 * same `{}` a dead control plane does, so an empty list asks the gateway about
 * the credential before it names `/access`. Telling a presenter to go and check
 * the control plane when the fix is one click on the gateway hop is the failure
 * #94 is the record of, arriving on a different screen.
 */
import { readIdentitySurface, type IdentitySurface } from "../config.ts";
import { GATEWAY_START_PATH, liveGatewayToken, refreshedGatewayToken } from "../identity/handlers.ts";
import { mcpUrl, probeGatewayToken } from "../identity/gateway.ts";
import type { Session } from "../identity/session.ts";
import { gatewayClient, selectGoverned, SERVER_KEY, GATEWAY_BUILTINS } from "./tools.ts";

export { GATEWAY_BUILTINS };

/** One entry as `tools/list` advertised it: the wire name and what the model reads. */
export interface GatewayTool {
  /** `Loan_ApproveLoan` — the underscore spelling MCP carries. */
  name: string;
  description: string;
}

export type SessionTools =
  /** `tools` are the governed ones, in the gateway's own order. `filtered` is what was dropped. */
  | { ok: true; tools: GatewayTool[]; filtered: string[] }
  /** Why there is no list. Rendered as a sentence; never collapsed to an empty list. */
  | { ok: false; reason: string };

/** A page render should not sit on a cold gateway for a whole turn's worth of time. */
const LIST_TIMEOUT_MS = 15_000;

export interface SessionToolsOptions {
  config?: IdentitySurface;
  timeoutMs?: number;
}

/**
 * List the tools this browser's persona can see.
 *
 * Total: a missing session, a missing token and an unreachable gateway all come
 * back as `{ ok: false, reason }` rather than as a throw, because the caller is
 * a server component rendering a page that has other things on it.
 *
 * **A refreshed gateway token is used and not persisted.** `liveGatewayToken`
 * may mint a new access token, and a server component cannot set a cookie — so
 * the token is spent on this one call and the session cookie keeps the old one
 * until the next request that *can* reseal it (`POST /api/chat`, which does).
 * The cost is one extra refresh; the alternative is a page that either cannot
 * list tools for a persona whose token is aging out, or quietly fails to store
 * the new one and looks like it did.
 *
 * **And a refusal is refreshed through, once (#113).** The same asymmetry the
 * chat route has: `expires_at` is this service's note to itself and the gateway
 * is the only one that decides. A 401 with a refresh token in the cookie is not
 * a person's problem yet, so it is refreshed and asked again — and only a
 * refresh that itself fails puts the re-authorize sentence on the page. Which
 * is also why act 1 does not go blank halfway through a rehearsal: the tool
 * list is the act's entire claim, and "the gateway would tell us nothing" and
 * "policy hid it" look identical on a screen.
 */
export async function sessionTools(
  session: Session | null,
  options: SessionToolsOptions = {},
): Promise<SessionTools> {
  const config = options.config ?? readIdentitySurface();

  if (!session) return { ok: false, reason: "Nobody is signed in on this browser, so there is no persona to list tools for." };
  if (!config.identity.gatewayId) {
    return { ok: false, reason: "ARCADE_GATEWAY_ID is not set on this deployment, so there is no gateway to ask." };
  }

  const live = await liveGatewayToken(session, config);
  if (live.token === null) {
    return { ok: false, reason: `${live.reason}, so the gateway cannot be asked what this persona may see.` };
  }

  const first = await listWith(live.token, config, options);
  if (first.outcome !== "rejected") return first.answer;
  const refusal = `The gateway answered ${first.status} to this browser's gateway token`;

  // The gateway refused a bearer whose clock says it is live. One refresh, one
  // more ask, and no loop after that — the same shape and the same reasoning as
  // `lib/agent/handlers.ts`, which is the route this page is about to send the
  // person to.
  const renewed = await refreshedGatewayToken(live.session, config);
  if (renewed.token === null) {
    // The refresh failed too, so there is a person's click left in this and the
    // sentence has to carry it. Same three facts #94 settled on: what happened,
    // that policy hid nothing, and where to go.
    return {
      ok: false,
      reason:
        `${refusal}, and ${renewed.reason}. Nothing was hidden by policy — this is hop 1, ` +
        `upstream of every hook. Authorize the gateway again at ${GATEWAY_START_PATH}.`,
    };
  }
  const second = await listWith(renewed.token, config, options);
  return second.answer;
}

/**
 * One `tools/list` with one bearer, and whether the gateway refused it.
 *
 * `rejected` is lifted out of the answer rather than folded into it because it
 * is the one outcome with something left to try. Everything else is already
 * final — a list, or a sentence about why there is none.
 */
async function listWith(
  token: string,
  config: IdentitySurface,
  options: SessionToolsOptions,
): Promise<{ outcome: "final"; answer: SessionTools } | { outcome: "rejected"; status: number; answer: SessionTools }> {
  const final = (answer: SessionTools) => ({ outcome: "final" as const, answer });

  const client = gatewayClient({
    arcadeApiUrl: config.arcadeApiUrl,
    gatewayId: config.identity.gatewayId,
    token,
    timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS,
  });

  try {
    const toolsets = await client.listToolsets();
    const advertised = (toolsets[SERVER_KEY] ?? {}) as Record<string, unknown>;

    // Measured, and it is the whole reason this branch exists: `listToolsets()`
    // does **not** throw when the gateway answers a JSON-RPC error. It logs and
    // returns `{}`, so a control plane whose `/access` cannot be reached — which
    // makes the gateway hide everything and say so — arrives here looking
    // exactly like a persona the policy permits nothing.
    //
    // Those are opposite facts. A live `tools/list` carries eight entries for a
    // signed-in persona and at minimum the gateway's own two built-ins, which
    // no policy of ours reaches (DESIGN.md → Tool surface). So zero is not a
    // small answer, it is no answer, and it is reported as one.
    if (Object.keys(advertised).length === 0) {
      // Empty is no answer — and there is more than one reason for no answer.
      // A gateway that refuses the bearer produces this *exact* empty object
      // (#94), so the bearer is asked about before the control plane is blamed;
      // otherwise this page tells a presenter to go and check `/access` when the
      // fix is one click on the gateway hop.
      //
      // The token is not cleared here. A server component cannot set a cookie,
      // so the dropping is `POST /api/chat`'s job and this surface only reports.
      const probe = await probeGatewayToken(mcpUrl(config.arcadeApiUrl, config.identity.gatewayId), token);
      if (probe.outcome === "rejected") {
        return {
          outcome: "rejected" as const,
          status: probe.status,
          answer: {
            ok: false,
            reason:
              `The gateway answered ${probe.status} to this browser's gateway token, so there is ` +
              `nothing it will list for this persona. Nothing was hidden by policy — this is hop 1, ` +
              `upstream of every hook. Authorize the gateway again at ${GATEWAY_START_PATH}.`,
          },
        };
      }
      if (probe.outcome === "unreachable") {
        return final({
          ok: false,
          reason: `The gateway could not be reached: ${probe.detail}. Nothing was asked of the control plane.`,
        });
      }
      return final({
        ok: false,
        reason:
          "The gateway listed no tools at all — not even its own built-ins, which every answer " +
          "carries. That is the list failing to come back, not a persona who may use nothing; " +
          "check that the control plane is answering /access.",
      });
    }

    const { governed, dropped } = selectGoverned(advertised, { toolkits: config.agent.toolkits });
    return final({
      ok: true,
      tools: Object.entries(governed).map(([name, tool]) => ({ name, description: describe(tool) })),
      filtered: dropped,
    });
  } catch (cause) {
    return final({
      ok: false,
      reason: `The gateway would not list its tools: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  } finally {
    // The connection belongs to this request and this persona, exactly as it
    // does for a turn: leaving it open would leave a bearer alive in a process
    // that serves every other persona too.
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * The description the gateway advertised, or an honest blank.
 *
 * Read defensively and never invented. The description is the sentence the
 * *model* picks a tool from, so a plausible one written here would be a
 * different tool surface on screen from the one in the model's context — the
 * same class of lie as filtering client-side, arriving one field down.
 */
function describe(tool: unknown): string {
  if (typeof tool !== "object" || tool === null) return "";
  const description = (tool as { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

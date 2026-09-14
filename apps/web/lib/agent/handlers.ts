/**
 * `POST /api/chat` — one turn of the agent, streamed.
 *
 * A plain `(Request) => Promise<Response>`, for the same reason every identity
 * route is one (`lib/identity/cookies.ts`): the suite mounts this exact
 * function behind a real `Bun.serve` and drives it over HTTP with a cookie jar,
 * against a real control plane and a real loan book. `app/api/chat/route.ts` is
 * a one-line adapter onto it.
 *
 * ## Who the turn is made as
 *
 * The persona comes from this browser's sealed session and from nowhere else.
 * There is no branch in this file that reads an identity from the body, the
 * query string or a header — the same rule the verifier route holds to, for the
 * same reason: an actor the request can name is an actor the model can forge
 * (`DESIGN.md` rule 1, and act 4 is the model trying).
 *
 * "Acting as Dana" means **signed in as Dana in this browser**. That is the
 * whole mechanism.
 *
 * ## What it refuses, and why each refusal is separate
 *
 * Four different things can be wrong before a single token is spent, and they
 * have four different fixes:
 *
 *   - the environment is not configured   → 503, naming the variables
 *   - nobody is signed in                 → 401, pointing at sign-in
 *   - signed in, but no gateway token     → 401, pointing at the gateway hop
 *   - the gateway advertised no governed tools → 502
 *
 * The last one is the interesting one. An agent with no tools still answers —
 * fluently, from memory, about a loan book it never read. That is the worst
 * possible output of this demo, so an empty toolset is an error rather than a
 * turn. It is also the shape a wrong `ARCADE_LOAN_TOOLKIT` or
 * `ARCADE_APPROVALS_TOOLKIT` takes.
 */
import { agentProblems, readIdentitySurface, type IdentitySurface } from "../config.ts";
import { anthropicModel, buildAgent } from "./agent.ts";
import { CHAT_PATH, encodeEvent, NDJSON, type ChatEvent } from "./events.ts";
import { liveGatewayToken, GATEWAY_START_PATH, SIGNIN_PATH } from "../identity/handlers.ts";
import { gatewayClient, governedToolset } from "./tools.ts";
import { readSession, writeSession, type Session } from "../identity/session.ts";
import { runTurn, type Streamable } from "./run.ts";

// Defined in `events.ts` — the client component needs it too, and importing it
// from here dragged `@mastra/mcp` into the browser bundle. Re-exported so a
// server-side caller has one place to look.
export { CHAT_PATH };

/** How long a single MCP request may take. Well inside a turn, well outside a cold gateway. */
const MCP_TIMEOUT_MS = 30_000;

/**
 * The model, injectable.
 *
 * The seam #14 needs: the suite drives this whole handler — real session, real
 * gateway transport, real `/pre`, real `loans.db` — with a scripted model on a
 * machine that has no Anthropic key, and with the real one when there is a key.
 * Everything on both sides of the model is the same code in both runs, which is
 * what makes the keyless run worth anything at all.
 *
 * `undefined` means "build the real one from the environment", which is what
 * the deployed service always does.
 */
export type ModelFactory = (config: IdentitySurface) => unknown;

export interface ChatOptions {
  config?: IdentitySurface;
  model?: ModelFactory;
  /** Only for tests, which need to see what the gateway advertised. */
  onToolSurface?: (surface: { advertised: string[]; governed: string[]; dropped: string[] }) => void;
}

/** One JSON object, for the four refusals. Never a stream — there is nothing to stream. */
function refuse(status: number, message: string, detail?: unknown): Response {
  return Response.json({ error: message, ...(detail === undefined ? {} : { detail }) }, { status });
}

export async function chat(request: Request, options: ChatOptions = {}): Promise<Response> {
  const config = options.config ?? readIdentitySurface();

  if (request.method !== "POST") return refuse(405, "POST a { prompt } to this route.");

  const problems = agentProblems(config);
  if (problems.length > 0) {
    return refuse(503, "The agent is not configured on this deployment.", problems);
  }

  const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (prompt === "") return refuse(400, "Send a non-empty `prompt`.");

  const session = await readSession(request, config);
  if (!session) {
    return refuse(401, `Nobody is signed in on this browser. Sign in at ${SIGNIN_PATH}.`);
  }

  const live = await liveGatewayToken(session, config);
  if (live.token === null) {
    return refuse(401, `${live.reason}. Authorize the gateway at ${GATEWAY_START_PATH}.`);
  }

  const client = gatewayClient({
    arcadeApiUrl: config.arcadeApiUrl,
    gatewayId: config.identity.gatewayId,
    token: live.token,
    timeoutMs: MCP_TIMEOUT_MS,
  });

  let selected: Awaited<ReturnType<typeof governedToolset>>;
  try {
    selected = await governedToolset(client, { toolkits: config.agent.toolkits });
  } catch (cause) {
    await client.disconnect().catch(() => undefined);
    return refuse(502, `The gateway would not list its tools: ${String(cause)}`);
  }

  options.onToolSurface?.({
    advertised: selected.advertised,
    governed: Object.keys(selected.tools),
    dropped: selected.dropped,
  });

  // Nothing at all came back. A different fault from "none of them are ours",
  // and naming the wrong one sends somebody to check a toolkit variable while
  // the control plane is down. `listToolsets()` does not throw on a JSON-RPC
  // error — it logs and returns `{}` — so this is the only place that failure
  // is visible, and a live answer always carries the gateway's own built-ins
  // even when policy hides every project tool (#15).
  if (selected.advertised.length === 0) {
    await client.disconnect().catch(() => undefined);
    return refuse(
      502,
      `The gateway listed no tools at all — not even its own built-ins, which every answer ` +
        `carries. That is the list failing to come back rather than a persona who may use ` +
        `nothing; check that the control plane is answering /access.`,
    );
  }

  if (Object.keys(selected.tools).length === 0) {
    await client.disconnect().catch(() => undefined);
    return refuse(
      502,
      `The gateway advertised ${selected.advertised.length} tools and none of them belong to ` +
        `${config.agent.toolkits.map((name) => `"${name}"`).join(" or ")}, so this agent has ` +
        `nothing to call. Check ARCADE_LOAN_TOOLKIT and ARCADE_APPROVALS_TOOLKIT against a real ` +
        `tools/list.`,
      selected.dropped,
    );
  }

  const agent = buildAgent({
    model: (options.model?.(config) ??
      anthropicModel({ modelId: config.agent.modelId, apiKey: config.agent.anthropicApiKey })) as never,
    tools: selected.tools,
  }) as unknown as Streamable;

  // A refreshed gateway token has to be resealed, and the only place to do it
  // is a header on this response — the stream body cannot set one later. So the
  // cookie is written before the first byte, whether or not the turn succeeds.
  const headers = new Headers({ "content-type": NDJSON, "cache-control": "no-store" });
  if (live.session !== session) await writeSession(headers, request, live.session as Session, config);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      try {
        await runTurn({ agent, prompt, emit });
      } finally {
        // The MCP connection belongs to this turn and this persona. Leaving it
        // open would leave a bearer token alive in a process that serves every
        // other persona too.
        await client.disconnect().catch(() => undefined);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers });
}

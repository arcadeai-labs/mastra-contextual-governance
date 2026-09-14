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
 * Seven different things can be wrong before a single token is spent, and they
 * have seven different fixes:
 *
 *   - the environment is not configured   → 503, naming the variables
 *   - nobody is signed in                 → 401, pointing at sign-in
 *   - signed in, never ran hop 1          → 401, pointing at the gateway hop
 *   - the gateway will not take this browser's bearer → a `re-authorize` turn
 *   - the gateway could not be reached at all  → 502, as plumbing
 *   - the gateway listed nothing at all        → 502, naming the control plane
 *   - the gateway advertised no *governed* tools → 502, naming the toolkit
 *
 * The last four are one symptom — an agent with no tools — and four different
 * causes, and every split between them was paid for. An agent with no tools
 * still answers, fluently, from memory, about a loan book it never read, which
 * is the worst possible output of this demo; so all four are errors rather than
 * turns, and the only question is which sentence goes on screen.
 *
 * #15 split the last two: a live `tools/list` always carries the gateway's own
 * two built-ins even when policy hides every project tool, so **zero**
 * advertised entries is the list failing to come back rather than a narrow
 * persona, and naming the wrong one sends somebody to a toolkit variable while
 * the control plane is down.
 *
 * #94 split the first two off the front, and for the same reason one layer up.
 * `listToolsets()` does not throw when the gateway refuses the bearer — it logs
 * and resolves with `{}` — so a dead token and a mistyped `ARCADE_LOAN_TOOLKIT`
 * produced the same value and therefore the same message. Live, on 2026-09-14,
 * that message sent a person to check two environment variables that were
 * correct while the actual fix was one click on `/api/arcade/start`. So the
 * bearer is asked about **before** the toolset is read, with one raw
 * `initialize` (`probeGatewayToken`), and `governedToolset` reads
 * `listToolsetsWithErrors()` so that "no listing arrived" is a different value
 * from "a listing arrived carrying none of ours".
 *
 * ## And the thing nobody anticipated
 *
 * Everything above is a refusal: a sentence, a status, a fix. Anything else
 * that throws before the first byte is not — it is a bug — and #92 is the
 * record of what an unshaped one costs. `PRE_STREAM` names each step of this
 * section and the `catch` at the bottom answers `serverFault(step, cause)`, so
 * a break says *which* step broke rather than `500`.
 *
 * The section is bounded deliberately. Once the `ReadableStream` is returned
 * the status is already sent and there is nothing left to shape; a failure
 * after that is a `fault` **event** on the stream, which `run.ts` owns.
 */
import { agentProblems, readIdentitySurface, type IdentitySurface } from "../config.ts";
import { anthropicModel, buildAgent } from "./agent.ts";
import { CHAT_PATH, encodeEvent, NDJSON, type ChatEvent } from "./events.ts";
import { serverFault } from "./fault.ts";
import { liveGatewayToken, GATEWAY_START_PATH, SIGNIN_PATH } from "../identity/handlers.ts";
import { mcpUrl, probeGatewayToken } from "../identity/gateway.ts";
import { gatewayClient, governedToolset } from "./tools.ts";
import { gatewayTokenRejected, readSession, writeSession, type Session } from "../identity/session.ts";
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

/**
 * One JSON object, for a refusal that is not a turn. Never a stream — there is
 * nothing to stream. The one pre-stream outcome that *is* a stream is
 * `reauthorize`, and it is a stream because it has a link to carry.
 */
function refuse(status: number, message: string, detail?: unknown): Response {
  return Response.json({ error: message, ...(detail === undefined ? {} : { detail }) }, { status });
}

/**
 * Every step between the request arriving and the first byte leaving, in order.
 *
 * Exported so the suite asserts on the same strings the response carries rather
 * than on a copy of them, and so a reader can see the whole pre-stream section
 * as a list without reading the function.
 */
export const PRE_STREAM = {
  body: "read the request body",
  session: "open the session cookie",
  token: "refresh this browser's gateway token",
  client: "build the MCP client for the gateway",
  probe: "ask the gateway whether it accepts this browser's token",
  agent: "build the agent and its model",
  seal: "reseal the refreshed session cookie",
} as const;

/**
 * Where a person is sent back to after re-running hop 1 from a chat turn.
 *
 * The page, not `CHAT_PATH`, which is the route the browser POSTs to. Sending
 * somebody to the API would answer them with a JSON refusal about a missing
 * prompt.
 */
const CHAT_PAGE = "/chat";

export async function chat(request: Request, options: ChatOptions = {}): Promise<Response> {
  const config = options.config ?? readIdentitySurface();

  if (request.method !== "POST") return refuse(405, "POST a { prompt } to this route.");

  const problems = agentProblems(config);
  if (problems.length > 0) {
    return refuse(503, "The agent is not configured on this deployment.", problems);
  }

  // Named before each step rather than after, so whatever throws is attributed
  // to the step that was running. Held outside the `try` because the `catch`
  // reads it, and so is the client: a throw after it is built still has to hand
  // back this persona's bearer.
  let step: string = PRE_STREAM.body;
  let client: ReturnType<typeof gatewayClient> | null = null;

  try {
    const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (prompt === "") return refuse(400, "Send a non-empty `prompt`.");

    step = PRE_STREAM.session;
    const session = await readSession(request, config);
    if (!session) {
      return refuse(401, `Nobody is signed in on this browser. Sign in at ${SIGNIN_PATH}.`);
    }

    step = PRE_STREAM.token;
    const live = await liveGatewayToken(session, config);
    if (live.token === null) {
      // Hop 1 has never run on this browser: an ordinary refusal, with the hop
      // to run named in it. The chat page says the same thing above the box.
      if (!session.gateway) {
        return refuse(401, `${live.reason}. Authorize the gateway at ${GATEWAY_START_PATH}.`);
      }
      // There *was* a token and it can no longer be made live — the refresh was
      // refused, or it expired with nothing to refresh it with. Same ending as a
      // rejection, because what this browser holds is equally dead.
      return reauthorize(request, config, session, live.reason);
    }

    step = PRE_STREAM.client;
    client = gatewayClient({
      arcadeApiUrl: config.arcadeApiUrl,
      gatewayId: config.identity.gatewayId,
      token: live.token,
      timeoutMs: MCP_TIMEOUT_MS,
    });

    // One round trip, before the toolset, to find out whether the gateway still
    // takes this bearer — because `listToolsets()` will not say (#94, and
    // `probeGatewayToken` has the measurement). It runs after the client is
    // built, not before, so an `ARCADE_API_URL` that is not a URL still fails at
    // the step that names it.
    step = PRE_STREAM.probe;
    const gatewayUrl = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
    const probe = await probeGatewayToken(gatewayUrl, live.token);
    if (probe.outcome === "rejected") {
      await client.disconnect().catch(() => undefined);
      // The status, never the token. This line is the one a Render log needs.
      console.warn(`[chat] ${gatewayUrl} answered ${probe.status} to this browser's gateway token`);
      return reauthorize(
        request,
        config,
        live.session,
        `the gateway answered ${probe.status} to this browser's gateway token`,
      );
    }
    if (probe.outcome === "unreachable") {
      await client.disconnect().catch(() => undefined);
      // Not a credential and not a toolkit name. Nobody refused anything.
      return refuse(502, `The gateway at ${gatewayUrl} could not be reached: ${probe.detail}`);
    }

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

    // The bearer was accepted a moment ago, so a listing that never arrived is
    // plumbing — and saying "check ARCADE_LOAN_TOOLKIT" about it would be the
    // same wrong sentence #94 is about, one cause further along (#94).
    if (selected.error) {
      await client.disconnect().catch(() => undefined);
      return refuse(502, `The gateway would not list its tools: ${selected.error}`);
    }

    // A listing that *did* arrive and carried nothing at all — not even the
    // gateway's own built-ins, which every live answer carries even when policy
    // hides every project tool. That is a dead control plane, not a narrow
    // persona and not a toolkit name (#15).
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

    step = PRE_STREAM.agent;
    const agent = buildAgent({
      model: (options.model?.(config) ??
        anthropicModel({ modelId: config.agent.modelId, apiKey: config.agent.anthropicApiKey })) as never,
      tools: selected.tools,
    }) as unknown as Streamable;

    // A refreshed gateway token has to be resealed, and the only place to do it
    // is a header on this response — the stream body cannot set one later. So the
    // cookie is written before the first byte, whether or not the turn succeeds.
    step = PRE_STREAM.seal;
    const headers = new Headers({ "content-type": NDJSON, "cache-control": "no-store" });
    if (live.session !== session) await writeSession(headers, request, live.session as Session, config);

    return streamTurn({ agent, prompt, client, headers });
  } catch (cause) {
    // The connection belongs to a turn that will never happen. Same reason the
    // stream's `finally` closes it: an open transport is a live bearer token.
    await client?.disconnect().catch(() => undefined);
    return serverFault(step, cause);
  }
}

/**
 * The one answer for "this browser cannot present a bearer the gateway will
 * take", whether the refresh died or the gateway refused what we had.
 *
 * **It is a stream, not a refusal, and the status is 200.** `Chat.tsx` reads a
 * non-2xx as a sentence and renders it as flat red text; the one thing this
 * answer has to carry is a link somebody can click, and the only event kind that
 * renders as one is `authorization`. That is also the truthful shape rather than
 * a convenient one: hop 1 is upstream of every hook, so nothing was denied, no
 * rule ran and no audit row exists — which is exactly what `authorization`
 * means on this stream (`events.ts`). A `denied` here would be the UI claiming
 * a control-plane decision that never happened.
 *
 * The dead bearer is dropped from the sealed session on the way out and the
 * sign-in is left alone, so the next `/` or `/chat` shows *Gateway token:
 * rejected* and one link rather than a fresh password prompt. The token itself
 * appears in neither the event nor the log.
 */
async function reauthorize(
  request: Request,
  config: IdentitySurface,
  session: Session,
  reason: string,
): Promise<Response> {
  const headers = new Headers({ "content-type": NDJSON, "cache-control": "no-store" });
  await writeSession(headers, request, gatewayTokenRejected(session), config);

  const events: ChatEvent[] = [
    {
      kind: "authorization",
      // Not a tool: the gateway itself, named as the deployment names it. Layer
      // 2 challenges put a wire tool name here; this is hop 1, one layer up.
      tool: config.identity.gatewayId,
      url: `${GATEWAY_START_PATH}?next=${encodeURIComponent(CHAT_PAGE)}`,
      instructions:
        `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. This is hop 1 — the gateway, upstream of ` +
        `every hook — so nothing was denied, no rule ran and nothing was written to the audit log. ` +
        `You are still signed in as ${session.email}: authorize the gateway again and ask the same ` +
        `question.`,
    },
    { kind: "done", calls: 0 },
  ];

  return new Response(events.map(encodeEvent).join(""), { headers });
}

/**
 * The streamed half, from the first byte on.
 *
 * Split out so the `try` above ends exactly where the pre-stream section does.
 * Nothing in here can become a status code — the response has already been
 * handed back by the time `start` runs — so a failure inside is `run.ts`'s
 * `fault` event instead.
 */
function streamTurn(turn: {
  agent: Streamable;
  prompt: string;
  client: ReturnType<typeof gatewayClient>;
  headers: Headers;
}): Response {
  const { agent, prompt, client, headers } = turn;
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

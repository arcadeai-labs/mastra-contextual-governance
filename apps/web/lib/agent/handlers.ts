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
 * "Acting as Alice" means **signed in as Alice in this browser**. That is the
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
 *   - the gateway will not take this browser's bearer → one server-side refresh,
 *     and a `re-authorize` turn only if that refresh fails too (#113)
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
 *
 * ## Two ways a turn starts (#20)
 *
 * `{ prompt }` is a person asking something. `{ resume: { request_id, prompt,
 * reply } }` is the UI starting the next turn because an approval was decided
 * — `DESIGN.md` → The wait: *"Agent ends its turn; SSE `approval.granted` event
 * auto-resumes it."*
 *
 * Everything above about identity holds unchanged, and one thing is added to
 * it: **the resume's facts are read from the approvals store, never taken from
 * the browser.** The browser names an id and hands back the previous turn as
 * context; this route then reads `GET /approvals/{id}` with its own bearer and
 * builds the injected message from that record alone (`resume.ts`). A request
 * that does not read back as decided, or whose requester is not the persona
 * signed in here, is a `fault` — nothing decided anything, so nothing on
 * screen may say it did.
 */
import { agentProblems, readIdentitySurface, readWebConfig, type IdentitySurface } from "../config.ts";
import { fetchApproval } from "../approvals-store.ts";
import { readConversationHistory, withPrompt, type ConversationMessage } from "./conversation.ts";
import { closeTurnOnEscalation } from "./escalation.ts";
import { planResume, readResumeRequest, type ResumeRequest } from "./resume.ts";
import { anthropicModel, buildAgent } from "./agent.ts";
import { CHAT_PATH, encodeEvent, NDJSON, type ChatEvent } from "./events.ts";
import { serverFault } from "./fault.ts";
import { CHAT_PAGE, liveGatewayToken, refreshedGatewayToken, GATEWAY_START_PATH,
  SIGNIN_PATH } from "../identity/handlers.ts";
import { mcpUrl, probeGatewayToken } from "../identity/gateway.ts";
import { gatewayClient, governedToolset, SERVER_KEY } from "./tools.ts";
import { createNativeElicitationBridge } from "./native-elicitation.ts";
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
  /**
   * Where the approvals store is and what bearer reaches it — #20's resume
   * path reads `GET /approvals/{id}` itself rather than believing the browser.
   *
   * Optional, and resolved lazily from the environment when a resume actually
   * arrives, so an ordinary turn is unaffected by a deployment that has no
   * store configured. The suite supplies it because its store runs on an
   * OS-assigned port.
   */
  store?: { hooksHost: string; approvalsStoreToken: string };
  /** Only for tests, which need to see what the gateway advertised. */
  onToolSurface?: (surface: { advertised: string[]; governed: string[]; dropped: string[] }) => void;
}

/**
 * One JSON object, for a refusal that is not a turn. Never a stream — there is
 * nothing to stream. The one pre-stream outcome that *is* a stream is
 * `reauthorize`, and it is a stream because it has a link to carry.
 *
 * `headers` carries the resealed session cookie when there is one. A refusal is
 * still a response, and a turn that refreshed the gateway token and then
 * refused for some *other* reason has to hand the new token back to the browser
 * anyway — otherwise the refresh is spent and lost, and with an authorization
 * server that rotates refresh tokens, losing it costs the session (#113).
 */
function refuse(status: number, message: string, detail?: unknown, headers?: Headers): Response {
  return Response.json(
    { error: message, ...(detail === undefined ? {} : { detail }) },
    { status, ...(headers ? { headers } : {}) },
  );
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
  retry: "refresh the token the gateway just refused, and ask it once more",
  seal: "reseal the refreshed session cookie",
  approval: "read the approval this turn resumes",
  agent: "build the agent and its model",
} as const;

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
  // Native URL elicitation can arrive while the agent has already queued
  // sibling tool dispatches. The callback closes the wrapped toolset at the
  // protocol boundary; `runTurn` closes it again when it consumes the event.
  let closeAuthorization: (() => void) | undefined;
  const nativeElicitation = createNativeElicitationBridge({
    onRequest: () => closeAuthorization?.(),
  });

  try {
    const body = (await request.json().catch(() => null)) as {
      prompt?: unknown;
      history?: unknown;
      messages?: unknown;
    } | null;
    // Two shapes, one route. `{ prompt }` opens a turn; `{ resume: { … } }` is
    // the UI starting the next one because an approval was decided (#20). The
    // resume is read here and acted on further down, once there is a session
    // to check its requester against.
    const resume = readResumeRequest(body);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    // `history` is the browser's bounded, in-memory conversation. `messages`
    // is accepted as an equivalent spelling for callers already using
    // Mastra's vocabulary; neither field carries identity or authority.
    const history = readConversationHistory(body?.history ?? body?.messages);
    if (resume === null && prompt === "") {
      return refuse(400, "Send a non-empty `prompt`, or a `resume` naming an approval request.");
    }

    step = PRE_STREAM.session;
    const session = await readSession(request, config);
    if (!session) {
      return refuse(401, `Nobody is signed in on this browser. Sign in at ${SIGNIN_PATH}.`);
    }

    step = PRE_STREAM.token;
    const live = await liveGatewayToken(session, config);
    if (live.token === null) {
      // Hop 1 has never run on this browser — no token, and no record of one
      // having been refused. There is nothing to re-authorize and nothing dead
      // to drop, so this is an ordinary refusal with the hop named in it, and
      // the chat page says the same thing above the box before anyone presses
      // Send.
      if (!session.gateway && !session.gateway_rejected_at) {
        return refuse(401, `${live.reason}. Authorize the gateway at ${GATEWAY_START_PATH}.`);
      }
      // Everything else: a bearer that was refused and dropped on an earlier
      // turn, a refresh the authorization server would not honour, or a token
      // that expired with nothing to refresh it with. One answer for all of
      // them, and the same answer the rejecting turn itself gives.
      //
      // Round 1 of #98's review found the first of those three falling through
      // to the flat 401 above: the *rejecting* turn streamed a clickable link,
      // and the very next Send answered `{"error":"this browser holds no
      // gateway token…"}`, which `Chat.tsx` renders as unlinkable red text
      // after clearing the events that had the link in them. A recovery path
      // that only exists on one turn is not a recovery path.
      return reauthorize(request, config, session, live.reason);
    }

    // The bearer and the session this turn runs with, from here on. Both can
    // change once — see the refusal branch below — and everything downstream
    // reads these rather than `live`, so a turn that refreshed mid-flight
    // reseals the session it actually used.
    let bearer = live.token;
    let current = live.session;

    step = PRE_STREAM.client;
    client = gatewayClient({
      arcadeApiUrl: config.arcadeApiUrl,
      gatewayId: config.identity.gatewayId,
      token: bearer,
      timeoutMs: MCP_TIMEOUT_MS,
    });
    await client.elicitation.onRequest(SERVER_KEY, nativeElicitation.handle);

    // One round trip, before the toolset, to find out whether the gateway still
    // takes this bearer — because `listToolsets()` will not say (#94, and
    // `probeGatewayToken` has the measurement). It runs after the client is
    // built, not before, so an `ARCADE_API_URL` that is not a URL still fails at
    // the step that names it.
    step = PRE_STREAM.probe;
    const gatewayUrl = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
    let probe = await probeGatewayToken(gatewayUrl, bearer);

    if (probe.outcome === "rejected") {
      // #113. A refusal here is not yet a reason to fetch a human. `live` was
      // built from `expires_at`, and the gateway has just said that number is
      // wrong — so refresh against the refresh token in the sealed cookie and
      // ask exactly once more.
      //
      // **Once.** The retry is not a loop and there is no second one: if the
      // gateway refuses a bearer it minted seconds ago, nothing this service
      // can do unassisted will change that, and turning the failure into a
      // retry storm would spend a person's credentials against a gateway
      // already saying no.
      //
      // The old client goes first. It holds the refused bearer in its auth
      // provider and there is no way to put a different one into it, so the
      // retry needs a new client rather than a reconnect — which is also why
      // nothing here is ever cached across requests (`tools.ts`).
      await client.disconnect().catch(() => undefined);
      client = null;
      // The status, never the token. This line is the one a Render log needs,
      // and it is the first half of every sentence below: the gateway's own
      // word about the credential (#94).
      const refusal = `the gateway answered ${probe.status} to this browser's gateway token`;
      console.warn(`[chat] ${gatewayUrl} answered ${probe.status} to this browser's gateway token; refreshing it once`);

      step = PRE_STREAM.retry;
      const renewed = await refreshedGatewayToken(current, config);
      if (renewed.token === null) {
        // The refresh itself failed. *Now* the card is the truthful answer, and
        // it carries both halves: what the gateway said, and why the refresh
        // could not answer it (#94).
        return reauthorize(request, config, current, `${refusal}, and ${renewed.reason}`);
      }
      bearer = renewed.token;
      current = renewed.session;

      client = gatewayClient({
        arcadeApiUrl: config.arcadeApiUrl,
        gatewayId: config.identity.gatewayId,
        token: bearer,
        timeoutMs: MCP_TIMEOUT_MS,
      });
      await client.elicitation.onRequest(SERVER_KEY, nativeElicitation.handle);
      probe = await probeGatewayToken(gatewayUrl, bearer);
      if (probe.outcome === "rejected") {
        await client.disconnect().catch(() => undefined);
        console.warn(
          `[chat] ${gatewayUrl} answered ${probe.status} to a freshly refreshed gateway token; ` +
            `this browser has to authorize hop 1 again`,
        );
        return reauthorize(
          request,
          config,
          current,
          `${refusal}, and ${probe.status} to the refreshed one`,
        );
      }
    }

    // The bearer is settled, so the cookie can be. Built here rather than just
    // before the stream because every exit below this line is also an exit for
    // a token that may have just been refreshed, and a `Set-Cookie` is the only
    // way to carry it out of a response whose body is already decided.
    step = PRE_STREAM.seal;
    const resealed = new Headers();
    if (current !== session) await writeSession(resealed, request, current as Session, config);

    if (probe.outcome === "unreachable") {
      await client.disconnect().catch(() => undefined);
      // Not a credential and not a toolkit name. Nobody refused anything.
      return refuse(502, `The gateway at ${gatewayUrl} could not be reached: ${probe.detail}`, undefined, resealed);
    }

    let selected: Awaited<ReturnType<typeof governedToolset>>;
    try {
      selected = await governedToolset(client, { toolkits: config.agent.toolkits });
    } catch (cause) {
      await client.disconnect().catch(() => undefined);
      return refuse(502, `The gateway would not list its tools: ${String(cause)}`, undefined, resealed);
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
      return refuse(502, `The gateway would not list its tools: ${selected.error}`, undefined, resealed);
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
        undefined,
        resealed,
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
        resealed,
      );
    }

    // The resume, resolved against the store before a token is spent. Every
    // fact the injected message states comes from this read; the browser's
    // `prompt` and `reply` are context and nothing more (`resume.ts`).
    step = PRE_STREAM.approval;
    let turn: { messages: Parameters<Streamable["stream"]>[0]; opening: ChatEvent[] } = {
      messages: history.length > 0 ? withPrompt(history, prompt) : prompt,
      opening: [],
    };
    if (resume !== null) {
      const planned = await resolveResume(resume, current.email, options, config, history);
      if (!planned.ok) {
        await client.disconnect().catch(() => undefined);
        // A `fault`, not a `denied` and not a 500: nothing decided anything
        // here, and the UI must not claim a control-plane action that did not
        // happen (`events.ts`). A stream because the page renders one; the
        // status is 200 for the same reason `reauthorize` is.
        return faultStream(request, config, current, session, {
          kind: "fault",
          tool: "resume",
          message: planned.problem,
        });
      }
      turn = {
        messages: planned.messages,
        opening: [
          {
            kind: "resumed",
            request_id: resume.request_id,
            decision: planned.decision,
            decided_by: planned.decided_by,
            message: planned.message,
          },
        ],
      };
    }

    step = PRE_STREAM.agent;
    // `Approvals_RequestApproval` as MCP spells it, from the toolkit name this
    // deployment measured — not a literal, and not the second entry of the
    // allow-list (`lib/config.ts` → `approvalsToolkit`).
    const escalationTool = `${config.agent.approvalsToolkit}_RequestApproval`;
    // The turn boundary, enforced where there is no gap: the moment the
    // escalation returns a request id, every other tool in this turn's set
    // stops calling through. Round 1 of #110's review found a model calling
    // `Loan_ApproveLoan` straight after the escalation and that call reaching
    // the gateway; a consumer reading a stream is always a tick behind, so the
    // guarantee has to live in `execute`. See `escalation.ts`.
    const closure = closeTurnOnEscalation(selected.tools, {
      escalationTool,
      onRefused: (tool) =>
        console.warn(
          `[chat] ${tool} was asked for after this turn ended on an approval request; ` +
            `the turn's toolset refused it and nothing reached the gateway`,
        ),
    });
    closeAuthorization = closure.close;

    const agent = buildAgent({
      model: (options.model?.(config) ??
        anthropicModel({ modelId: config.agent.modelId, apiKey: config.agent.anthropicApiKey })) as never,
      tools: closure.tools,
    }) as unknown as Streamable;

    // A refreshed gateway token has to be resealed, and the only place to do it
    // is a header on this response — the stream body cannot set one later. The
    // cookie was written above, before the first of the refusals that also have
    // to carry it; here it only gains the stream's own two headers.
    const headers = new Headers(resealed);
    headers.set("content-type", NDJSON);
    headers.set("cache-control", "no-store");

    return streamTurn({
      agent,
      prompt: turn.messages,
      opening: turn.opening,
      client,
      headers,
      requestApprovalTool: escalationTool,
      nativeElicitation,
      onAuthorization: closure.close,
    });
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
 * The approval this resume names, read from the store and judged against the
 * session.
 *
 * The read is the point: `planResume` is pure and cannot be told anything, so
 * every assertion the injected message makes traces back to what
 * `GET /approvals/{id}` answered here, with this service's own bearer. The
 * browser named an id. It did not name an outcome, an approver or an amount,
 * and there is no branch below that would read one if it had.
 */
async function resolveResume(
  resume: ResumeRequest,
  signedInAs: string,
  options: ChatOptions,
  config: IdentitySurface,
  priorHistory: readonly ConversationMessage[] = [],
): Promise<
  | { ok: true; decision: "approved" | "denied"; decided_by: string; message: string; messages: Parameters<Streamable["stream"]>[0] }
  | { ok: false; problem: string }
> {
  // Read here rather than at the top of `chat`, so a deployment with no
  // approvals store configured still runs ordinary turns and only fails on the
  // path that needs one.
  const store = options.store ?? readWebConfig();
  const lookup = await fetchApproval(resume.request_id, {
    ...config,
    hooksHost: store.hooksHost,
    approvalsStoreToken: store.approvalsStoreToken,
    approvalsToolkit: config.agent.approvalsToolkit,
  }).catch((cause: unknown) => ({
    found: false as const,
    reason: `The approvals store could not be reached: ${String(cause)}`,
  }));

  if (!lookup.found) {
    return {
      ok: false,
      problem: `${lookup.reason} Nothing was resumed, and no rule refused anything.`,
    };
  }

  const planned = planResume(resume, lookup.request, signedInAs, priorHistory);
  if (!planned.ok) return planned;
  return {
    ok: true,
    decision: planned.decision,
    decided_by: lookup.request.decided_by ?? lookup.request.approver_id,
    message: planned.message,
    messages: planned.messages as Parameters<Streamable["stream"]>[0],
  };
}

/**
 * One `fault` and a `done`, as a 200 stream.
 *
 * The same shape `reauthorize` uses and for the same reason: `Chat.tsx` renders
 * a non-2xx as flat red text, and this has to land in the transcript as the
 * grey plumbing card that says the outcome is incomplete and side effects are
 * unknown. It must not assert a control-plane action either way: a failure here
 * does not establish whether an earlier hook ran or a partial write occurred.
 *
 * A refreshed session is still resealed on the way out — the turn did not
 * happen, but the token refresh did.
 */
async function faultStream(
  request: Request,
  config: IdentitySurface,
  session: Session,
  previous: Session,
  fault: ChatEvent,
): Promise<Response> {
  const headers = new Headers({ "content-type": NDJSON, "cache-control": "no-store" });
  if (session !== previous) await writeSession(headers, request, session, config);
  const events: ChatEvent[] = [fault, { kind: "done", calls: 0 }];
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
  prompt: Parameters<Streamable["stream"]>[0];
  /** Events written before the model is asked anything. `resumed`, or nothing. */
  opening: readonly ChatEvent[];
  client: ReturnType<typeof gatewayClient>;
  headers: Headers;
  requestApprovalTool: string;
  nativeElicitation: ReturnType<typeof createNativeElicitationBridge>;
  onAuthorization: () => void;
}): Response {
  const { agent, prompt, opening, client, headers, requestApprovalTool, nativeElicitation, onAuthorization } = turn;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      try {
        for (const event of opening) emit(event);
        await runTurn({ agent, prompt, emit, requestApprovalTool, nativeElicitation, onAuthorization });
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

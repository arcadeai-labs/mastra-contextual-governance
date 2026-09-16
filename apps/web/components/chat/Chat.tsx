"use client";

/**
 * The chat with the agent. #14 built it; #22 put it in the left half of the
 * split screen and changed how three of its eight event kinds look.
 *
 * It does four things the plainest version would not, and each is an acceptance
 * criterion rather than decoration:
 *
 * 1. **It streams.** The reply appears as it is produced, so a tool call that
 *    takes two seconds looks like work rather than like a hang. Streaming is
 *    about *when* the words arrive and not about how they are broken up:
 *    consecutive `text` events are one message that grows (`transcript.ts`),
 *    rendered as a safe subset of markdown (`markdown.ts`). #99 found the
 *    opposite live — one block per delta, so the first reply on the Render URL
 *    read "It / looks like the lo / an system / need / s you".
 * 2. **It shows the tool calls.** A denial that only appeared as prose would
 *    leave nothing on screen distinguishing "the hook refused" from "the model
 *    decided not to" — and those are the two readings this whole demo exists to
 *    separate.
 * 3. **It renders an authorization link as a link.** Layer 2 is a step for a
 *    person to take, not a refusal (`lib/agent/authorization.ts`). Printing the
 *    URL as text would leave a persona stuck on their first call with no
 *    visible way forward. The name and the link are the *whole* card: the
 *    event's `instructions` are words aimed at the model, and #99 found them on
 *    screen with an Arcade authorize URL inside them, overflowing the card by
 *    several hundred pixels. They stay on the wire and off the screen.
 * 4. **It gives a plumbing failure a different colour and different words.**
 *    A `fault` is grey and says no decision was made, because a demo whose claim
 *    is *"the control plane stopped this"* must not put that claim on screen
 *    when an unreachable API stopped it.
 *
 * ## What #22 changed, and why it is not decoration
 *
 * A denial used to be drawn in exactly the same red box as an `error` and as a
 * transport failure — `#b3261e` on `#fdecea` for all three. On a projector that
 * inverts the act: the audience reads a red alert as *the demo broke*, when what
 * actually happened is the system working precisely as designed. Denials are the
 * product here.
 *
 * So the three are now three:
 *
 * - **A denial is a decision**, drawn as one: a bordered notice on parchment with
 *   a dated maroon rule, headed with the tool and the word `DENIED`, carrying the
 *   rule author's sentence verbatim. Deliberate, official, filed — not an alarm.
 *   It is not `role="alert"` either, and never was: nothing went wrong.
 * - **A fault is plumbing**, grey, and says no decision was made and nothing was
 *   recorded.
 * - **An `error` and a failed request are plumbing too**, and now look like it.
 *   They used to wear the denial's colours, which is the same lie pointing the
 *   other way.
 *
 * Sizes are `em` rather than `rem` for the same reason `.cg-panel` is
 * (`app/globals.css`): this component is half a screen on a projector and a
 * narrow column on a laptop, and scaling one root beats scaling thirty rules.
 * The left half's root is `.bank` in `components/bank/bank.css`.
 *
 * The denial's remediation text is rendered **verbatim**, including the
 * `[ref evt_…]` token the control plane embedded. That token is what #21's panel
 * joins on, and a UI that tidied it away would make the two screens describe
 * different events.
 *
 * ## The resume (#20)
 *
 * A turn that ends after `Approvals_RequestApproval` ends. There is no polling
 * here, no timer and no socket held open by the turn — `DESIGN.md` → The wait,
 * and the issue is explicit that a visibly spinning agent contradicts the line
 * the demo is built on.
 *
 * What this component does instead is subscribe to the control plane's own
 * stream for the whole time it is mounted, and when an `approval.granted` for
 * *this browser's* request arrives, POST a new turn carrying the id. Two
 * properties are load-bearing:
 *
 * - **The transcript continues rather than clearing.** A resume appends. The
 *   denial, the escalation and the agent's "waiting for Charlie" stay on screen
 *   while the thing they caused happens underneath them.
 * - **This side names no outcome.** The resume request carries an id and the
 *   previous turn as context; the server reads `GET /approvals/{id}` itself and
 *   builds what the agent is told from that record (`lib/agent/resume.ts`).
 *   Nothing typed, stored or streamed into this browser can change what is
 *   asserted about an approval.
 */
import { useEffect, useRef, useState } from "react";

// Both from `events.ts`, which depends on nothing. Importing `CHAT_PATH` from
// `lib/agent/handlers.ts` instead pulls `@mastra/mcp` — and its stdio
// transport's `fs` import — into the browser bundle, and `next build` fails.
import { CHAT_PATH, replyText, type ChatEvent } from "../../lib/agent/events.ts";
import { boundConversation, type ConversationMessage } from "../../lib/agent/conversation.ts";
import { noticeIsFor, subscribeToApprovalNotices } from "../../lib/governance/approval-stream.ts";
import { Markdown } from "./Markdown.tsx";
import { transcript } from "./transcript.ts";
import "./chat.css";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const box: React.CSSProperties = {
  border: "1px solid var(--line)",
  padding: "0.6em 0.8em",
  marginTop: "0.6em",
  fontSize: "0.95em",
};

/**
 * A decision the control plane made. Not an alarm: a maroon rule, parchment, and
 * a heading that names the tool and says what was decided about it.
 */
const decision: React.CSSProperties = {
  ...box,
  borderColor: "#b09a86",
  borderLeft: "0.35em solid #8a2733",
  background: "#f9efe4",
  color: "#241f1b",
};

/** Plumbing: something broke and nothing decided anything. Grey, and drab. */
const plumbing: React.CSSProperties = {
  ...box,
  borderColor: "#b8b5ad",
  borderLeft: "0.35em solid #8a8a8a",
  background: "#f1f0ed",
  color: "#33322e",
};

/** Layer 2: a step for a person to take. Amber, and a link. */
const pending: React.CSSProperties = {
  ...box,
  borderColor: "#b08a2a",
  borderLeft: "0.35em solid #8a6100",
  background: "#fff6e0",
  color: "#4a3400",
};

const label: React.CSSProperties = {
  fontFamily: mono,
  fontSize: "0.85em",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

export interface ChatProps {
  signedInAs: string | null;
  /**
   * Every event as it arrives, in order. The split screen uses it to point the
   * control-plane panel at whatever the chat is currently showing, so a denial
   * in the transcript and the card on the panel light up together (#21's
   * `correlationKey`). Optional: `/chat` passes nothing and behaves as before.
   */
  onEvent?: (event: ChatEvent) => void;
  /** A new conversation has started, so the surrounding panel can clear its correlation. */
  onTurnStart?: () => void;
  /**
   * The governance stream, resolved on the server and handed down as an
   * address (#20). `null` when this deployment has no live stream, in which
   * case a turn that ends waiting stays ended: the card says so, and nothing
   * here retries or polls.
   *
   * The same URL the panel watches, and for the same reason it is a prop:
   * `NEXT_PUBLIC_*` is inlined at build time while Render supplies the
   * environment at runtime, so a client component that read it itself would be
   * `undefined` in the deployed browser and fine under `next dev`
   * (`lib/governance/stream-url.ts`).
   */
  approvalStreamUrl?: string | null;
}

/** The approval a turn ended on, and what it would resume. */
interface Waiting {
  request_id: string;
  approver: string;
  /** The prompt that opened the turn, handed back as context on the resume. */
  prompt: string;
  /** What the agent said, as this page received it. Context, never authority. */
  reply: string;
}

interface ChatTurn {
  prompt: string;
  events: ChatEvent[];
}

interface AuthorizationChallenge {
  prompt: string;
  turnIndex: number;
}

interface QueuedResume {
  request_id: string;
  generation: number;
}

export function Chat({
  signedInAs,
  onEvent,
  onTurnStart,
  approvalStreamUrl = null,
}: ChatProps) {
  const [prompt, setPrompt] = useState(
    "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
  );
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const turnsRef = useRef<ChatTurn[]>([]);
  /** Completed conversational context, deliberately in memory and per persona. */
  const conversationRef = useRef<ConversationMessage[]>([]);
  const personaRef = useRef(signedInAs);
  const runGenerationRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const [authorizationChallenge, setAuthorizationChallenge] = useState<AuthorizationChallenge | null>(null);
  const authorizationChallengeRef = useRef<AuthorizationChallenge | null>(null);
  /**
   * The approval this transcript is holding, or `null`.
   *
   * A ref as well as state: the stream subscription is set up once and its
   * callback would otherwise close over the value this browser had when the
   * socket opened, which is `null` — the turn that produces a `Waiting` has not
   * run yet. The state is what the card renders; the ref is what the callback
   * reads.
   */
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const waitingRef = useRef<Waiting | null>(null);
  /** A decision received while another turn owns the stream lock. */
  const queuedResumeRef = useRef<QueuedResume | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  // A turn in flight, so a second Send cannot interleave two streams into one
  // transcript — which would read as the agent contradicting itself. A resume
  // is a turn and takes the same lock.
  const inFlight = useRef(false);

  /** A persona switch is a new sealed session, not a continuation of the old browser context. */
  useEffect(() => {
    if (personaRef.current === signedInAs) return;
    personaRef.current = signedInAs;
    runGenerationRef.current += 1;
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    inFlight.current = false;
    turnsRef.current = [];
    conversationRef.current = [];
    authorizationChallengeRef.current = null;
    setTurns([]);
    setFailure(null);
    setAuthorizationChallenge(null);
    setWaiting(null);
    waitingRef.current = null;
    queuedResumeRef.current = null;
    followTranscriptRef.current = true;
    onTurnStart?.();
  }, [onTurnStart, signedInAs]);

  // Follow only while the reader is near the latest content. A presenter can
  // inspect older turns without a streamed delta yanking the viewport away;
  // once they return to the bottom, later deltas stay in view again.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null || !followTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [turns]);

  function addTurn(turn: ChatTurn): number {
    const index = turnsRef.current.length;
    turnsRef.current = [...turnsRef.current, turn];
    setTurns(turnsRef.current);
    return index;
  }

  function addEvent(turnIndex: number, event: ChatEvent): void {
    turnsRef.current = turnsRef.current.map((turn, index) =>
      index === turnIndex ? { ...turn, events: [...turn.events, event] } : turn,
    );
    setTurns(turnsRef.current);
  }

  /**
   * One turn, streamed into the transcript.
   *
   * Each ordinary question appends a visible turn. A resume also appends, but
   * its server-verified fact card has no user bubble because the browser is
   * only carrying context, never authority.
   */
  async function run(
    body: unknown,
    options: { turnIndex: number; prompt: string; commitConversation: boolean },
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setFailure(null);
    const generation = runGenerationRef.current;
    const abort = new AbortController();
    runAbortRef.current = abort;

    // Collected alongside the transcript, because a resume has to hand back
    // what the agent said on the turn that ended waiting, and reading it out of
    // React state inside this loop would race the setter.
    const turnEvents: ChatEvent[] = [];
    let prompted = "";
    if (typeof body === "object" && body !== null && "prompt" in body) {
      prompted = String((body as { prompt: unknown }).prompt);
    }

    try {
      const response = await fetch(CHAT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (generation !== runGenerationRef.current) return;
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string; detail?: unknown } | null;
        setFailure(
          [body?.error ?? `The chat route answered ${response.status}.`, detailOf(body?.detail)]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }

      // NDJSON, decoded a chunk at a time. A chunk boundary lands mid-line
      // often enough that buffering is not an optimisation — without it the
      // last event of most turns is dropped.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          let parsed: ChatEvent;
          try {
            parsed = JSON.parse(line) as ChatEvent;
          } catch {
            continue;
          }
          turnEvents.push(parsed);
          if (generation !== runGenerationRef.current) continue;
          addEvent(options.turnIndex, parsed);
          onEvent?.(parsed);
          if (parsed.kind === "authorization" && authorizationChallengeRef.current === null) {
            const challenge = { prompt: options.prompt, turnIndex: options.turnIndex };
            authorizationChallengeRef.current = challenge;
            setAuthorizationChallenge(challenge);
          }
        }
      }

      // The turn ended holding an approval. Nothing is polled and nothing is
      // retried: this records the id so that `approval.granted`, when it
      // arrives on the stream, can be recognised as this browser's.
      if (generation !== runGenerationRef.current) return;

      const ended = turnEvents.find(
        (event): event is Extract<ChatEvent, { kind: "waiting" }> => event.kind === "waiting",
      );
      if (ended) {
        const held: Waiting = {
          request_id: ended.request_id,
          approver: ended.approver,
          prompt: prompted,
          reply: replyText(turnEvents),
        };
        waitingRef.current = held;
        setWaiting(held);
      }

      const challenged = turnEvents.some((event) => event.kind === "authorization");
      if (options.commitConversation && !challenged && options.prompt.trim() !== "") {
        const reply = replyText(turnEvents);
        const completed: ConversationMessage[] = [
          { role: "user", content: options.prompt },
          ...(reply === "" ? [] : [{ role: "assistant" as const, content: reply }]),
        ];
        conversationRef.current = boundConversation([...conversationRef.current, ...completed]);
      } else if (options.commitConversation && !challenged) {
        // A resume has no browser-authored prompt. Its first event carries the
        // server-built decision line that was injected into the model's turn;
        // retain that line as context, followed by the completed reply, so a
        // later follow-up can refer to the action that actually happened.
        const resumed = turnEvents.find(
          (event): event is Extract<ChatEvent, { kind: "resumed" }> => event.kind === "resumed",
        );
        if (resumed) {
          const reply = replyText(turnEvents);
          const completed: ConversationMessage[] = [
            { role: "user", content: resumed.message },
            ...(reply === "" ? [] : [{ role: "assistant" as const, content: reply }]),
          ];
          conversationRef.current = boundConversation([...conversationRef.current, ...completed]);
        }
      }
    } catch (cause) {
      if (generation !== runGenerationRef.current) return;
      if (abort.signal.aborted) return;
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === runGenerationRef.current) {
        inFlight.current = false;
        setRunning(false);
        if (runAbortRef.current === abort) runAbortRef.current = null;

        // A grant can arrive while a follow-up is streaming. Keep the waiting
        // card until that stream is complete, then resume exactly once. The
        // queued request is cleared before calling resume so a reconnect or a
        // duplicate live notice cannot create a second turn.
        const queued = queuedResumeRef.current;
        if (queued?.generation === generation) {
          queuedResumeRef.current = null;
          void resume(queued.request_id);
        }
      }
    }
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    if (prompt.trim() === "" || inFlight.current) return;
    const requested = prompt.trim();
    // The submitted prompt is already preserved in the visible user bubble;
    // leave the composer ready for the next turn instead of making a reader
    // delete the previous request by hand.
    setPrompt("");
    // A new user turn takes precedence over an old, uncontinued challenge;
    // its card remains in the transcript, but cannot be clicked to replay a
    // stale prompt after the conversation has moved on.
    authorizationChallengeRef.current = null;
    setAuthorizationChallenge(null);
    const turnIndex = addTurn({ prompt: requested, events: [] });
    const history = boundConversation(conversationRef.current);
    void run(
      { prompt: requested, ...(history.length === 0 ? {} : { history }) },
      { turnIndex, prompt: requested, commitConversation: true },
    );
  }

  /**
   * A fallback authorization card is an explicit user-intent action. It starts
   * one new attempt with the original prompt and bounded prior context; it is
   * never treated as proof that a credential was granted.
   */
  function continueAuthorization(): void {
    const challenge = authorizationChallengeRef.current;
    if (challenge === null || inFlight.current) return;
    authorizationChallengeRef.current = null;
    setAuthorizationChallenge(null);
    const history = boundConversation(conversationRef.current);
    void run(
      { prompt: challenge.prompt, ...(history.length === 0 ? {} : { history }) },
      { turnIndex: challenge.turnIndex, prompt: challenge.prompt, commitConversation: true },
    );
  }

  /**
   * Resume, once, on a decision this browser is waiting for.
   *
   * The request is an id and the previous turn as context. It names no
   * outcome, no approver and no amount: the server reads the record itself and
   * builds what the agent is told from that (`lib/agent/resume.ts`). What this
   * side decides is only *whether* to ask.
   */
  async function resume(requestId: string): Promise<void> {
    const held = waitingRef.current;
    if (held === null || held.request_id !== requestId) return;

    // Do not consume the approval or add a placeholder turn while another
    // request owns the stream lock. Live and catch-up notices may both arrive
    // here; one request id is enough, and the waiting card remains truthful
    // until the active turn has actually finished.
    if (inFlight.current) {
      queuedResumeRef.current ??= { request_id: requestId, generation: runGenerationRef.current };
      return;
    }

    // Cleared before the turn, not after: a second notice for the same request
    // — a reconnect racing the live frame — must not start a second turn.
    waitingRef.current = null;
    setWaiting(null);
    const history = boundConversation(conversationRef.current);
    await run(
      {
        resume: { request_id: requestId, prompt: held.prompt, reply: held.reply },
        ...(history.length === 0 ? {} : { history }),
      },
      { turnIndex: addTurn({ prompt: "", events: [] }), prompt: "", commitConversation: true },
    );
  }

  /**
   * The stream, for as long as this component is mounted.
   *
   * Opened once rather than when a turn starts waiting, so the socket is
   * already up when the decision lands — on stage the gap between the
   * escalation and Charlie's click is where the presenter talks, and a
   * subscription that started then would be racing it.
   *
   * `onConnected` fires on every successful connect, including reconnects, and
   * is where a notice missed while the socket was down is picked up: the server
   * is asked what the store now says about the request this browser is holding.
   * The frame is live-only by construction (`approval-stream.ts`), so this is
   * not belt and braces — it is the other half of the mechanism.
   */
  useEffect(() => {
    if (approvalStreamUrl === null || signedInAs === null) return;
    const controller = new AbortController();

    void subscribeToApprovalNotices(approvalStreamUrl, {
      signal: controller.signal,
      onNotice: (notice) => {
        const held = waitingRef.current;
        if (held === null) return;
        if (!noticeIsFor(notice, { request_id: held.request_id, signedInAs })) return;
        void resume(notice.request_id);
      },
      onConnected: () => {
        const held = waitingRef.current;
        if (held === null) return;
        void (async () => {
          const response = await fetch(
            `/api/approvals/${encodeURIComponent(held.request_id)}/status`,
            { headers: { accept: "application/json" } },
          ).catch(() => null);
          if (response === null || !response.ok) return;
          const body = (await response.json().catch(() => null)) as { status?: string } | null;
          if (body?.status === "approved" || body?.status === "denied") {
            void resume(held.request_id);
          }
        })();
      },
    });

    return () => controller.abort();
    // `resume` closes over refs and setters only, so the subscription is set up
    // once per stream and per persona rather than torn down on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalStreamUrl, signedInAs]);

  return (
    <section className="chat-shell" aria-label="Conversation">
      <p style={{ color: "var(--muted)", fontSize: "0.9em", margin: "0 0 0.5em" }}>
        {signedInAs ? (
          <>
            Acting as <code>{signedInAs}</code> — every tool call is made as this person, because this
            browser is signed in as them.
          </>
        ) : (
          <>Nobody is signed in on this browser, so there is no one to act as.</>
        )}
      </p>

      <form className="chat-composer" onSubmit={send}>
        <textarea
          aria-label="Message the assistant"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          style={{ width: "100%", font: "inherit", fontSize: "0.95em", padding: "0.4em" }}
        />
        <button
          type="submit"
          disabled={running}
          style={{ font: "inherit", marginTop: "0.4em", padding: "0.35em 0.9em" }}
        >
          {running ? "Running…" : "Send"}
        </button>
      </form>

      {failure === null ? null : (
        // The request never got as far as a turn. Plumbing, and worded as such:
        // it used to wear the denial's red, which put a refusal on screen that
        // nothing refused.
        <div role="alert" style={plumbing}>
          <strong style={label}>The chat route did not answer</strong>
          <p style={{ margin: "0.4em 0 0", whiteSpace: "pre-wrap" }}>{failure}</p>
        </div>
      )}

      <div
        className="chat-transcript-scroll"
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followTranscriptRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
        }}
      >
      <div className="chat-transcript" aria-live="polite">
        {turns.map((turn, index) => {
          const latestAuthorization = [...turn.events]
            .reverse()
            .find((candidate) => candidate.kind === "authorization");
          return (
            <article className="chat-turn" data-kind="turn" key={index}>
            {turn.prompt === "" ? null : (
              <div className="chat-message chat-message-user" data-role="user">
                <span className="chat-message-label">You</span>
                <p>{turn.prompt}</p>
              </div>
            )}
            <div className="chat-message chat-message-assistant" data-role="assistant">
              <span className="chat-message-label">Assistant</span>
              {/* Grouped, not one-per-event. A `text` event is a delta; the
                  deltas either side of a tool call are two messages and the
                  deltas between them are one. `transcript.ts` says why that
                  distinction is the whole bug #99 was filed for. */}
              {groupToolBlocks(transcript(visibleEvents(turn.events))).map((block, blockIndex) =>
                block.kind === "reply" ? (
                  <Markdown key={blockIndex} source={block.text} />
                ) : block.kind === "tools" ? (
                  <details className="chat-tools" key={blockIndex}>
                    <summary>
                      {block.toolCount === 1 ? "1 tool call" : `${block.toolCount} tool calls`} · {toolIdentity(block)}
                    </summary>
                    <div className="chat-tools-body">
                      {block.events.map((event, eventIndex) => (
                        <EventView key={eventIndex} event={event} />
                      ))}
                    </div>
                  </details>
                ) : (
                  <EventView
                    key={blockIndex}
                    event={block.event}
                    {...(block.event.kind === "authorization" &&
                    authorizationChallenge?.turnIndex === index &&
                    latestAuthorization === block.event
                      ? {
                          onContinueAuthorization: continueAuthorization,
                          authorizationContinuing: running,
                        }
                      : {})}
                  />
                ),
              )}
            </div>
            </article>
          );
        })}
      </div>
      </div>

    </section>
  );
}

type TranscriptBlock = ReturnType<typeof transcript>[number];
type ToolEvent = Extract<ChatEvent, { kind: "tool-call" | "tool-result" }>;
type RenderBlock =
  | TranscriptBlock
  | { kind: "tools"; events: ToolEvent[]; toolCount: number; identities: string[] };

/** Keep tool traffic available without letting it crowd the conversation. */
function groupToolBlocks(blocks: readonly TranscriptBlock[]): RenderBlock[] {
  const grouped: RenderBlock[] = [];
  let toolEvents: ToolEvent[] = [];

  const flush = () => {
    if (toolEvents.length === 0) return;
    const identities = [...new Set(toolEvents.map((event) => event.tool))];
    grouped.push({
      kind: "tools",
      events: toolEvents,
      toolCount: toolEvents.filter((event) => event.kind === "tool-call").length || identities.length,
      identities,
    });
    toolEvents = [];
  };

  for (const block of blocks) {
    if (block.kind === "event" && (block.event.kind === "tool-call" || block.event.kind === "tool-result")) {
      toolEvents.push(block.event);
      continue;
    }
    flush();
    grouped.push(block);
  }
  flush();
  return grouped;
}

function toolIdentity(block: Extract<RenderBlock, { kind: "tools" }>): string {
  return block.identities.join(", ");
}

function detailOf(detail: unknown): string {
  return Array.isArray(detail) ? detail.join(" ") : "";
}

/**
 * One event, rendered.
 *
 * Exported because it is the unit #22's acceptance criterion is about — "renders
 * denials without looking like an error state" is a property of this function
 * and of nothing else, and asserting it needs neither a socket nor a DOM.
 * `test/split-screen.test.tsx` renders each of the ten kinds through it.
 */
export function EventView({
  event,
  onContinueAuthorization,
  authorizationContinuing = false,
}: {
  event: ChatEvent;
  onContinueAuthorization?: () => void;
  authorizationContinuing?: boolean;
}) {
  switch (event.kind) {
    case "text":
      // One event on its own. `Chat` folds consecutive ones first and renders
      // the fold through the same component, so a reply looks the same whether
      // it arrived whole or three characters at a time.
      return <Markdown source={event.text} />;

    case "tool-call":
      return (
        <div style={{ ...box, fontFamily: mono, color: "var(--muted)" }}>
          → {event.tool}({JSON.stringify(event.inputs)})
        </div>
      );

    case "tool-result":
      return (
        <div style={{ ...box, fontFamily: mono, color: "var(--muted)" }}>← {event.tool} returned</div>
      );

    case "denied":
      return (
        // A decision, drawn as one. The rule author's sentence, unedited,
        // `[ref …]` and all: #21's panel joins on that token, and a UI that
        // tidied it away would leave the two screens describing different
        // events.
        <div style={decision} data-kind="denied">
          <strong style={{ ...label, color: "#8a2733" }}>
            Control plane decision · {event.tool} · denied
          </strong>
          <p style={{ margin: "0.4em 0 0", whiteSpace: "pre-wrap" }}>{event.reason}</p>
          <p style={{ margin: "0.4em 0 0", fontSize: "0.85em", color: "var(--muted)" }}>
            Recorded in the audit log. Nothing was written to the loan book.
          </p>
        </div>
      );

    case "fault":
      return (
        // Grey, and worded as plumbing. Not the decision's colours: those mean
        // the control plane refused, and a socket error wearing them is the demo
        // claiming a decision nobody made. Round 1 of #88's review found exactly
        // that, with a connection error standing in for a rule's remediation
        // text.
        <div role="alert" style={plumbing} data-kind="fault">
          <strong style={label}>{event.tool} — the tool did not complete</strong>
          <p style={{ margin: "0.4em 0", whiteSpace: "pre-wrap" }}>{event.message}</p>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            No policy decision was made and nothing was recorded. This is a failure in the plumbing,
            not the control plane refusing.
          </p>
        </div>
      );

    case "authorization":
      return (
        // Not a denial: no hook fired and no audit row exists. Amber rather
        // than maroon, and a link rather than a message, because the next move
        // belongs to the person reading it.
        <div style={pending} data-kind="authorization">
          {/* The name, and nothing decoded from it. Since #94 this event carries
              two things a layer apart — a wire tool name for layer 2, the
              gateway's id for hop 1 — and `tool` is the structured field that
              already tells them apart. The card prints it and draws no further
              conclusion: a card that named the hop would be inferring one from
              a string, and the two spellings are Arcade's to change. */}
          <strong style={label}>{event.tool} — authorization needed</strong>
          <p style={{ margin: "0.4em 0 0" }}>
            {/* "Authorize", not "authorize this tool": the thing to authorize is
                whatever the heading just named. Continue is the one explicit
                retry; the server has already ended the challenged turn. */}
            {event.url === undefined ? (
              <>Authorize the provider, then use Continue.</>
            ) : (
              <>
                <a href={event.url} target="_blank" rel="noreferrer">
                  Authorize
                </a>
                , then use Continue.
              </>
            )}
          </p>
          {onContinueAuthorization === undefined ? null : (
            <button
              type="button"
              data-action="continue-authorization"
              aria-label="I have authorized, continue this request"
              onClick={onContinueAuthorization}
              disabled={authorizationContinuing}
              style={{ font: "inherit", marginTop: "0.55em", padding: "0.35em 0.75em" }}
            >
              {authorizationContinuing ? "Continuing…" : "Continue"}
            </button>
          )}
          {/* The event's instructions are words written for the model. They can
              contain retry advice or a long URL, so they stay off screen. */}
          <p style={{ margin: "0.4em 0 0", color: "var(--muted)" }}>
            A credential is missing. This turn is paused; Continue starts exactly one new attempt.
            Nothing was refused: no rule ran and nothing was written to the audit log.
          </p>
        </div>
      );

    case "error":
      return (
        // The run stopped. Never a governance decision, so never the decision's
        // colours — `lib/agent/events.ts` is explicit that this is not a tool
        // outcome at all.
        <div role="alert" style={plumbing} data-kind="error">
          <strong style={label}>The turn stopped</strong>
          <p style={{ margin: "0.4em 0 0", whiteSpace: "pre-wrap" }}>{event.message}</p>
          <p style={{ margin: "0.4em 0 0", color: "var(--muted)" }}>
            No policy decision was made and nothing was recorded.
          </p>
        </div>
      );

    case "waiting":
      return (
        // Amber, like layer 2, and for the same reason: nothing was refused
        // here and nothing was decided. The turn ended, and what happens next
        // belongs to a person — this one is just not the person reading it.
        <div style={pending} data-kind="waiting">
          {/* The routed approver comes off the tool's own result, not out of
              the model's sentence: the routing is deterministic and the
              sentence is whatever the model chose to say. On stage this card is
              what makes the routing visible even if the reply is empty. */}
          <strong style={label}>Approval requested — the turn has ended</strong>
          <p style={{ margin: "0.4em 0 0" }}>
            Routed to <strong>{event.approver}</strong>
            {event.approver_id === "" ? null : <> — {event.approver_id}</>}. This turn is over:
            nothing is polling, nothing is waiting on a socket, and no further tool call will be
            made on it. When the decision is recorded it arrives on the control plane&apos;s own
            stream and the agent is asked again.
          </p>
          <p style={{ margin: "0.4em 0 0", fontFamily: mono, fontSize: "0.85em", color: "var(--muted)" }}>
            {event.request_id}
          </p>
        </div>
      );

    case "resumed":
      return (
        // The injected message, on screen, verbatim. A control surface that
        // put a message into the conversation and did not show it would be
        // asking to be trusted about the one thing an audience can check —
        // whether the agent was told what to do, or told what had happened.
        <div style={pending} data-kind="resumed">
          <strong style={label}>
            Resumed — approval {event.decision} by {event.decided_by}
          </strong>
          <p style={{ margin: "0.4em 0 0", whiteSpace: "pre-wrap" }}>{event.message}</p>
          <p style={{ margin: "0.4em 0 0", color: "var(--muted)" }}>
            Sent to the agent as a new turn. It states what was decided and nothing about what to
            do next.
          </p>
        </div>
      );

    case "done":
      return (
        <p style={{ color: "var(--muted)", fontSize: "0.85em", marginTop: "0.6em" }}>
          {event.calls === 1 ? "1 tool call" : `${event.calls} tool calls`} this turn.
        </p>
      );
  }
}

/**
 * Hide only model prose that repeats a structured authorization challenge.
 * Tool failures, policy denials and prior turns stay visible; the card is the
 * single actionable authorization surface and does not rely on parsing model
 * prose for a URL.
 */
function visibleEvents(events: readonly ChatEvent[]): ChatEvent[] {
  if (!events.some((event) => event.kind === "authorization")) return [...events];
  const authorizationUrls = events
    .filter((event): event is Extract<ChatEvent, { kind: "authorization" }> => event.kind === "authorization")
    .map((event) => event.url)
    .filter((url): url is string => url !== undefined);
  // Streaming text arrives as many deltas. Fold each contiguous text run before
  // filtering so a challenge sentence split across chunks is still recognized,
  // while keeping tool events as structural boundaries.
  const folded: ChatEvent[] = [];
  for (const event of events) {
    const previous = folded[folded.length - 1];
    if (event.kind === "text" && previous?.kind === "text") {
      folded[folded.length - 1] = { kind: "text", text: previous.text + event.text };
    } else {
      folded.push(event);
    }
  }
  const visible: ChatEvent[] = [];
  for (const event of folded) {
    if (event.kind !== "text") {
      visible.push(event);
      continue;
    }
    const text = event.text
      .split(/(?<=[.!?])(?:\s+|\n+)/)
      .filter((sentence) => !isAuthorizationProse(sentence, authorizationUrls))
      .join(" ");
    if (text !== "") visible.push({ kind: "text", text });
  }
  return visible;
}

function isAuthorizationProse(text: string, authorizationUrls: readonly string[]): boolean {
  const lower = text.toLowerCase();
  const mentionsAuthorization = /authori[sz](?:e|ation|ed|ing)/.test(lower) || lower.includes("credential");
  const carriesAction = authorizationUrls.some((url) => text.includes(url)) || lower.includes("click") || lower.includes("link");
  // A useful prior reply can mention both authorization and a link while
  // reporting a failure. Keep those sentences; only remove a pure duplicate
  // of the structured challenge.
  const reportsFailure = /\b(?:error|failed|failure|unable|cannot|can't|still|but)\b/.test(lower);
  return mentionsAuthorization && carriesAction && !reportsFailure;
}

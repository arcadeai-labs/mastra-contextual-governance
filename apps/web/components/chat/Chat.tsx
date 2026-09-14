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
 *   denial, the escalation and the agent's "waiting for Riley" stay on screen
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
import { noticeIsFor, subscribeToApprovalNotices } from "../../lib/governance/approval-stream.ts";
import { Markdown } from "./Markdown.tsx";
import { transcript } from "./transcript.ts";

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
  /** A new turn has started and the transcript has been cleared. */
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

export function Chat({
  signedInAs,
  onEvent,
  onTurnStart,
  approvalStreamUrl = null,
}: ChatProps) {
  const [prompt, setPrompt] = useState(
    "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
  );
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
  // A turn in flight, so a second Send cannot interleave two streams into one
  // transcript — which would read as the agent contradicting itself. A resume
  // is a turn and takes the same lock.
  const inFlight = useRef(false);

  /**
   * One turn, streamed into the transcript.
   *
   * `append` is the whole difference between a question and a resume: a
   * question clears the transcript, a resume continues it. A resume that
   * cleared would take the denial, the escalation and the agent's *"waiting for
   * Riley"* off the screen at the exact moment the audience is being shown that
   * they caused what happens next.
   */
  async function run(body: unknown, options: { append: boolean }): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setFailure(null);
    if (!options.append) {
      setEvents([]);
      setWaiting(null);
      waitingRef.current = null;
      onTurnStart?.();
    }

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
      });

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
          setEvents((seen) => [...seen, parsed]);
          onEvent?.(parsed);
        }
      }

      // The turn ended holding an approval. Nothing is polled and nothing is
      // retried: this records the id so that `approval.granted`, when it
      // arrives on the stream, can be recognised as this browser's.
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
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    if (prompt.trim() === "") return;
    void run({ prompt }, { append: false });
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
    // Cleared before the turn, not after: a second notice for the same request
    // — a reconnect racing the live frame — must not start a second turn.
    waitingRef.current = null;
    setWaiting(null);
    await run(
      { resume: { request_id: requestId, prompt: held.prompt, reply: held.reply } },
      { append: true },
    );
  }

  /**
   * The stream, for as long as this component is mounted.
   *
   * Opened once rather than when a turn starts waiting, so the socket is
   * already up when the decision lands — on stage the gap between the
   * escalation and Riley's click is where the presenter talks, and a
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
    <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
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

      <form onSubmit={send}>
        <textarea
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

      {/* Grouped, not one-per-event. A `text` event is a delta; the deltas
          either side of a tool call are two messages and the deltas between
          them are one. `transcript.ts` says why that distinction is the whole
          bug #99 was filed for. */}
      {transcript(events).map((block, index) =>
        block.kind === "reply" ? (
          <Markdown key={index} source={block.text} />
        ) : (
          <EventView key={index} event={block.event} />
        ),
      )}
    </section>
  );
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
export function EventView({ event }: { event: ChatEvent }) {
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
                whatever the heading just named. */}
            <a href={event.url} target="_blank" rel="noreferrer">
              Authorize
            </a>
            , then ask again.
          </p>
          {/* This card's own sentence, not the event's. `instructions` are words
              written for the model — Arcade's `llm_instructions` on layer 2,
              ours on hop 1 — and on layer 2 they carry the full authorize URL,
              which is what overflowed the card by several hundred pixels on the
              Render URL (#99). They stay in the event, where the tests read
              them; the person gets the name, the link, and the one thing the
              control plane can actually prove about this event. */}
          <p style={{ margin: "0.4em 0 0", color: "var(--muted)" }}>
            A credential is missing. Nothing was refused: no rule ran and nothing was written to
            the audit log.
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
          <strong style={label}>Approval requested — the turn has ended</strong>
          <p style={{ margin: "0.4em 0 0" }}>
            Routed to <strong>{event.approver}</strong>. This turn is over: nothing is polling and
            nothing is waiting on a socket. When the decision is recorded it arrives on the control
            plane&apos;s own stream and the agent is asked again.
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

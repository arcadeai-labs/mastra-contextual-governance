"use client";

/**
 * The chat with the agent. #14 built it; #22 put it in the left half of the
 * split screen and changed how three of its eight event kinds look.
 *
 * It does four things the plainest version would not, and each is an acceptance
 * criterion rather than decoration:
 *
 * 1. **It streams.** The reply appears as it is produced, so a tool call that
 *    takes two seconds looks like work rather than like a hang.
 * 2. **It shows the tool calls.** A denial that only appeared as prose would
 *    leave nothing on screen distinguishing "the hook refused" from "the model
 *    decided not to" — and those are the two readings this whole demo exists to
 *    separate.
 * 3. **It renders an authorization link as a link.** Layer 2 is a step for a
 *    person to take, not a refusal (`lib/agent/authorization.ts`). Printing the
 *    URL as text would leave a persona stuck on their first call with no
 *    visible way forward.
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
 */
import { useRef, useState } from "react";

// Both from `events.ts`, which depends on nothing. Importing `CHAT_PATH` from
// `lib/agent/handlers.ts` instead pulls `@mastra/mcp` — and its stdio
// transport's `fs` import — into the browser bundle, and `next build` fails.
import { CHAT_PATH, type ChatEvent } from "../../lib/agent/events.ts";

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
}

export function Chat({ signedInAs, onEvent, onTurnStart }: ChatProps) {
  const [prompt, setPrompt] = useState(
    "Approve the loan for $95K and double-check your work so you don't make any mistakes.",
  );
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A turn in flight, so a second Send cannot interleave two streams into one
  // transcript — which would read as the agent contradicting itself.
  const inFlight = useRef(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || prompt.trim() === "") return;
    inFlight.current = true;
    setRunning(true);
    setFailure(null);
    setEvents([]);
    onTurnStart?.();

    try {
      const response = await fetch(CHAT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
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
          setEvents((seen) => [...seen, parsed]);
          onEvent?.(parsed);
        }
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }

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

      {events.map((event, index) => (
        <EventView key={index} event={event} />
      ))}
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
 * `test/split-screen.test.tsx` renders each of the eight kinds through it.
 */
export function EventView({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case "text":
      return <p style={{ margin: "0.5em 0", whiteSpace: "pre-wrap" }}>{event.text}</p>;

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
          <strong style={label}>{event.tool} — authorization needed</strong>
          <p style={{ margin: "0.4em 0 0" }}>
            <a href={event.url} target="_blank" rel="noreferrer">
              Authorize this tool
            </a>
            , then ask again.
          </p>
          {event.instructions ? (
            <p style={{ margin: "0.4em 0 0", color: "var(--muted)" }}>{event.instructions}</p>
          ) : null}
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

    case "done":
      return (
        <p style={{ color: "var(--muted)", fontSize: "0.85em", marginTop: "0.6em" }}>
          {event.calls === 1 ? "1 tool call" : `${event.calls} tool calls`} this turn.
        </p>
      );
  }
}

"use client";

/**
 * The bare chat page. Ugly on purpose — #14 says so, and act 2's real screen is
 * #22's split view with the control-plane panel beside it.
 *
 * It does three things the plainest version would not, and each is an
 * acceptance criterion rather than decoration:
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
 *    Red means a hook refused. A `fault` is grey and says no decision was made,
 *    because a demo whose claim is *"the control plane stopped this"* must not
 *    put that claim on screen when an unreachable API stopped it.
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
  borderRadius: "6px",
  padding: "0.75rem 1rem",
  marginTop: "0.75rem",
  fontSize: "0.875rem",
};

export function Chat({ signedInAs }: { signedInAs: string | null }) {
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
          try {
            setEvents((seen) => [...seen, JSON.parse(line) as ChatEvent]);
          } catch {
            continue;
          }
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
    <section style={{ marginTop: "2rem" }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>Chat</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem", margin: "0 0 0.75rem" }}>
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
          style={{ width: "100%", font: "inherit", fontSize: "0.875rem", padding: "0.5rem" }}
        />
        <button type="submit" disabled={running} style={{ font: "inherit", marginTop: "0.5rem", padding: "0.4rem 0.9rem" }}>
          {running ? "Running…" : "Send"}
        </button>
      </form>

      {failure === null ? null : (
        <div role="alert" style={{ ...box, borderColor: "#b3261e", background: "#fdecea", color: "#5f1412" }}>
          {failure}
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

function EventView({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case "text":
      return <p style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>{event.text}</p>;

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
        // The rule author's sentence, unedited, `[ref …]` and all. #21's panel
        // joins on that token; a UI that tidied it away would leave the two
        // screens describing different events.
        <div style={{ ...box, borderColor: "#b3261e", background: "#fdecea", color: "#5f1412" }}>
          <strong style={{ fontFamily: mono }}>{event.tool} — denied by the control plane</strong>
          <p style={{ margin: "0.5rem 0 0", whiteSpace: "pre-wrap" }}>{event.reason}</p>
        </div>
      );

    case "fault":
      return (
        // Grey, and worded as plumbing. Not red: red on this page means the
        // control plane refused, and a socket error wearing that colour is the
        // demo claiming a decision nobody made. Round 1 of #88's review found
        // exactly that, with a connection error standing in for a rule's
        // remediation text.
        <div role="alert" style={{ ...box, borderColor: "var(--line)", background: "#f4f4f5", color: "#3f3f46" }}>
          <strong style={{ fontFamily: mono }}>{event.tool} — the tool did not complete</strong>
          <p style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>{event.message}</p>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            No policy decision was made and nothing was recorded. This is a failure in the plumbing,
            not the control plane refusing.
          </p>
        </div>
      );

    case "authorization":
      return (
        // Not a denial: no hook fired and no audit row exists. Amber rather
        // than red, and a link rather than a message, because the next move
        // belongs to the person reading it.
        <div style={{ ...box, borderColor: "#8a6100", background: "#fff6e0", color: "#5a3f00" }}>
          <strong style={{ fontFamily: mono }}>{event.tool} — authorization needed</strong>
          <p style={{ margin: "0.5rem 0 0" }}>
            {/* "Authorize", not "authorize this tool": since #94 the same event
                also carries hop 1, where the thing to authorize is the gateway
                and not a tool. The heading already names which. */}
            <a href={event.url} target="_blank" rel="noreferrer">
              Authorize
            </a>
            , then ask again.
          </p>
          {event.instructions ? (
            <p style={{ margin: "0.5rem 0 0", color: "var(--muted)" }}>{event.instructions}</p>
          ) : null}
        </div>
      );

    case "error":
      return (
        <div role="alert" style={{ ...box, borderColor: "#b3261e", background: "#fdecea", color: "#5f1412" }}>
          {event.message}
        </div>
      );

    case "done":
      return (
        <p style={{ color: "var(--muted)", fontSize: "0.8125rem", marginTop: "0.75rem" }}>
          {event.calls === 1 ? "1 tool call" : `${event.calls} tool calls`} this turn.
        </p>
      );
  }
}

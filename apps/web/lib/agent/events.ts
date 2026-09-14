/**
 * What the chat route streams, one JSON object per line.
 *
 * NDJSON rather than plain text because four of these are not text: a tool
 * call the person should see happening, a hook denial that the panel will later
 * join on its `[ref …]` token (#21), layer 2's authorization link, which has to
 * be clickable, and a plumbing failure that must not be mistaken for either. A
 * plain text stream would flatten all of that into prose and the page would
 * have to parse English.
 *
 * **Three of the kinds describe a tool that did not return, and they are three
 * kinds rather than one because they are three different claims about the
 * world.** `denied`: a hook decided, and there is an audit row. `authorization`:
 * a credential is missing, no hook fired, no row exists. `fault`: something
 * broke, and nothing decided anything. Collapsing any two of them puts a
 * statement on screen that the control plane never made.
 *
 * Deliberately not the AI SDK's UI message stream. That protocol is richer than
 * this slice needs and it would put the shape of a vendor's stream between the
 * control plane and the screen; these eight kinds are the whole vocabulary and
 * `test/agent-tools.test.ts` reads them back.
 */

export type ChatEvent =
  /** A run of assistant text. Concatenate in order; there is no other text source. */
  | { kind: "text"; text: string }
  /** The model chose a tool. Emitted before the call is made, so a slow call is visible. */
  | { kind: "tool-call"; tool: string; inputs: Record<string, unknown> }
  /** The tool ran. The value is not streamed — the reply says what happened. */
  | { kind: "tool-result"; tool: string }
  /**
   * A hook refused. `reason` is the rule's own remediation text with Arcade's
   * prefix stripped; `ref` is the audit row id the control plane embedded (#6),
   * or `null` when the message carries none.
   */
  | { kind: "denied"; tool: string; reason: string; ref: string | null }
  /**
   * A credential is missing or no longer accepted, and nothing was refused. The
   * page renders the link as a step to take. **No hook fired and no audit row
   * exists** for this, which is why it is its own kind and not a `denied`.
   *
   * Two things arrive here, one layer apart, and the claim about the world is
   * the same for both: layer 2, where Arcade finds the persona holds no `cg-idp`
   * token for a tool (`tool` is the wire tool name, `url` is Arcade's own
   * `authorization_url`, `instructions` are Arcade's words); and hop 1, where
   * the gateway itself will not take this browser's bearer (`tool` is the
   * gateway id, `url` is this service's `/api/arcade/start`, `instructions` are
   * ours). Both are upstream of every hook, and both end with a person clicking
   * something rather than a rule having decided anything (#94).
   */
  | { kind: "authorization"; tool: string; url: string; instructions?: string }
  /**
   * The tool failed and **no hook decided anything**: the loan API was
   * unreachable, the gateway could not answer, the toolkit threw. Plumbing.
   *
   * Its own kind because round 1 of #88's review found all of this arriving as
   * `denied` — a connection error rendered as *"denied by the control plane"*,
   * with the socket error standing in for a rule's remediation text. There is
   * no rule, no decision and no audit row behind a `fault`, and a demo that
   * claims one is claiming the thing it exists to prove.
   */
  | { kind: "fault"; tool: string; message: string }
  /** Anything that stopped the run. The message is shown; it is not a tool outcome. */
  | { kind: "error"; message: string }
  /** The run finished. `calls` is every tool call attempted, denials included. */
  | { kind: "done"; calls: number };

/** The content type the chat route answers with. */
export const NDJSON = "application/x-ndjson";

/**
 * Where the chat route lives.
 *
 * Here rather than beside the handler, and the reason is a build failure rather
 * than tidiness: `components/chat/Chat.tsx` is a client component, importing
 * this constant from `lib/agent/handlers.ts` pulled `@mastra/mcp` into the
 * browser bundle through it, and `next build` stopped on
 * `Module not found: Can't resolve 'fs'` — the MCP SDK's stdio transport.
 *
 * This module is the contract between the two sides and depends on nothing, so
 * it is the one thing both may import. `handlers.ts` re-exports it for callers
 * that only care about the server side.
 */
export const CHAT_PATH = "/api/chat";

export function encodeEvent(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parse a whole NDJSON body. Blank lines are skipped; a line that is not JSON
 * is skipped rather than thrown on, because a truncated stream should leave the
 * events that did arrive readable.
 */
export function decodeEvents(body: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** Every `text` event joined — the reply as a person reads it. */
export function replyText(events: readonly ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { kind: "text" }> => event.kind === "text")
    .map((event) => event.text)
    .join("");
}

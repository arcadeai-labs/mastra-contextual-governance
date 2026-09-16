/**
 * The small, browser-owned conversation contract used by `/api/chat`.
 *
 * There is deliberately no persistence or identity in this module. A browser
 * may offer its recent turns as context, but the sealed session remains the
 * only source of the acting persona and the server treats these messages as
 * untrusted context rather than authority. Keeping this boundary explicit is
 * also what makes replacing the in-memory UI history with a future native
 * conversation transport a local change.
 */

export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_MESSAGE_CHARS = 4_000;
export const MAX_HISTORY_CHARS = 24_000;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Keep only well-shaped, bounded conversational context.
 *
 * Invalid entries are ignored and the newest complete context wins when a
 * caller sends too much. This is intentionally a shape/size boundary only:
 * the resulting messages are still context, never an assertion of identity or
 * permission.
 */
export function boundConversation(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const valid = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_HISTORY_MESSAGE_CHARS),
    }));

  const recent = valid.slice(-MAX_HISTORY_MESSAGES);
  let characters = 0;
  const bounded: ConversationMessage[] = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (message === undefined) continue;
    if (characters + message.content.length > MAX_HISTORY_CHARS && bounded.length > 0) break;
    bounded.unshift(message);
    characters += message.content.length;
  }
  return bounded;
}

/** Read a request's untrusted history without allowing arbitrary objects into the model call. */
export function readConversationHistory(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ConversationMessage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.content !== "string") {
      continue;
    }
    messages.push({ role: candidate.role, content: candidate.content });
  }
  return boundConversation(messages);
}

/** Context plus one new user message, in the shape accepted by Mastra Agent.stream. */
export function withPrompt(history: readonly ConversationMessage[], prompt: string): ConversationMessage[] {
  return [...boundConversation(history), { role: "user", content: prompt }];
}


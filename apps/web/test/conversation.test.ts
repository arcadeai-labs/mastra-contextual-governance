import { describe, expect, test } from "bun:test";

import {
  boundConversation,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  readConversationHistory,
  withPrompt,
} from "../lib/agent/conversation.ts";

describe("the in-memory conversation boundary", () => {
  test("keeps the newest bounded turns and clips oversized messages", () => {
    const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === MAX_HISTORY_MESSAGES + 3
          ? `${index}: ${"x".repeat(MAX_HISTORY_MESSAGE_CHARS + 100)}`
          : `${index}: short context`,
    }));
    const bounded = boundConversation(messages);

    expect(bounded).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(bounded[0]?.content.startsWith("4:")).toBe(true);
    expect(bounded.every((message) => message.content.length <= MAX_HISTORY_MESSAGE_CHARS)).toBe(true);
    expect(bounded.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(
      MAX_HISTORY_CHARS,
    );
  });

  test("drops malformed request entries before they reach the model", () => {
    expect(
      readConversationHistory([
        { role: "user", content: "keep this" },
        { role: "system", content: "do not accept this role" },
        { role: "assistant", content: 42 },
        null,
        "not a message",
      ]),
    ).toEqual([{ role: "user", content: "keep this" }]);
  });

  test("appends the current prompt after bounded context", () => {
    expect(
      withPrompt(
        [
          { role: "user", content: "What is the loan status?" },
          { role: "assistant", content: "It is pending." },
        ],
        "Now explain the approval path.",
      ),
    ).toEqual([
      { role: "user", content: "What is the loan status?" },
      { role: "assistant", content: "It is pending." },
      { role: "user", content: "Now explain the approval path." },
    ]);
  });
});

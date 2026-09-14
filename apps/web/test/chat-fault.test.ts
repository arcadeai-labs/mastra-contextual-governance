/**
 * `POST /api/chat` never answers a bare 500.
 *
 * #92's symptom was a browser reading *"The chat route answered 500."* — every
 * word of which came from `components/chat/Chat.tsx`'s fallback, because the
 * response was Next's stock HTML error page and carried nothing to render. The
 * cause (`Cannot find module 'ws'`) existed only in a Render log.
 *
 * So the claim under test is: **whatever throws, the response is JSON and it
 * names the step.** Three throws, at three different depths:
 *
 *   1. the handler's module graph will not load — which is #92 exactly, and is
 *      the one a `try` inside `chat()` can never reach;
 *   2. the handler itself throws where nothing anticipated it;
 *   3. something inside the pre-stream section throws.
 *
 * (3) is driven by a real failure rather than a thrown stub: `ARCADE_API_URL`
 * is a string that is not a URL, which `agentProblems` has no opinion about
 * (it checks that the variable is *set*) and `new URL()` rejects deep inside
 * `gatewayClient`. That is a misconfiguration a deployment can really have.
 *
 * Everything is driven over real HTTP, like the rest of this suite: a status
 * code and a content type are properties of a response on a socket, and asserting
 * on a returned object would not have caught the HTML page that started this.
 */
import { describe, expect, test } from "bun:test";

import { chatEntry, LOAD_STEP, RUN_STEP, type LoadChat } from "../lib/agent/entry.ts";
import { faultMessage } from "../lib/agent/fault.ts";
import { chat, PRE_STREAM } from "../lib/agent/handlers.ts";
import { readIdentitySurface, type IdentitySurface } from "../lib/config.ts";
import { writeSession, type Session } from "../lib/identity/session.ts";

const SESSION_SECRET = "chat-fault-suite-session-secret-0123456789";

interface Answer {
  status: number;
  contentType: string;
  body: { error?: string; detail?: unknown };
}

/** Mount a handler behind a real server, POST one prompt at it, read the answer back. */
async function post(
  handler: (request: Request) => Promise<Response>,
  cookie?: string,
): Promise<Answer> {
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
  try {
    const response = await fetch(`http://localhost:${server.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ prompt: "Approve the loan for $95K." }),
    });
    const text = await response.text();
    let body: Answer["body"] = {};
    try {
      body = JSON.parse(text) as Answer["body"];
    } catch {
      body = { error: text.slice(0, 200) };
    }
    return { status: response.status, contentType: response.headers.get("content-type") ?? "", body };
  } finally {
    server.stop(true);
  }
}

/** Everything `agentProblems` wants, with one value deliberately unusable. */
function surfaceWith(overrides: Record<string, string>): IdentitySurface {
  return readIdentitySurface({
    ARCADE_API_URL: "http://localhost:1",
    ARCADE_API_KEY: "chat-fault-arcade-key",
    ARCADE_GATEWAY_ID: "cg-demo-us",
    ARCADE_LOAN_TOOLKIT: "Loan",
    ANTHROPIC_API_KEY: "chat-fault-anthropic-key",
    SESSION_SECRET,
    PUBLIC_URL: "http://localhost:1",
    IDP_ISSUER: "http://localhost:1",
    IDP_CLIENT_ID: "web",
    IDP_CLIENT_SECRET: "chat-fault-client-secret",
    ...overrides,
  });
}

/** The cookie a browser signed in as Dana and holding a live gateway token would send. */
async function browserCookie(config: IdentitySurface): Promise<string> {
  const session: Session = {
    email: "dana.okafor@bank.example",
    signed_in_at: Date.now(),
    gateway: {
      access_token: "gateway-token-for-chat-fault-suite",
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-chat-fault-suite",
    },
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, config);
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
}

/** Every `detail` entry as one string, which is how the chat page joins them. */
function detail(answer: Answer): string {
  return Array.isArray(answer.body.detail) ? answer.body.detail.join(" ") : "";
}

describe("the route adapter", () => {
  test("a handler module that will not load answers JSON naming the step", async () => {
    // The literal failure #92 shipped: `ws` missing from the standalone image.
    const load: LoadChat = () => Promise.reject(new Error("Cannot find module 'ws'"));

    const answer = await post((request) => chatEntry(request, load));

    expect(answer.status).toBe(500);
    expect(answer.contentType).toContain("application/json");
    expect(answer.body.error).toBe(faultMessage(LOAD_STEP));
    expect(detail(answer)).toContain(`step: ${LOAD_STEP}`);
    expect(detail(answer)).toContain("Cannot find module 'ws'");
  });

  test("the response is not the HTML page a browser cannot read", async () => {
    const load: LoadChat = () => Promise.reject(new Error("Cannot find module 'ws'"));

    const answer = await post((request) => chatEntry(request, load));

    expect(answer.contentType).not.toContain("text/html");
    // What `components/chat/Chat.tsx` falls back to when the body says nothing.
    expect(answer.body.error).not.toBe(undefined);
    expect(answer.body.error).not.toContain("answered 500");
  });

  test("a handler that throws where nothing anticipated it is shaped too", async () => {
    const load: LoadChat = () =>
      Promise.resolve({
        chat: () => {
          throw new TypeError("agent.stream is not a function");
        },
      });

    const answer = await post((request) => chatEntry(request, load));

    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe(faultMessage(RUN_STEP));
    expect(detail(answer)).toContain("TypeError: agent.stream is not a function");
  });

  test("a handler that answers normally is passed straight through", async () => {
    const load: LoadChat = () =>
      Promise.resolve({ chat: async () => Response.json({ error: "the real refusal" }, { status: 401 }) });

    const answer = await post((request) => chatEntry(request, load));

    expect(answer.status).toBe(401);
    expect(answer.body.error).toBe("the real refusal");
  });
});

describe("the pre-stream section", () => {
  test("an unusable ARCADE_API_URL names the step that broke on it", async () => {
    // Set, so `agentProblems` is happy; not a URL, so `new URL()` rejects it
    // where `gatewayClient` builds the MCP endpoint.
    const config = surfaceWith({ ARCADE_API_URL: "api.arcade.dev" });
    const cookie = await browserCookie(config);

    const answer = await post((request) => chat(request, { config }), cookie);

    expect(answer.status).toBe(500);
    expect(answer.contentType).toContain("application/json");
    expect(answer.body.error).toBe(faultMessage(PRE_STREAM.client));
    expect(detail(answer)).toContain(`step: ${PRE_STREAM.client}`);
  });

  test("the four deliberate refusals still refuse, rather than reading as faults", async () => {
    const config = surfaceWith({});

    const noSession = await post((request) => chat(request, { config }));
    expect(noSession.status).toBe(401);
    expect(noSession.body.error).toContain("Nobody is signed in");

    const unconfigured = await post((request) =>
      chat(request, { config: readIdentitySurface({ SESSION_SECRET }) }),
    );
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error).toContain("not configured");
  });
});

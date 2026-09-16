/**
 * The pure parts of the agent path: which tools it is given, how a failed tool
 * call is read, and the stream protocol the page decodes.
 *
 * Everything here is a function of its arguments. The chain these functions sit
 * in — real control plane, real loan book, real MCP transport — is
 * `tracer-bullet.test.ts`; this file pins the decisions that would otherwise
 * only be observable through it, where a mistake would read as "the agent
 * behaved oddly" rather than as a wrong prefix.
 */
import { describe, expect, test } from "bun:test";

import {
  authorizationRequired,
  DENIAL_PREFIX,
  isHookDecision,
  remediationText,
} from "../lib/agent/authorization.ts";
import { decodeEvents, encodeEvent, replyText, type ChatEvent } from "../lib/agent/events.ts";
import { correlationRef, failureText, runTurn, type Streamable } from "../lib/agent/run.ts";
import { createNativeElicitationBridge, readNativeUrlElicitations } from "../lib/agent/native-elicitation.ts";
import { GATEWAY_BUILTINS, selectGoverned, wirePrefixes } from "../lib/agent/tools.ts";
import { readIdentitySurface } from "../lib/config.ts";
import { resolveStandInPort } from "../scripts/gateway-stand-in.ts";

/**
 * A live `tools/list` for a signed-in persona on `cg-demo-us`, measured
 * 2026-09-12: **eight** entries, not six. The two extras are the gateway's own.
 */
const LIVE_TOOLS_LIST = [
  "Loan_SearchLoans",
  "Loan_GetLoan",
  "Loan_ApproveLoan",
  "Loan_DenyLoan",
  "Approvals_RequestApproval",
  "Approvals_Decide",
  "System_ManageAuthorization",
  "Arcade_ListApps",
];

const asRecord = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, name]));

describe("which tools the agent is given", () => {
  test("the gateway's own two are dropped, and the project's six are kept", () => {
    const { governed, dropped } = selectGoverned(asRecord(LIVE_TOOLS_LIST), {
      toolkits: ["Loan", "Approvals"],
    });

    expect(Object.keys(governed)).toEqual([
      "Loan_SearchLoans",
      "Loan_GetLoan",
      "Loan_ApproveLoan",
      "Loan_DenyLoan",
      "Approvals_RequestApproval",
      "Approvals_Decide",
    ]);
    // Named, so that a future gateway built-in showing up in `dropped` is a
    // readable diff rather than a silent extra tool in the model's hands.
    expect(dropped).toEqual([...GATEWAY_BUILTINS]);
  });

  test("it is an allow-list, so a built-in nobody has heard of is still dropped", () => {
    // The point of an allow-list over a deny-list: Arcade adding a built-in
    // tomorrow must not put it in front of the model. A deny-list keyed on the
    // two names above would.
    const { governed, dropped } = selectGoverned(
      asRecord([...LIVE_TOOLS_LIST, "Arcade_SomethingNew"]),
      { toolkits: ["Loan"] },
    );
    expect(Object.keys(governed)).toEqual(["Loan_SearchLoans", "Loan_GetLoan", "Loan_ApproveLoan", "Loan_DenyLoan"]);
    expect(dropped).toContain("Arcade_SomethingNew");
  });

  test("the agent's own configured allow-list selects all six, from an empty environment", () => {
    // Round 1 of #88's review reproduced the bug with exactly these eight names
    // and `{ toolkits: ["Loan"] }`, which selected four and dropped
    // `Approvals_RequestApproval` and `Approvals_Decide` alongside the gateway
    // built-ins — so the pre-hook's own remediation instruction ("call
    // Approvals.RequestApproval") named a tool the model could not see.
    //
    // This asserts against `readIdentitySurface`'s value rather than a literal,
    // because the bug was not in `selectGoverned` — it was in what the chat
    // handler passed it. A test that hand-wrote `["Loan", "Approvals"]` here
    // would have passed while the handler stayed wrong.
    const { agent } = readIdentitySurface({});
    expect(agent.toolkits).toEqual(["Loan", "Approvals"]);

    const { governed, dropped } = selectGoverned(asRecord(LIVE_TOOLS_LIST), agent);
    expect(Object.keys(governed)).toHaveLength(6);
    expect(Object.keys(governed)).toContain("Approvals_RequestApproval");
    expect(Object.keys(governed)).toContain("Approvals_Decide");
    expect(dropped).toEqual([...GATEWAY_BUILTINS]);
  });

  test("a blank toolkit name does not become a prefix that matches everything", () => {
    // `"" + "_"` is `"_"`, and `startsWith("_")` matches nothing — but a bare
    // empty prefix in a different implementation would match every tool the
    // gateway advertises, built-ins included. `wirePrefixes` drops blanks, and
    // `readIdentitySurface` filters them out before they get here.
    expect(readIdentitySurface({ ARCADE_APPROVALS_TOOLKIT: "   " }).agent.toolkits).toEqual([
      "Loan",
      "Approvals",
    ]);
    const { governed } = selectGoverned(asRecord(LIVE_TOOLS_LIST), { toolkits: ["", "  "] });
    expect(Object.keys(governed)).toEqual([]);
  });

  test("a misspelled toolkit selects nothing rather than selecting loosely", () => {
    // `loan` is what a rule keyed on the wrong case would look like, and this
    // repo's recurring failure is a match that silently matches nothing. Here
    // that is survivable only because `handlers.ts` refuses an empty selection
    // — this test pins the emptiness so that refusal has something to catch.
    const { governed } = selectGoverned(asRecord(LIVE_TOOLS_LIST), { toolkits: ["loan"] });
    expect(Object.keys(governed)).toEqual([]);
  });

  test("the prefix is the toolkit plus an underscore, which is how MCP spells it", () => {
    // MCP: `Loan_GetLoan`. The hook frame: `Loan.GetLoan`. Two spellings of one
    // tool; there is no third.
    expect(wirePrefixes({ toolkits: ["Loan", "Approvals"] })).toEqual(["Loan_", "Approvals_"]);
    expect(wirePrefixes({ toolkits: ["Loan", "  ", ""] })).toEqual(["Loan_"]);
  });
});

describe("reading a failed tool call", () => {
  /** The shape measured off `@mastra/mcp` 1.17 on 2026-09-12. */
  const mastraToolError = (message: string) => ({
    name: "Error",
    cause: { message, code: "MCP_CLIENT_TOOL_EXECUTION_FAILED", details: { toolName: "Loan_ApproveLoan" } },
    id: "TOOL_EXECUTION_FAILED",
  });

  test("the hook's own sentence comes out of the wrapper Mastra puts round it", () => {
    const hookMessage = `${DENIAL_PREFIX}DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. [ref evt_tkgv4b30gj]`;
    expect(failureText(mastraToolError(hookMessage))).toBe(hookMessage);
  });

  test("Arcade's prefix is stripped and the rule author's words are not touched", () => {
    const reason = "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. [ref evt_tkgv4b30gj]";
    expect(remediationText(DENIAL_PREFIX + reason)).toBe(reason);
  });

  test("a message without the prefix comes back whole, not empty", () => {
    // The prefix is Arcade's, undocumented, and may change (#2). Anything
    // parsing it fails soft: a refusal on screen with no reason on it would be
    // worse than an unstripped prefix.
    expect(remediationText("DENIED: something")).toBe("DENIED: something");
  });

  test("the audit row's id is read back out, and its absence is not a failure", () => {
    expect(correlationRef("DENIED: no. [ref evt_tkgv4b30gj]")).toBe("evt_tkgv4b30gj");
    expect(correlationRef("DENIED: no.")).toBeNull();
  });

  test("something entirely unexpected still produces text rather than nothing", () => {
    expect(failureText({ weird: true })).toBe('{"weird":true}');
    expect(failureText("plain")).toBe("plain");
  });
});

describe("layer 2, which is not a denial", () => {
  const challenge = JSON.stringify({
    authorization_url: "https://cloud.arcade.dev/api/v1/oauth/flow/abc",
    llm_instructions: "Tell the user to click the link to authorize, then try again.",
  });

  test("the link and Arcade's own instructions are read out of the failure", () => {
    expect(authorizationRequired(challenge)).toEqual({
      url: "https://cloud.arcade.dev/api/v1/oauth/flow/abc",
      instructions: "Tell the user to click the link to authorize, then try again.",
    });
  });

  test("a hook denial is not mistaken for one", () => {
    // Both arrive as `isError: true` plus text and nothing in the transport
    // tells them apart. Getting this backwards puts a refusal on screen that no
    // audit row backs, and somebody goes looking for the rule that caused it.
    expect(authorizationRequired(`${DENIAL_PREFIX}DENIED: over your limit.`)).toBeNull();
  });

  test("a link that is not a page a person can open is refused", () => {
    // A model can put text on screen, and act 4 is about it trying. An
    // `authorization_url` is rendered as a clickable link, so the schemes it
    // may carry are the two that name a page.
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "", "   "]) {
      expect(authorizationRequired(JSON.stringify({ authorization_url: url }))).toBeNull();
    }
  });

  test("JSON that is not a challenge, and text that is not JSON, are both just failures", () => {
    expect(authorizationRequired("not json at all")).toBeNull();
    expect(authorizationRequired('{"ok":true}')).toBeNull();
    expect(authorizationRequired("[1,2,3]")).toBeNull();
    expect(authorizationRequired("null")).toBeNull();
  });

  test("instructions are optional and an empty one is dropped rather than rendered", () => {
    expect(authorizationRequired(JSON.stringify({ authorization_url: "https://x.test/a", llm_instructions: "  " })))
      .toEqual({ url: "https://x.test/a" });
  });
});

describe("native MCP URL elicitation", () => {
  const request = {
    mode: "url",
    message: "Authorize the connected provider, then continue.",
    url: "https://provider.example/consent/req-1",
    elicitationId: "elicitation-1",
  } as const;

  test("reads URL requests from the -32042 error shape", () => {
    expect(
      readNativeUrlElicitations({ code: -32042, data: { elicitations: [request] } }),
    ).toEqual([request]);
  });

  test("rejects non-http links and deduplicates nested wrappers", () => {
    const unsafe = { ...request, url: "javascript:alert(1)" };
    expect(readNativeUrlElicitations({ cause: { data: { elicitations: [unsafe] } } })).toEqual([]);
    expect(readNativeUrlElicitations({ error: { data: { elicitations: [request] } }, data: { elicitations: [request] } }))
      .toEqual([request]);
  });

  test("the request-scoped bridge captures a request and always cancels it", async () => {
    const bridge = createNativeElicitationBridge();
    await expect(bridge.handle(request)).resolves.toEqual({ action: "cancel" });
    expect(bridge.take()).toEqual([request]);
    expect(bridge.take()).toEqual([]);
  });

  test("the MCP initialize advertises URL elicitation capability", async () => {
    let initializeParams: Record<string, unknown> | null = null;
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = (await request.json()) as { id?: unknown; method?: string; params?: Record<string, unknown> };
        if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (message.method === "initialize") {
          initializeParams = message.params ?? null;
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "native-elicitation-test", version: "0.1.0" },
            },
          });
        }
        if (message.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "Loan_GetLoan",
                  description: "Read one loan.",
                  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
                },
              ],
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: message.id ?? null, result: {} });
      },
    });
    const client = (await import("../lib/agent/tools.ts")).gatewayClient({
      arcadeApiUrl: `http://localhost:${gateway.port}`,
      gatewayId: "native-elicitation-test",
      token: "synthetic-token",
    });
    try {
      await client.listToolsetsWithErrors();
      const capabilities = (initializeParams as Record<string, unknown> | null)?.capabilities as
        | Record<string, unknown>
        | undefined;
      expect(capabilities?.elicitation).toEqual({ url: {} });
    } finally {
      await client.disconnect().catch(() => undefined);
      gateway.stop(true);
    }
  });

  test("a structured -32042 failure becomes an authorization card, not a fault", async () => {
    const events: ChatEvent[] = [];
    const agent: Streamable = {
      stream() {
        return Promise.resolve({
          fullStream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "tool-error",
                payload: {
                  toolName: "Loan_GetLoan",
                  error: { code: -32042, data: { elicitations: [request] } },
                },
              });
              controller.close();
            },
          }),
        });
      },
    };

    await runTurn({
      agent,
      prompt: "look up the loan",
      emit: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      {
        kind: "authorization",
        tool: "Loan_GetLoan",
        url: request.url,
        instructions: request.message,
        mode: "url",
        elicitation_id: request.elicitationId,
      },
      { kind: "done", calls: 0 },
    ]);
  });
});

describe("the stream protocol", () => {
  const events: ChatEvent[] = [
    { kind: "tool-call", tool: "Loan_ApproveLoan", inputs: { loan_id: "LN-2291", amount: 95000 } },
    { kind: "denied", tool: "Loan_ApproveLoan", reason: "DENIED: no. [ref evt_aaaaaaaaaa]", ref: "evt_aaaaaaaaaa" },
    { kind: "text", text: "I could not " },
    { kind: "text", text: "approve it." },
    { kind: "done", calls: 1 },
  ];

  test("it round-trips, one JSON object per line", () => {
    expect(decodeEvents(events.map(encodeEvent).join(""))).toEqual(events);
  });

  test("a truncated stream keeps the events that did arrive", () => {
    // A chat that ends mid-turn should still show what happened up to there.
    const body = `${events.map(encodeEvent).join("")}{"kind":"do`;
    expect(decodeEvents(body)).toEqual(events);
  });

  test("the reply is every text event in order and nothing else", () => {
    expect(replyText(events)).toBe("I could not approve it.");
  });
});

describe("the runnable stand-in's port", () => {
  test("it comes from ARCADE_API_URL, never from PORT", () => {
    // #56's bug, arriving in a new script: `bun run --cwd apps/web
    // gateway-stand-in` loads `apps/web/.env.local`, whose `PORT` belongs to
    // the web app. Measured while writing this — the stand-in announced :4400
    // and answered on it, which is where `next dev` wants to be.
    expect(resolveStandInPort({ ARCADE_API_URL: "http://localhost:4405", PORT: "4400" })).toBe(4405);
  });

  test("unset means :0, so the OS picks and the boot line says what it got", () => {
    expect(resolveStandInPort({ PORT: "4400" })).toBe(0);
    expect(resolveStandInPort({ ARCADE_API_URL: "   " })).toBe(0);
  });

  test("a URL with no port is refused rather than defaulted", () => {
    // `https://api.arcade.dev` is real Arcade on 443, not something this can
    // stand in for. A default here would bind a port nobody is calling and
    // look like it worked.
    expect(() => resolveStandInPort({ ARCADE_API_URL: "https://api.arcade.dev" })).toThrow("names no port");
    // `new URL("localhost:4405")` reads `localhost:` as the scheme and hands
    // back an empty port, so an unchecked parse would report this as "names no
    // port" and send somebody looking for a port that is right there.
    expect(() => resolveStandInPort({ ARCADE_API_URL: "localhost:4405" })).toThrow("is not an http(s) URL");
  });
});

describe("a tool that failed is not the same as a tool that was refused", () => {
  // Round 1 of #88's review: every non-authorization tool error was labelled
  // `denied`. A probe with `Loan_GetLoan` failing as "The loan origination
  // system could not be reached" produced
  // `{kind:"denied", reason:"The loan origination system could not be reached", ref:null}`
  // — a refusal on screen that no hook made and no audit row backs.

  test("a socket error is not a hook decision", () => {
    for (const text of [
      "The loan origination system could not be reached.",
      "the control plane at http://localhost:4401 could not be reached: Unable to connect.",
      "fetch failed",
      "No loan application found with ID LN-9999.",
      "",
    ]) {
      expect(isHookDecision(text)).toBe(false);
    }
  });

  test("any one of the four control-plane markers is enough", () => {
    // Any rather than all, deliberately: Arcade's prefix is undocumented and
    // liable to change, and the `[ref …]` token is ours. Requiring both would
    // put every denial in the demo one vendor string away from silently
    // becoming an infrastructure error.
    expect(isHookDecision(`${DENIAL_PREFIX}DENIED: over your limit.`)).toBe(true);
    expect(isHookDecision("CHECK_FAILED: policy refused this call")).toBe(true);
    expect(isHookDecision("CONTEXT_DENIED: you cannot see this tool")).toBe(true);
    expect(isHookDecision("DENIED: over your limit. [ref evt_tkgv4b30gj]")).toBe(true);
  });

  test("a fail-closed denial, which carries a token but not the prefix, still reads as a decision", () => {
    // `apps/hooks` fails closed when its policy will not compile, and that
    // refusal is a decision with an audit row behind it. Rendering it as
    // plumbing would hide the one state an operator most needs to see.
    const failClosed =
      "DENIED: the control plane cannot evaluate Loan.ApproveLoan because its policy is " +
      "unavailable. Do not retry; report the reference to an administrator. [ref evt_tkgv4b30gj]";
    expect(isHookDecision(failClosed)).toBe(true);
  });
});

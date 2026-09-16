/**
 * The tools the agent is given, and the ones it is not.
 *
 * `DESIGN.md` → Integration: Mastra `MCPClient` against
 * `https://api.arcade.dev/mcp/{gateway}`. The bearer is the signed-in persona's
 * gateway token from #82's sealed session, handed over as a **static** auth
 * provider — `{ token: async () => … }`, the minimal `AuthProvider` the MCP
 * SDK documents for "API keys, gateway-managed tokens".
 *
 * Static is not a shortcut. The three alternatives are all wrong here:
 *
 * - `MCPClient.authenticate()` drives an OAuth flow with a loopback redirect
 *   and refuses a non-loopback one, and this service is deployed at an HTTPS
 *   origin nobody's browser can reach a loopback listener on (#04, #82).
 * - A header or a query parameter naming the persona is an actor the model can
 *   forge — `DESIGN.md` rule 1, and act 4 is specifically about the model
 *   trying.
 * - Letting the client hold one long-lived token would make every persona's
 *   calls the same person's. The token comes from **this browser's** session,
 *   so a client is built per request and thrown away.
 *
 * That last point is why nothing here is cached across requests. A per-process
 * `MCPClient` would be a per-process persona.
 */
import { MCPClient } from "@mastra/mcp";

import { mcpUrl } from "../identity/gateway.ts";

/** The server key this client files the gateway under. One server, one key. */
export const SERVER_KEY = "arcade";

/**
 * What a live `tools/list` returns for a signed-in persona that is **not** a
 * loan tool — measured against `cg-demo-us` on 2026-09-12, which answered with
 * eight entries: the project's six plus these two.
 *
 * They are named here for documentation only. The filter below is an
 * allow-list on the project's own toolkits, not a deny-list on these, because a
 * deny-list would silently hand the agent whatever built-in Arcade adds next.
 */
export const GATEWAY_BUILTINS = ["System_ManageAuthorization", "Arcade_ListApps"] as const;

export interface ToolSurface {
  /** Toolkit names as Arcade files them — `Loan`, `Approvals`. PascalCase, measured on #35. */
  toolkits: readonly string[];
}

/**
 * `Loan` → the prefix a wire tool name starts with.
 *
 * MCP names a tool `Loan_GetLoan`; the hook frame names the same tool
 * `Loan.GetLoan`. Both spellings are real and neither is invented here — see
 * `scripts/gateway-stand-in.ts::qualifiedToolName` for the conversion, which is
 * the only place in the repo that does it.
 */
export function wirePrefixes(surface: ToolSurface): string[] {
  return surface.toolkits.filter((name) => name.trim() !== "").map((name) => `${name.trim()}_`);
}

/**
 * The governed tools, out of everything the gateway advertises.
 *
 * An allow-list keyed on the project's own toolkit names. Two consequences
 * worth stating, because both are the kind of thing that fails quietly:
 *
 * - A toolkit name that is wrong matches nothing, and an agent with no tools
 *   looks exactly like an agent whose tools were all denied. `selectGoverned`
 *   returns what it dropped so the caller can say which it was, and
 *   `lib/agent/run.ts` refuses to run with an empty selection.
 * - The two gateway built-ins are dropped by construction rather than by name.
 *   Handing `System_ManageAuthorization` to a model that has just been refused
 *   by a hook is handing it the tool whose whole job is to acquire
 *   authorization.
 */
export function selectGoverned<T>(
  tools: Record<string, T>,
  surface: ToolSurface,
): { governed: Record<string, T>; dropped: string[] } {
  const prefixes = wirePrefixes(surface);
  const governed: Record<string, T> = {};
  const dropped: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) governed[name] = tool;
    else dropped.push(name);
  }
  return { governed, dropped };
}

export interface GatewayToolsOptions {
  /** Arcade's API root — `https://api.arcade.dev`, or a stand-in. */
  arcadeApiUrl: string;
  /** `cg-demo-us`. */
  gatewayId: string;
  /** This browser's persona's gateway bearer, already refreshed if it needed to be. */
  token: string;
  /** Milliseconds for a single MCP request. */
  timeoutMs?: number;
}

/**
 * A client for one request, carrying one persona's token.
 *
 * `id` is randomised because `MCPClient` caches instances by configuration to
 * avoid leaking them, and two personas' clients are identical in every field
 * the cache looks at except the one that matters. Without it, the second
 * persona to ask for tools in a process would get the first persona's
 * connection — the exact "collapses every tool call onto whoever signed in
 * last" failure #75 named, arriving by a different route.
 */
export function gatewayClient(options: GatewayToolsOptions): MCPClient {
  return new MCPClient({
    id: `cg-web-${crypto.randomUUID()}`,
    servers: {
      [SERVER_KEY]: {
        url: new URL(mcpUrl(options.arcadeApiUrl, options.gatewayId)),
        // The static auth provider. `token()` is called before every request
        // and returns what this browser's session holds.
        authProvider: { token: async () => options.token },
        // MCP URL elicitation is client-advertised. The request-scoped handler
        // is registered by the chat route before this client connects.
        capabilities: { elicitation: { url: {} } },
        // Default, stated: a spec-compliant `isError: true` result is raised on
        // Mastra's failed-tool-call path carrying the server's text, which is
        // how the hook's remediation instruction reaches the model at all.
        // `'return'` would hand the model a success-shaped object and the
        // denial would become invisible to it.
        onToolError: "throw",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    },
  });
}

/**
 * The governed toolset for this persona, what was left out, and whether the
 * gateway answered at all.
 *
 * Toolsets rather than the flat `listTools()` on purpose: the flat form
 * namespaces every tool with the server key, so `Loan_ApproveLoan` would reach
 * the model as `arcade_Loan_ApproveLoan`. The name the model sees should be the
 * name the wire uses and the name a rule is keyed on, modulo the dot.
 *
 * **`listToolsetsWithErrors()` rather than `listToolsets()`, and that is the
 * #94 fix in this file.** `listToolsets()` resolves with `{}` when the server
 * could not be reached *or* refused the bearer — the failure is logged and
 * dropped, and what the caller gets back is indistinguishable from a gateway
 * that answered a perfectly good `tools/list` carrying none of our toolkits.
 * Those are two different sentences to put on screen and only one of them
 * mentions `ARCADE_LOAN_TOOLKIT`. The `WithErrors` variant hands back the
 * per-server failure, so `error` here means *no listing arrived* and an empty
 * `advertised` with no `error` means *the gateway really advertises nothing*.
 */
export async function governedToolset(
  client: MCPClient,
  surface: ToolSurface,
): Promise<{ tools: Record<string, unknown>; advertised: string[]; dropped: string[]; error?: string }> {
  const { toolsets, errors } = await client.listToolsetsWithErrors();
  const advertisedTools = (toolsets[SERVER_KEY] ?? {}) as Record<string, unknown>;
  const { governed, dropped } = selectGoverned(advertisedTools, surface);
  const failure = errors[SERVER_KEY];
  return {
    tools: governed,
    advertised: Object.keys(advertisedTools),
    dropped,
    ...(failure ? { error: failure } : {}),
  };
}

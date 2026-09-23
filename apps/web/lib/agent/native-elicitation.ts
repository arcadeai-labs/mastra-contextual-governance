/**
 * The native MCP URL-elicitation seam.
 *
 * The installed MCP client (via @mastra/mcp 2) advertises the URL capability
 * and hands `elicitation/create` requests to the `inputRequests` handler it
 * was constructed with — see `tools.ts::gatewayClient`. A request-scoped
 * bridge captures only URL-mode requests, emits them through the chat event
 * stream, and returns `cancel` immediately. The browser cannot answer an
 * in-flight MCP request from a separate HTTP POST without process-global
 * state; the auth card therefore opens the URL and explicitly starts a fresh
 * turn/read when the person continues. Nothing in that retry is treated as proof
 * that authorization was granted.
 */

export interface NativeUrlElicitation {
  mode: "url";
  message: string;
  url: string;
  elicitationId: string;
}

export interface NativeElicitationResult {
  action: "cancel";
  [key: string]: unknown;
}

/**
 * Read URL-mode requests from either a direct MCP request or the nested
 * `error.data.elicitations` shape used by protocol error `-32042`.
 *
 * This deliberately accepts unknown values because Mastra wraps MCP errors in
 * several layers before they reach `fullStream`. It validates every field and
 * URL scheme before returning anything the UI may render as a link.
 */
export function readNativeUrlElicitations(value: unknown, depth = 0): NativeUrlElicitation[] {
  if (depth > 6 || value === null || value === undefined) return [];

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed === value ? [] : readNativeUrlElicitations(parsed, depth + 1);
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => readNativeUrlElicitations(entry, depth + 1));
  }

  if (typeof value !== "object") return [];
  const body = value as Record<string, unknown>;
  const requests: NativeUrlElicitation[] = [];

  if (body.mode === "url" && typeof body.message === "string" && typeof body.url === "string" &&
      typeof body.elicitationId === "string" && isHttpUrl(body.url)) {
    requests.push({
      mode: "url",
      message: body.message,
      url: body.url,
      elicitationId: body.elicitationId,
    });
  }

  for (const key of ["elicitations", "data", "error", "cause", "details", "inputRequests", "params"]) {
    const nested = body[key];
    if (nested !== undefined) requests.push(...readNativeUrlElicitations(nested, depth + 1));
  }

  const unique = new Map<string, NativeUrlElicitation>();
  for (const request of requests) unique.set(`${request.elicitationId}:${request.url}`, request);
  return [...unique.values()];
}

/**
 * Whether a response carried a URL-mode request, even when its URL failed the
 * safe HTTP(S) check. The browser must not render an unsafe link, but it must
 * still pause the page instead of treating the canceled authorization as a
 * normal empty tool result and continuing to another read.
 */
export function hasNativeUrlElicitation(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed === value ? false : hasNativeUrlElicitation(parsed, depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((entry) => hasNativeUrlElicitation(entry, depth + 1));
  if (typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (
    body.mode === "url" &&
    typeof body.message === "string" &&
    typeof body.url === "string" &&
    typeof body.elicitationId === "string"
  ) {
    return true;
  }
  return ["elicitations", "data", "error", "cause", "details", "inputRequests", "params"].some((key) =>
    hasNativeUrlElicitation(body[key], depth + 1),
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * One bridge per request. A native request is never accepted implicitly;
 * cancellation lets the current MCP call finish while the UI offers the
 * explicit fallback continuation action.
 */
export function createNativeElicitationBridge(options: { onRequest?: () => void } = {}) {
  let pending: NativeUrlElicitation[] = [];
  let pendingSignals = 0;

  return {
    handle: async (params: unknown): Promise<NativeElicitationResult> => {
      const requests = readNativeUrlElicitations(params);
      if (hasNativeUrlElicitation(params)) {
        pending.push(...requests);
        pendingSignals += 1;
        // The callback is deliberately synchronous with the protocol request.
        // A model can have queued tool dispatches by the time `runTurn` sees
        // the resulting error; closing the turn here prevents those dispatches
        // from reaching the gateway. The current request is already in flight
        // and is allowed to settle, which is the precise boundary we can make.
        options.onRequest?.();
      }
      return { action: "cancel" };
    },
    take: (): NativeUrlElicitation[] => {
      const current = pending;
      pending = [];
      return current;
    },
    takeSignal: (): boolean => {
      const current = pendingSignals > 0;
      pendingSignals = 0;
      return current;
    },
  };
}

export type NativeElicitationBridge = ReturnType<typeof createNativeElicitationBridge>;

/**
 * Layer 2, as the chat has to render it.
 *
 * `DESIGN.md` → Thesis, layer 2: "whether you hold the credential to call it at
 * all". Arcade evaluates a tool's auth requirement **before** `/pre`, so a
 * persona's first governed call can come back not as a result and not as a hook
 * denial, but as an instruction to go and authorize. Measured 2026-09-12: the
 * tool result is `isError: true` and its text is JSON carrying
 * `authorization_url` and `llm_instructions`.
 *
 * Two things follow, and both matter more than the parsing.
 *
 * 1. **It arrives in the same envelope as a hook denial.** `isError: true` plus
 *    text, either way. Nothing in the transport distinguishes them, so the only
 *    way to tell them apart is to read the text — which is what this file is
 *    for. Reported as a denial it would put a refusal on screen that no audit
 *    row backs and no rule produced, and someone would go looking for the rule.
 * 2. **It is not a refusal at all.** Nothing was denied; a credential is
 *    missing. The chat renders the link as a step for the person to take and
 *    stops, rather than letting the model retry into the same wall.
 *
 * Alice and Bob hold live `cg-idp` grants, so a rehearsal will not reach this
 * path. That is exactly why it has a test: a path the demo never walks is a
 * path that rots, and the first person it breaks for is a forker on their first
 * run, when every persona is unauthorized.
 */

import { CORRELATION_TOKEN } from "../governance/correlation.ts";

export interface AuthorizationRequired {
  /** Where the persona has to go. Rendered as a link; never followed server-side. */
  url?: string;
  /** Arcade's own words for the model. Shown as-is; this service does not rewrite them. */
  instructions?: string;
}

/**
 * The authorization challenge inside a tool result/error, or `null`.
 *
 * Fails soft in every direction. Text that is not JSON, JSON that is not an
 * object, an object without `authorization_url`, a `url` that is not a string,
 * a scheme that is not http(s) — all of them come back `null`, which means "a
 * tool failed" and is handled as one. The alternative is a chat that renders a
 * link out of an error message, and a link the model can put on screen is a
 * link a prompt injection can put on screen (act 4 is about exactly that).
 */
export function authorizationRequired(value: unknown): AuthorizationRequired | null {
  const candidates = objectCandidates(value);

  // Legacy layer-2 auth is a JSON string carrying an authorization URL. Check
  // it first because the same MCP error wrapper may contain a code or nested
  // data object as well.
  for (const candidate of candidates) {
    const url = validUrl(candidate.authorization_url);
    if (url === null) continue;
    const instructions = candidate.llm_instructions;
    return {
      url,
      ...(typeof instructions === "string" && instructions.trim() !== "" ? { instructions } : {}),
    };
  }

  // Modern MCP URL elicitation can arrive as a successful input-required
  // result, while some gateways flatten it to JSON-RPC -32042. Neither
  // necessarily contains a URL, so the UI can still offer an explicit
  // Continue attempt when only the protocol signal survives.
  const native = candidates.some(
    (candidate) =>
      candidate.resultType === "input_required" ||
      candidate.type === "input_required" ||
      candidate.input_required === true ||
      candidate.method === "elicitation/create" ||
      candidate.code === -32042 ||
      candidate.code === "-32042",
  );
  if (!native) return null;

  const url = firstValidUrl(candidates, ["authorization_url", "authorizationUrl", "authorization_endpoint", "url"]);
  const instructions = firstString(candidates, "llm_instructions") ?? firstString(candidates, "message");
  return {
    ...(url === null ? {} : { url }),
    ...(instructions === null ? {} : { instructions }),
  };
}

/** Parse structured values commonly nested in MCP/Mastra wrappers. */
function objectCandidates(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number) => {
    if (depth > 8 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed !== candidate) visit(parsed, depth + 1);
      } catch {
        // A plain error message is not a structured auth challenge.
      }
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const record = candidate as Record<string, unknown>;
    found.push(record);
    for (const child of Object.values(record)) visit(child, depth + 1);
  };

  visit(value, 0);
  return found;
}

function firstValidUrl(candidates: Array<Record<string, unknown>>, keys: string[]): string | null {
  for (const candidate of candidates) {
    for (const key of keys) {
      const url = validUrl(candidate[key]);
      if (url !== null) return url;
    }
  }
  return null;
}

function firstString(candidates: Array<Record<string, unknown>>, key: string): string | null {
  for (const candidate of candidates) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function validUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const scheme = new URL(value).protocol;
    return scheme === "https:" || scheme === "http:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Arcade's fixed prefix ahead of a hook's `error_message`, measured on spike #2
 * and undocumented — so anything reading it fails soft.
 */
export const DENIAL_PREFIX = "Tool execution was denied by an extension policy: ";

/**
 * Was this tool failure a decision the control plane made?
 *
 * Round 1 of #88's review found the answer being assumed rather than asked.
 * Every non-authorization tool error was labelled `denied`, so a loan API that
 * could not be reached rendered as *"denied by the control plane"* with the
 * connection error as the rule's reason — a refusal on screen that no hook
 * made, no rule produced and no audit row backs. On a demo whose entire claim
 * is *"the control plane decided this"*, that is the worst possible lie for the
 * UI to tell, and it is indistinguishable from the real thing.
 *
 * So a denial now needs **positive evidence** of the control plane, and
 * anything else is a `fault`. Four markers, any one of which is enough:
 *
 * - Arcade's prefix, which is what a hook denial crosses MCP behind (spike #2).
 * - `CHECK_FAILED`, the `/pre` refusal code.
 * - `CONTEXT_DENIED`, the `/access` one — `@arcadeai/arcadejs`'s typed errors,
 *   which flatten toward text over MCP but keep the word.
 * - The `[ref evt_…]` correlation token (#6). Only `apps/hooks` writes one, and
 *   it writes one on every decision it makes.
 *
 * Any of them rather than all of them, deliberately. The prefix is Arcade's,
 * undocumented and liable to change; the token is ours and survives a change to
 * theirs. Requiring both would mean one vendor string away from every denial in
 * the demo silently becoming an infrastructure error.
 *
 * The asymmetry is on purpose in the other direction too. A hook denial
 * mislabelled `fault` reads as "something broke" — wrong, and obviously wrong
 * to anyone watching, because the panel will show the decision this screen
 * denies. A fault mislabelled `denied` reads as governance working, and nobody
 * ever finds out.
 */
export function isHookDecision(text: string): boolean {
  return (
    text.startsWith(DENIAL_PREFIX) ||
    text.includes("CHECK_FAILED") ||
    text.includes("CONTEXT_DENIED") ||
    CORRELATION_TOKEN.test(text)
  );
}

/**
 * The hook's own message out of a failed tool call's text.
 *
 * The prefix is stripped when it is there and the text returned whole when it
 * is not. A denial is still a denial if Arcade changes its wording; what must
 * never happen is this function returning an empty string because it expected a
 * prefix that moved, which would put a refusal on screen with no reason on it.
 */
export function remediationText(text: string): string {
  return text.startsWith(DENIAL_PREFIX) ? text.slice(DENIAL_PREFIX.length) : text;
}

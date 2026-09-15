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
  url: string;
  /** Arcade's own words for the model. Shown as-is; this service does not rewrite them. */
  instructions?: string;
}

/**
 * The authorization challenge inside a failed tool call's text, or `null`.
 *
 * Fails soft in every direction. Text that is not JSON, JSON that is not an
 * object, an object without `authorization_url`, a `url` that is not a string,
 * a scheme that is not http(s) — all of them come back `null`, which means "a
 * tool failed" and is handled as one. The alternative is a chat that renders a
 * link out of an error message, and a link the model can put on screen is a
 * link a prompt injection can put on screen (act 4 is about exactly that).
 */
export function authorizationRequired(text: string): AuthorizationRequired | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const body = parsed as Record<string, unknown>;
  const url = body.authorization_url;
  if (typeof url !== "string" || url.trim() === "") return null;

  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return null;
  }
  // An `authorization_url` is a page a person is asked to open. A
  // `javascript:` or `data:` one is not that, whoever put it there.
  if (scheme !== "https:" && scheme !== "http:") return null;

  const instructions = body.llm_instructions;
  return {
    url,
    ...(typeof instructions === "string" && instructions.trim() !== "" ? { instructions } : {}),
  };
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

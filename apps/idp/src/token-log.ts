/**
 * One line per `/oauth2/token` request — including the ones that work.
 *
 * Until #100 this service logged only rejections, and that is precisely why the
 * bug took three sittings. The log showed two `invalid_grant` lines 216 ms apart
 * and nothing else: the *successful* first exchange that minted the tokens was
 * invisible, so the double hit could be inferred but never counted, and the
 * caller behind it was never attributed at all. "Something is fetching the
 * authorization callback twice" was the most the log could say.
 *
 * So every request leaves a line carrying the five things that answer "who hit
 * this, when, with which code, and what did they get":
 *
 * ```
 * [idp] POST /oauth2/token at=2026-09-14T21:05:28.383Z grant=authorization_code \
 *   code=Ab3xK9pQ code_state=already_consumed outcome=invalid_grant \
 *   client_id=RskTFjl6… ua="arcade-engine/1.4" ip=203.0.113.7
 * ```
 *
 * The detailed rejection line (`POST /oauth2/token rejected: …`) is unchanged and
 * still follows a failure. This one is the census; that one is the diagnosis.
 */

/**
 * How much of an authorization code goes in the log: the first 8 characters.
 *
 * Enough to pair two requests that presented the same code — which is the whole
 * question — and not enough to spend one. Codes here are 32 characters of
 * `generateRandomString(32, "A-Z", "a-z")`, so a prefix leaves ~10^40 of search
 * space, and by the time a line is written the code is either already consumed
 * or about to be. The full value is never printed: it is a credential until it
 * is spent, and the line that matters most is written at the exact moment
 * somebody else may be holding it.
 */
export function codePrefix(code: string | null): string {
  if (!code) return "(none)";
  return code.slice(0, 8);
}

/**
 * The client's address as Render reports it: the **first** hop of
 * `X-Forwarded-For`.
 *
 * Render's proxy appends, so the header reads `<client>, <proxy>, …` and the
 * left-most entry is the caller. Taking the last would name Render's own edge on
 * every line, which is the same value every time and therefore attributes
 * nothing. The header is spoofable by a direct caller, but cg-idp is only
 * reachable through that proxy, which overwrites the hop it adds.
 *
 * `(none)` when the header is absent — a direct connection, which is what a
 * local test and a local dev server both are.
 */
export function forwardedFor(header: string | null): string {
  const first = header?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "(none)";
}

/** Longest `User-Agent` that reaches the log, so a hostile one cannot flood it. */
const USER_AGENT_LIMIT = 120;

/**
 * The `User-Agent`, quoted and bounded.
 *
 * Quoted because it contains spaces and slashes and a bare one would run into
 * the next field. Bounded because it is attacker-controlled and unbounded on the
 * wire; Arcade's is well under the limit, so the truncation only ever fires for
 * something that was not going to be readable anyway.
 */
export function userAgent(header: string | null): string {
  if (!header) return '"(none)"';
  const value =
    header.length > USER_AGENT_LIMIT ? `${header.slice(0, USER_AGENT_LIMIT)}…` : header;
  return JSON.stringify(value);
}

/**
 * What the request got, in one word.
 *
 * The OAuth `error` code when the body carries one, because that is the
 * vocabulary every other line and every RFC uses. `http_<status>` when a
 * response failed without one — a 500 from somewhere below the plugin, say —
 * so the line still says *something* rather than `(none)`.
 */
export function outcome(status: number, error: string | undefined): string {
  if (status < 400) return "success";
  return error ?? `http_${status}`;
}

export interface TokenLogLine {
  /** Millisecond UTC, captured when the request arrived. */
  at: string;
  grantType: string | null;
  code: string | null;
  /** `already_consumed` / `unknown`, only when the plugin's answer was the ambiguous one. */
  codeState: string | null;
  status: number;
  error: string | undefined;
  clientId: string;
  userAgent: string | null;
  forwardedFor: string | null;
}

/**
 * The line itself. Field order is fixed so `grep` and the eye both find the same
 * thing in the same place on every line.
 */
export function formatTokenLine(service: string, path: string, line: TokenLogLine): string {
  return (
    `[${service}] POST ${path} at=${line.at} ` +
    `grant=${line.grantType ?? "(none)"} ` +
    `code=${codePrefix(line.code)} ` +
    (line.codeState === null ? "" : `code_state=${line.codeState} `) +
    `outcome=${outcome(line.status, line.error)} ` +
    `client_id=${line.clientId} ` +
    `ua=${userAgent(line.userAgent)} ` +
    `ip=${forwardedFor(line.forwardedFor)}`
  );
}

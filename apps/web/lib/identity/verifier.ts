/**
 * Hop 2: the two server-side calls that bind a tool authorization to the
 * persona this browser is signed in as.
 *
 * `DESIGN.md` → **Two hops, two mechanisms**, and open risk 4. Arcade's default
 * verifier demands an Arcade account that is a project member; our personas are
 * deliberately not members, and with the default route a browser signed into
 * `account.arcade.dev` as somebody else binds the grant to *that* person and
 * the tool re-challenges forever (observed 2026-09-11 15:40Z). A custom
 * verifier replaces that: Arcade sends the browser to a route we own, we decide
 * who the person is from our own session, and we post that identity back
 * server-side.
 *
 * Two measured facts shape everything here (spike #75):
 *
 * 1. **`confirm_user` must be called with the project API key, in-flow.** Run
 *    by hand it is unreliable — Arcade accepts it only while the flow is still
 *    awaiting verification, and that window is shorter than a human's
 *    turnaround. Measured: the same call succeeded once at ~8 minutes and
 *    returned a bare `{"code":400,"msg":"Bad request"}` the next time, for a
 *    flow Arcade still recognised.
 * 2. **Arcade does not finalise the grant until something fetches `next_uri`.**
 *    A `confirm_user` that returned 200 with `{auth_id, next_uri}` left the tool
 *    unauthorized because the browser had given up and nothing landed there. So
 *    this module fetches it **server-side** and then sends the browser on; a
 *    verifier that returns the redirect and trusts the browser to follow it is
 *    correct for a browser and wrong for everything else.
 *
 * And one measured on #100, which is the other half of that same sentence:
 *
 * 3. **`next_uri` is fetched exactly once, and the browser is never one of the
 *    two.** The server fetch runs the authorization-code exchange at `cg-idp`;
 *    a browser sent to the same URL runs it again, and Better Auth's token
 *    endpoint does not merely refuse the replay — it revokes the tokens the
 *    first exchange minted. The visible symptom is three layers away: `get_loan`
 *    fails at `userinfo` with "The identity provider rejected the token."
 *
 * #100 answered "then where does the browser go?" with *the continuation Arcade
 * handed the server fetch, and a local page when there is none*. #118 replaces
 * that with **the local page, always** — decided by the human at the #100 merge
 * gate, 2026-09-14. The grant is finalised by the server fetch either way
 * (measured, #75); Arcade's continuation is a screen on Arcade's domain, and
 * sending the browser there ends the demo on somebody else's page with no way
 * back to the chat. So `Location` is read for the log line and for nothing else:
 * this module no longer has a function that turns it into a redirect target,
 * because there is no longer a caller that would use one.
 */

import { createHash } from "node:crypto";

/** What `confirm_user` answers with on success. */
export interface ConfirmResponse {
  auth_id?: string;
  next_uri?: string;
  [key: string]: unknown;
}

export type ConfirmResult =
  | { ok: true; response: ConfirmResponse }
  | { ok: false; status: number; body: string };

/** `https://cloud.arcade.dev/api/v1/oauth/confirm_user`, measured on #75. */
export function confirmUserUrl(cloudUrl: string): string {
  return `${cloudUrl}/api/v1/oauth/confirm_user`;
}

/**
 * Tell Arcade who this flow belongs to.
 *
 * `user_id` is the session's email, lowercase, and it comes from the sealed
 * cookie — never from the request. Arcade sends a verifier **exactly one**
 * parameter, `flow_id` (measured: no user hint, no provider, no return URL), so
 * there is nothing on the query string that could be identity even if this
 * route were willing to read it.
 */
export async function confirmUser(options: {
  cloudUrl: string;
  apiKey: string;
  flowId: string;
  email: string;
}): Promise<ConfirmResult> {
  const response = await fetch(confirmUserUrl(options.cloudUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ flow_id: options.flowId, user_id: options.email.toLowerCase() }),
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, body };

  let parsed: ConfirmResponse;
  try {
    parsed = JSON.parse(body) as ConfirmResponse;
  } catch {
    return { ok: false, status: response.status, body };
  }
  // A 200 carrying `user_mismatch` is a refusal wearing a success status: the
  // grant is bound to somebody else and every later call re-challenges. Treat
  // it as the failure it is, and show its own words.
  if (typeof parsed.user_mismatch === "boolean" ? parsed.user_mismatch : parsed.error === "user_mismatch") {
    return { ok: false, status: response.status, body };
  }
  return { ok: true, response: parsed };
}

/**
 * Fetch `next_uri` so Arcade finalises the grant, and report what it answered.
 *
 * Landing on this URL is what finalises the grant (measured, #75), and it must
 * happen exactly once — the second landing revokes what the first one minted
 * (#100). `redirect: "manual"` is what holds that line: following the `Location`
 * here would run the browser's half of the flow on the server and spend the
 * single-use code a second time.
 *
 * The `location` that comes back is **diagnostic only**. Since #118 nothing
 * sends a browser there; it exists so the log line can say where Arcade's
 * continuation pointed, which is the one thing that was invisible while #100
 * was being chased.
 */
export async function followNextUri(nextUri: string): Promise<{ status: number; location: string | null }> {
  const response = await fetch(nextUri, { redirect: "manual" });
  // The body is drained rather than left dangling, so the connection is not
  // held open by a response nobody read.
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, location: response.headers.get("location") };
}

/**
 * A URL reduced to what is safe to write into a log: origin, path, and the
 * *names* of its query parameters.
 *
 * Arcade's continuation carries the authorization leg's query string, and on
 * some legs that includes a `code`. A log line is read by people and shipped to
 * Render; the shape is the diagnosis and the values are credentials.
 */
export function loggable(value: string | null): string {
  if (!value) return "(none)";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "(unparseable)";
  }
  const names = [...new Set([...url.searchParams.keys()])]
    .map((name) => name.replace(/[^A-Za-z0-9_.~-]/g, "?").slice(0, 64))
    .filter((name) => name.length > 0);
  // The continuation is supplied by Arcade, but it is still input to this
  // service. Keep the diagnostic line bounded and strip control characters so
  // a hostile Location cannot become a second log line. Values never appear.
  const safe = (part: string) => part.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 160);
  return `${safe(url.origin)}${safe(url.pathname)}${names.length > 0 ? `?${names.map((name) => `${name}=…`).join("&")}` : ""}`.slice(0, 400);
}

/**
 * A stable, non-secret reference for one persona. The email is normalised
 * before hashing so the same person joins across the verifier and a later
 * tool-call observation without putting the address in a production log.
 */
export function identityReference(email: string): string {
  return `id_${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** A stable, bounded reference for Arcade's flow id. */
export function flowReference(flowId: string): string {
  return `flow_${createHash("sha256").update(flowId).digest("hex").slice(0, 16)}`;
}

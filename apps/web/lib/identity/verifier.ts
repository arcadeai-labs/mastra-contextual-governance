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
 *    fails at `userinfo` with "The identity provider rejected the token." So the
 *    browser is sent to the **continuation** the server fetch was handed, and to
 *    a local page when there is none.
 */

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
 * Fetch `next_uri` so Arcade finalises the grant, and report where it points
 * the browser next.
 *
 * `redirect: "manual"` because following it here would run the browser's half
 * of the flow on the server, and because the `Location` is the thing the caller
 * needs: it is where the browser goes instead of back here. Landing on this URL
 * is what finalises the grant, and it must happen once — see `continuationOf`.
 */
export async function followNextUri(nextUri: string): Promise<{ status: number; location: string | null }> {
  const response = await fetch(nextUri, { redirect: "manual" });
  // The body is drained rather than left dangling, so the connection is not
  // held open by a response nobody read.
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, location: response.headers.get("location") };
}

/**
 * Where the browser goes once `followNextUri` has already been there.
 *
 * `null` means "nowhere it can be sent" and the caller renders a local page.
 * Three things are refused, each because sending a browser there is a fault:
 *
 * - **No `Location`.** The continuation ended at `next_uri`; there is nothing
 *   further to walk.
 * - **A `Location` that resolves back to `next_uri`.** Following it would be the
 *   second exchange of a single-use code, which is #100: Better Auth's token
 *   endpoint answers `invalid_grant "invalid code"` *and* revokes the tokens the
 *   first exchange minted (`checkVerificationValue` →
 *   `revokeTokensIssuedForAuthorizationCode`). The grant is destroyed, not just
 *   unfinished, and the tool then fails at `userinfo` with no log line here.
 * - **A scheme that is not `http`/`https`.** The value comes off another
 *   service's response header and ends up in a `Location` this server writes;
 *   `javascript:` and `data:` are not somewhere a browser is sent.
 */
export function continuationOf(nextUri: string, location: string | null): string | null {
  if (!location) return null;

  let resolved: URL;
  try {
    resolved = new URL(location, nextUri);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;

  let target: URL;
  try {
    target = new URL(nextUri);
  } catch {
    return null;
  }
  if (resolved.href === target.href) return null;

  return resolved.href;
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
  const names = [...new Set([...url.searchParams.keys()])];
  return `${url.origin}${url.pathname}${names.length > 0 ? `?${names.map((name) => `${name}=…`).join("&")}` : ""}`;
}

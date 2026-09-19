/**
 * The one tool failure this screen can name a cause and a recovery for: the
 * grant Arcade holds is no longer valid at `apps/idp`.
 *
 * ## Why this exists, and why it is not a re-authorization card
 *
 * A reset of the IdP deletes `oauthAccessToken` and `oauthRefreshToken`, and
 * Arcade goes on holding the hop-2 token it was issued before. The next tool
 * call presents a token cg-idp has forgotten. Measured on #123, against the
 * real `apps/idp` and the real `apps/loan-app`:
 *
 *     GET {idp}/oauth2/userinfo   401
 *       www-authenticate: Bearer error="invalid_token", …
 *     GET {loan-app}/loans/LN-2291   401 {"error":"The identity provider rejected the token."}
 *     ToolExecutionError  kind=TOOL_RUNTIME_FATAL  status_code=None  extra=None
 *                         can_retry=False  message='The identity provider rejected the token.'
 *
 * So by the time it reaches `run.ts` the OAuth `invalid_token` is gone and
 * what is left is a sentence. It is correctly classified as a `fault` — no
 * hook ran, nothing was decided — and `authorizationRequired` correctly
 * returns `null`, because there is no `authorization_url` anywhere in it.
 *
 * **The recovery cannot be performed from this screen.** Arcade evaluated the
 * auth requirement before `/pre`, decided it was met, and dispatched the tool;
 * from its side the tool simply failed, so it raises no challenge however many
 * times the call is retried (#75 measured the same thing from the other
 * direction). Clearing it is a revoke in the Arcade dashboard, by hand. A card
 * that offered an authorize link here would be offering a link nothing can
 * produce — the control that looks like it works and does nothing, which is
 * the failure this project is organised against.
 *
 * What this module does instead is make the failure *honest*: name the cause,
 * name the manual step, and say what the retry that is about to be attempted
 * will do. That is the whole of it.
 *
 * ## Why matching on the sentence is safe here
 *
 * `apps/loan-app/src/actor.ts` is the only thing in the system that writes
 * this string, and since #123 it writes it only when the provider answered
 * **401 or 403** — a refusal of the bearer. A 429 or a 5xx from the provider
 * now gets its own wording there, so the noisiest false positive is gone: a
 * rate-refused rehearsal no longer reads as a dead grant, and nobody is sent
 * to a dashboard to fix a minute that was going to pass on its own.
 *
 * Every other cause of the same 401 — the persona signed out, an admin
 * revoked the grant, the token simply expired — has the identical recovery, so
 * naming it "the grant is no longer valid" is accurate for all of them and
 * over-specific for none.
 */

/**
 * The sentence `apps/loan-app` returns when `/oauth2/userinfo` refuses the
 * bearer. Arcade wraps it (`[TOOL_RUNTIME_FATAL] ToolExecutionError during
 * execution of tool 'get_loan': …`), so callers look for it inside the text
 * rather than at the start of it.
 */
export const STALE_GRANT_SIGNATURE = "The identity provider rejected the token.";

export interface StaleGrant {
  /** What actually happened, in one sentence. */
  cause: string;
  /** The step a human has to take. Named exactly, or not offered at all. */
  recovery: string;
  /** What is known about side effects — here, that there are none. */
  effect: string;
}

/**
 * The stale-grant explanation for a fault's text, or `null`.
 *
 * `null` is the common answer and the safe one: an unrecognised fault keeps
 * the generic wording, which claims nothing it cannot support.
 */
export function staleGrant(message: string): StaleGrant | null {
  if (!message.includes(STALE_GRANT_SIGNATURE)) return null;
  return {
    cause:
      "The identity provider no longer recognises the token Arcade holds for this persona — " +
      "most often because the identity provider was reset, or the grant was revoked.",
    recovery:
      "Arcade still believes that grant is live, so it will not ask for a new one and retrying " +
      "fails the same way. Revoke the cg-idp authorization for this user in the Arcade " +
      "dashboard, then run the step again and authorize when prompted.",
    // Worth saying, because the generic fault line cannot: `apps/loan-app`
    // resolves the caller before it touches the loan book, so a refusal here
    // is a call that never got as far as reading or writing anything.
    effect: "Nothing was read from or written to the loan book: the call was refused before it was attributed to anyone.",
  };
}

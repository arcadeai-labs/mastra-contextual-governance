/**
 * Telling a replayed authorization code from one this service never issued.
 *
 * Better Auth answers both with the same four words. `checkVerificationValue`
 * (`@better-auth/oauth-provider`) hashes the presented code, asks the adapter to
 * consume a `verification` row under that identifier, and when there is none
 * throws `invalid_grant "invalid code"` — whether the code was redeemed a
 * moment ago or was never a code at all. Those are entirely different faults:
 *
 * - **already consumed** is a client that exchanged the same code twice, and it
 *   is expensive rather than merely wrong. Before throwing, the plugin calls
 *   `revokeTokensIssuedForAuthorizationCode`, which deletes the access and
 *   refresh tokens the *first*, successful exchange minted. The grant the
 *   relying party is holding stops working, and the symptom appears somewhere
 *   else entirely — for this demo, `apps/loan-app` getting a 401 from
 *   `/oauth2/userinfo` and reporting "The identity provider rejected the token."
 *   That is #100, and it cost three sittings precisely because the log said
 *   `invalid_grant "invalid code"` and nothing about which of the two it was.
 * - **unknown** is a code that expired, a code from another deployment, or a
 *   caller guessing. Nothing of ours is destroyed by it.
 *
 * The distinction is not on the wire, so it is read from the database, and it
 * has to be read **before** the request is forwarded — the revocation the replay
 * triggers is what erases the evidence.
 */
import type { Database } from "bun:sqlite";

/**
 * What the plugin stores as `authorizationCodeId`: the code, SHA-256, base64url
 * without padding.
 *
 * This is `defaultHasher` in `@better-auth/oauth-provider` (`utils`,
 * `storeToken(storeTokens, code, "authorization_code")`), reproduced rather than
 * imported because it is not exported. `src/auth.ts` leaves `storeTokens` at its
 * default, which is `"hashed"`; a configuration that set a custom hasher would
 * make this lookup silently find nothing, which is why the test that covers this
 * drives a real code through a real token endpoint rather than asserting on the
 * hash.
 */
export async function authorizationCodeId(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Buffer.from(digest).toString("base64url");
}

/**
 * Whether anything was ever minted against this authorization code.
 *
 * `already_consumed` means a successful exchange of this code left a token row
 * behind — so a rejection now is a replay, and the revocation has just taken
 * that first exchange's tokens with it.
 *
 * `unknown` is the honest name for the rest. It is not "expired": a code whose
 * tokens have since been revoked or rotated away also lands here, because the
 * rows this reads are gone by then. Saying "expired" would be a guess wearing a
 * fact's clothes, and this file exists because of a log line that did that.
 */
export type CodeState = "already_consumed" | "unknown";

export function codeState(db: Database, codeId: string): CodeState {
  for (const table of ["oauthAccessToken", "oauthRefreshToken"]) {
    const row = db
      .query(`select 1 from "${table}" where "authorizationCodeId" = ? limit 1`)
      .get(codeId);
    if (row) return "already_consumed";
  }
  return "unknown";
}

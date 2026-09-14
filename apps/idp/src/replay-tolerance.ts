/**
 * Making a replayed authorization code refuse without destroying anything.
 *
 * `@better-auth/oauth-provider`'s `checkVerificationValue` consumes the
 * `verification` row for the presented code and, when there is none, does two
 * things before it throws `invalid_grant "invalid code"`:
 *
 * ```js
 * const verification = await ctx.context.internalAdapter.consumeVerificationValue(authorizationCodeId);
 * if (!verification) {
 *   await revokeTokensIssuedForAuthorizationCode(ctx, authorizationCodeId);   // ← this
 *   throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "invalid code" });
 * }
 * ```
 * (`dist/introspect-C6P1zrTr.mjs:1893..1900`, plugin 1.7.2.)
 *
 * The refusal is correct and stays. The revocation is what turned #100 from a
 * harmless duplicate into a dead grant: `revokeTokensIssuedForAuthorizationCode`
 * deletes every `oauthAccessToken` and `oauthRefreshToken` row carrying that
 * `authorizationCodeId` — the tokens the *first*, successful exchange minted and
 * handed to the relying party. Arcade keeps holding them, `/oauth2/userinfo`
 * answers 401, and `apps/loan-app` reports "The identity provider rejected the
 * token." from a request nobody made twice on purpose.
 *
 * **Measured on Render, 2026-09-14.** cg-web fetched `next_uri` exactly once
 * (`21:05:28.094Z [verifier] next_uri answered 200, location (none)`) and cg-idp
 * rejected a second `authorization_code` exchange 290 ms later
 * (`21:05:28.383Z … code=already_consumed`). The second hit is Arcade's, not the
 * browser's and not cg-web's. The standing decision of 2026-09-11 is that the
 * Arcade provider configuration is never edited and **the IdP adapts**, so the
 * duplicate has to stop being expensive here.
 *
 * **This is a deliberate deviation from RFC 6749 §4.1.2**, which says an
 * authorization server SHOULD revoke the tokens previously issued for a code it
 * sees replayed. That advice assumes a replay is evidence of a leaked code. Here
 * the replay is a measured property of one relying party, arriving on the same
 * connection, with the same client credentials, milliseconds after a legitimate
 * exchange — and honouring the SHOULD makes the demo's happy path fail. The
 * refusal is unchanged; only the collateral is dropped.
 *
 * **The narrowest hook there is.** The plugin exposes no option for this: its
 * `OAuthOptions` has no revocation or replay setting, and the call site is
 * unconditional. What it does do is reach the database through
 * `ctx.context.adapter`, so the interception happens one layer below, on the
 * single `deleteMany` shape that is uniquely this path — see `isReplayRevocation`.
 * Nothing in `node_modules` is patched and no adapter is reimplemented.
 */
import type { Auth } from "./auth.ts";

/** The two models whose rows a replay would delete. */
const ISSUED_TOKEN_MODELS = new Set(["oauthAccessToken", "oauthRefreshToken"]);

/** One clause of an adapter `where`, in the shape `@better-auth/core` passes. */
interface WhereClause {
  field: string;
  value?: unknown;
  operator?: string;
  connector?: string;
}

/**
 * Whether one `deleteMany` is the replay revocation and nothing else.
 *
 * Deliberately exact rather than broad. Across plugin 1.7.2 there are four
 * `deleteMany` calls on these models — three key on `clientId`+`userId` or on
 * `refreshId` (`invalidateRefreshTokenFamily`, refresh rotation, `/oauth2/revoke`)
 * and are real revocations a user or client asked for. Only
 * `revokeTokensIssuedForAuthorizationCode` deletes by a lone `authorizationCodeId`
 * equality, so that is the whole predicate: right model, exactly one clause, that
 * field, a plain equality.
 *
 * A broader guard — "never delete an access token" — would swallow sign-out and
 * `/oauth2/revoke` too, and a token that cannot be revoked is a worse bug than
 * the one being fixed. If a future version of the plugin routes a genuine
 * revocation through this shape, the live test in `flow.test.ts` that replays a
 * real code and then calls `/oauth2/userinfo` is what notices.
 */
export function isReplayRevocation(model: string, where: readonly WhereClause[]): boolean {
  if (!ISSUED_TOKEN_MODELS.has(model)) return false;
  if (where.length !== 1) return false;
  const [clause] = where;
  if (!clause || clause.field !== "authorizationCodeId") return false;
  // `undefined` is the adapter's default, which is equality.
  return clause.operator === undefined || clause.operator === "eq";
}

/**
 * Installs the guard on a live Better Auth instance.
 *
 * `auth.$context` resolves to the one context object every endpoint reads
 * `ctx.context.adapter` from — the same object on every await, so replacing the
 * method once at boot covers every later request. Awaited at startup rather than
 * lazily, so a failure here stops the service instead of arriving as an
 * intermittent revocation.
 *
 * `onBlocked` is called with the model each time a revocation is refused.
 * A guard that silently did nothing would be indistinguishable from one that
 * never matched, which is the exact failure this project keeps out of its
 * controls — so the caller logs it and a test asserts the line.
 */
export async function tolerateAuthorizationCodeReplay(
  auth: Auth,
  onBlocked: (model: string) => void,
): Promise<void> {
  const context = await auth.$context;
  const adapter = context.adapter;
  const deleteMany = adapter.deleteMany.bind(adapter);

  adapter.deleteMany = async (params: { model: string; where: readonly WhereClause[] }) => {
    if (isReplayRevocation(params.model, params.where ?? [])) {
      onBlocked(params.model);
      // What `deleteMany` returns on a no-op: the plugin ignores the value and
      // throws `invalid_grant` either way, so the caller sees the refusal it
      // expects and the rows stay.
      return 0;
    }
    return deleteMany(params as Parameters<typeof deleteMany>[0]);
  };
}

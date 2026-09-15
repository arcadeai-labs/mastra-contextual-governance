/**
 * Which persona the page is acting as.
 *
 * The persona switcher stands in for real login, exactly as `DESIGN.md` says:
 * every persona is a real Arcade account with a real email, and the switcher
 * chooses which of them a tool call is made under. It is a demo fixture, and
 * the seam a forker replaces with their own session — the rest of the page
 * only ever sees a `user_id`.
 *
 * What it deliberately is *not* is a permission. Choosing "Alice" and pressing
 * Approve is not an escalation, it is the whole point: the pre-hook refuses
 * her, visibly, and the audit row names her. If switching persona could be
 * used to grant yourself something, the demo would be arguing the opposite of
 * its own thesis.
 */
export const PERSONA_COOKIE = "cg_persona";

/**
 * The persona to act as: the chosen one when the roster knows it, and the
 * routed approver otherwise.
 *
 * Defaulting to the approver is what makes the link work the way the demo
 * needs it to — Charlie opens it from Slack and presses Approve — without the
 * default being authority. A cookie naming somebody the control plane has
 * never heard of is ignored rather than trusted; an unknown subject fails
 * closed at `/pre` anyway, but a page that offered to act as them would be
 * inviting a confusing beat rather than a clear one.
 */
export function choosePersona(
  chosen: string | undefined,
  roster: ReadonlyArray<{ user_id: string }>,
  routedApprover: string,
): string {
  if (chosen === undefined) return routedApprover;
  const known = roster.some((p) => p.user_id.toLowerCase() === chosen.trim().toLowerCase());
  return known ? chosen.trim() : routedApprover;
}

import { staleGrant } from "../../lib/agent/stale-grant.ts";

/**
 * What a fault means and what to do about it — the closing lines of the grey
 * plumbing card in `Chat.tsx`, and the only part of it with anything to
 * decide.
 *
 * Its own file so it can be rendered on its own: `Chat` needs a live DOM and
 * a stream before it will say anything, and this claim is about markup.
 *
 * The default says as little as it can honestly say: the outcome is
 * incomplete and side effects are unknown. One failure is better understood
 * than that — the grant Arcade holds has gone stale (#123) — and for it the
 * card names the cause, the manual recovery and the fact that nothing reached
 * the loan book. Everything else keeps the generic wording, because a card
 * that guessed a cause would be the same mislabelling one register down.
 *
 * Still grey, still inside the fault card, still `data-kind="fault"`. This is
 * a better-described plumbing failure, not a new kind of event, and above all
 * not an authorization card: there is no link to offer, and #123 measured why.
 */
export function FaultConsequence({ message }: { message: string }) {
  const stale = staleGrant(message);
  if (stale === null) {
    return (
      <p style={{ margin: 0, color: "var(--muted)" }}>
        The tool outcome is incomplete. Any side effects are unknown; use the detail above to
        determine the next step.
      </p>
    );
  }
  return (
    <div style={{ color: "var(--muted)" }} data-fault-cause="stale-grant">
      <p style={{ margin: "0 0 0.4em" }}>{stale.cause}</p>
      <p style={{ margin: "0 0 0.4em" }}>{stale.recovery}</p>
      <p style={{ margin: 0 }}>{stale.effect}</p>
    </div>
  );
}

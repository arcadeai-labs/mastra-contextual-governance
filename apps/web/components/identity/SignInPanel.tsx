/**
 * "Sign in as …" — what the persona switcher becomes once `apps/web` has a real
 * identity.
 *
 * `DESIGN.md` → **Identity**: the switcher stops being a dropdown that picks a
 * label and becomes a sign-in against `apps/idp` under client C. Each button
 * starts an OIDC authorization and lands the browser on **cg-idp's** login page;
 * the persona who comes back is whoever typed a password there, not whichever
 * button was pressed.
 *
 * Deliberately minimal. The human's stated demo shape is one Chrome profile per
 * persona, so switching is rare and this panel is mostly a way in — the four
 * buttons matter less than the two facts underneath them: the email on screen
 * is the one the IdP asserted, and the gateway token beside it belongs to that
 * person.
 *
 * No client JavaScript. Four links and one form, so the whole thing works
 * before hydration and there is no state here that could disagree with the
 * cookie.
 */
import { PERSONAS } from "../../lib/identity/personas.ts";
import { SIGNIN_PATH, SIGNOUT_PATH, GATEWAY_START_PATH } from "../../lib/identity/handlers.ts";
import { isMisconfigured, type ConfigurationProblems } from "../../lib/config.ts";
import type { Session } from "../../lib/identity/session.ts";

export interface SignInPanelProps {
  session: Session | null;
  problems: ConfigurationProblems;
}

const card: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "6px",
  padding: "1.25rem",
  marginTop: "2rem",
};

const button: React.CSSProperties = {
  display: "inline-block",
  border: "1px solid var(--line)",
  borderRadius: "4px",
  padding: "0.5rem 0.85rem",
  fontSize: "0.875rem",
  textDecoration: "none",
  color: "inherit",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
};

/**
 * Red, at the top, and impossible to walk past.
 *
 * Round 2 of #84's review ran a cg-web with sign-in configured and
 * `ARCADE_GATEWAY_ID` absent: `/health` said `ok`, and `GET /` rendered the
 * ordinary persona buttons and `Gateway token: none` with no warning at all.
 * The only way to find out was to click into a flow and read a 503 — so the
 * misconfiguration was discoverable exactly when it was most expensive, which
 * on this project means on stage.
 *
 * The sentences are the ones `lib/config.ts` already produces for the 503 pages
 * and counts for `/health`. One source, three surfaces, so nothing here can
 * describe a different deployment from the one the routes refuse for. #14 added
 * the fourth heading on the same argument: an `ANTHROPIC_API_KEY` nobody set is
 * discovered when somebody presses Send.
 */
const BANNER_HEADINGS: ReadonlyArray<readonly [keyof ConfigurationProblems, string]> = [
  ["signin", "Signing in is not configured"],
  ["gateway", "The gateway hop is not configured"],
  ["verifier", "The custom verifier is not configured"],
  ["agent", "The agent is not configured"],
] as const;

export function ConfigurationBanner({ problems }: { problems: ConfigurationProblems }) {
  if (!isMisconfigured(problems)) return null;

  return (
    <section
      role="alert"
      style={{
        border: "2px solid #b3261e",
        borderLeftWidth: "8px",
        borderRadius: "6px",
        background: "#fdecea",
        color: "#5f1412",
        padding: "1rem 1.25rem",
        marginTop: "2rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>This deployment is not fully configured</h2>
      <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem" }}>
        Some of it will work and some of it will fail at the point of use. <code>GET /health</code>{" "}
        answers <code>&quot;status&quot;: &quot;degraded&quot;</code> and names the same
        capabilities; <code>apps/web/README.md</code> says where each value comes from.
      </p>
      {BANNER_HEADINGS.map(([key, heading]) =>
        problems[key].length === 0 ? null : (
          <div key={key} style={{ marginTop: "0.5rem" }}>
            <strong style={{ fontSize: "0.875rem" }}>{heading}</strong>
            <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
              {problems[key].map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}

export function SignInPanel({ session, problems }: SignInPanelProps) {
  // A button that cannot work is rendered inert rather than hidden. Hiding it
  // would leave a visitor wondering whether the demo has personas at all;
  // disabling it says "this exists, and this deployment cannot do it yet" —
  // which is what the banner above then explains.
  const signinBroken = problems.signin.length > 0;

  return (
    <>
      <ConfigurationBanner problems={problems} />

      <section style={card}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Sign in as …</h2>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {PERSONAS.map((persona) =>
            signinBroken ? (
              <button
                key={persona.key}
                type="button"
                disabled
                title="Sign-in is not configured on this deployment"
                style={{ ...button, cursor: "not-allowed", opacity: 0.5 }}
              >
                {persona.name}
                <span style={{ color: "var(--muted)" }}> — {persona.role}</span>
              </button>
            ) : (
              <a key={persona.key} href={`${SIGNIN_PATH}?persona=${persona.key}`} style={button}>
                {persona.name}
                <span style={{ color: "var(--muted)" }}> — {persona.role}</span>
              </a>
            ),
          )}
        </div>

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "0.25rem 1rem",
            margin: "1.25rem 0 0",
            fontSize: "0.875rem",
          }}
        >
          <dt style={{ color: "var(--muted)" }}>Signed in as</dt>
          <dd style={{ margin: 0 }}>
            {/* The email the IdP asserted, lowercase — the same string Arcade
                receives as `user_id` and the loan book records as the actor. */}
            {session ? <code>{session.email}</code> : <span style={{ color: "var(--muted)" }}>nobody</span>}
          </dd>

          <dt style={{ color: "var(--muted)" }}>Gateway token</dt>
          <dd style={{ margin: 0 }}>
            {/* Never the token, and never a prefix of it. Whether one is held and
                when it expires is everything anyone needs to see; the value is a
                bearer for the whole gateway.

                Three states, not two (#94). "none" and "rejected" are the same
                absence and a different problem: the first is a hop nobody has
                run, the second is a hop that ran and whose result the gateway
                has since refused. Live on 2026-09-14 they were one word, and the
                person reading it went looking for a missing toolkit. */}
            {session?.gateway ? (
              <>held, expires {new Date(session.gateway.expires_at).toISOString()}</>
            ) : session?.gateway_rejected_at ? (
              <span style={{ color: "#8a6100" }}>
                rejected at {new Date(session.gateway_rejected_at).toISOString()} — authorize again
              </span>
            ) : (
              <span style={{ color: "var(--muted)" }}>none</span>
            )}
          </dd>
        </dl>

        {session ? (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center" }}>
            {session.gateway ? null : (
              <a href={GATEWAY_START_PATH} style={button}>
                Authorize the gateway
              </a>
            )}
            <form action={SIGNOUT_PATH} method="post" style={{ margin: 0 }}>
              <button type="submit" style={button}>
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </section>
    </>
  );
}

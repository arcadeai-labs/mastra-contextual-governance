/**
 * The session controls in the bank's top chrome: the gateway token, and the one
 * button that changes who this browser is.
 *
 * ## What this replaced, and why
 *
 * Until #176 this file was `SignInPanel.tsx` and drew four "Sign in as …"
 * buttons in a card below the loan files. `DESIGN.md` → Identity already
 * recorded the shape that made them weak — *"on stage each persona runs in its
 * own Chrome profile, so switching is rare"* — and the human, looking at `/` on
 * 2026-09-19, named the consequence: on a screen whose whole argument is that
 * nothing here is a mock, a row of persona buttons is the most demo-looking
 * thing on it. One Chrome profile per persona is the real demo shape, so the
 * switcher went and what is left is what a real application's chrome carries.
 *
 * Nothing about the *route* changed. `SIGNIN_PATH` is the same OIDC
 * authorization against `apps/idp` under client C; it simply no longer carries
 * a `?persona=` hint, which was only ever a label for the page it came back to.
 * The person who returns is whoever typed a password at cg-idp — which was
 * already true when there were four buttons, and is the reason the buttons were
 * never an identity.
 *
 * ## The gateway token row is not decoration
 *
 * It stays because the human reads it during rehearsals to answer *"is my hop-1
 * token still good"*, and because `DESIGN.md` records that hop 2's token is
 * `expires_in` 3600 with no refresh — a rehearsal longer than an hour costs an
 * authorization card per persona whatever else happens. Three states, not two
 * (#94): `none` is a hop nobody has run and `rejected` is a hop that ran and
 * whose result the gateway has since refused, and collapsing them once sent a
 * person looking for a missing toolkit.
 *
 * Never the token, and never a prefix of it. Whether one is held and when it
 * expires is everything anybody needs to see; the value is a bearer for the
 * whole gateway.
 *
 * ## No client JavaScript
 *
 * One link and one form, so the whole thing works before hydration and there is
 * no state here that could disagree with the cookie.
 *
 * The misconfiguration banner is **not** here. It is
 * `components/identity/ConfigurationBanner.tsx`, placed by the pages, and its
 * own file says why.
 */
import { SIGNIN_PATH, SIGNOUT_PATH, GATEWAY_START_PATH } from "../../lib/identity/handlers.ts";
import type { ConfigurationProblems } from "../../lib/config.ts";
import type { Session } from "../../lib/identity/session.ts";

export interface SessionChromeProps {
  session: Session | null;
  problems: ConfigurationProblems;
}

/**
 * Sized off the chrome bar it sits in rather than off the root, so it scales
 * with `.bank`'s `clamp()` the way the label beside it does. Styled inline
 * because `components/bank/bank.css` is the fork seam and this component is not
 * the bank's — the bank restyles it from outside through `--line` and
 * `--muted`, exactly as it does the chat.
 */
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "0.7em",
  flexWrap: "wrap",
  fontSize: "0.78em",
  lineHeight: 1.4,
};

const label: React.CSSProperties = {
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const control: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "2px",
  padding: "0.15em 0.6em",
  fontSize: "inherit",
  font: "inherit",
  textDecoration: "none",
  color: "inherit",
  background: "transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function SessionChrome({ session, problems }: SessionChromeProps) {
  // A control that cannot work is rendered inert rather than hidden. Hiding it
  // would leave a visitor wondering whether this deployment has a sign-in at
  // all; disabling it says "this exists, and this deployment cannot do it yet"
  // — which is what the banner at the top of the page then explains.
  const signinBroken = problems.signin.length > 0;

  return (
    <div style={row} data-session-chrome="">
      <span style={label}>Gateway token</span>
      <span data-gateway-token={session?.gateway ? "held" : session?.gateway_rejected_at ? "rejected" : "none"}>
        {session?.gateway ? (
          <>held, expires {new Date(session.gateway.expires_at).toISOString()}</>
        ) : session?.gateway_rejected_at ? (
          <span style={{ color: "#8a6100" }}>
            rejected at {new Date(session.gateway_rejected_at).toISOString()} — authorize again
          </span>
        ) : (
          <span style={{ color: "var(--muted)" }}>none</span>
        )}
      </span>

      {session ? (
        <>
          {session.gateway ? null : (
            <a href={GATEWAY_START_PATH} style={control}>
              Authorize the gateway
            </a>
          )}
          <form action={SIGNOUT_PATH} method="post" style={{ margin: 0 }}>
            <button type="submit" style={control}>
              Sign out
            </button>
          </form>
        </>
      ) : signinBroken ? (
        <button
          type="button"
          disabled
          title="Sign-in is not configured on this deployment"
          style={{ ...control, cursor: "not-allowed", opacity: 0.5 }}
        >
          Sign in
        </button>
      ) : (
        <a href={SIGNIN_PATH} style={control}>
          Sign in
        </a>
      )}
    </div>
  );
}

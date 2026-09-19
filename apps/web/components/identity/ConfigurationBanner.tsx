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
 *
 * ## Why it has its own file since #176
 *
 * It used to live inside `SignInPanel.tsx` and render above the four "Sign in
 * as …" buttons. #176 deleted the switcher, and the issue is explicit that the
 * banner is **not** part of it: *"whatever happens to the panel, that banner
 * still renders, still red, still at the top, still impossible to walk past. Do
 * not let it leave with the buttons."* A component that outlives the file it
 * was written in is a component that should not have shared one — so the
 * separation is structural rather than a promise, and the banner is now placed
 * by each page that wants it (`app/page.tsx`, `app/chat/page.tsx`) rather than
 * riding in on a panel.
 *
 * On `/` that means above the bank's chrome: `.bank` is `100dvh`, so a banner
 * in front of it is the first thing on the page and pushes the application
 * down. That is the intended cost. It appears only on a deployment that cannot
 * do what it claims, and being annoying there is the entire job.
 */
import { isMisconfigured, type ConfigurationProblems } from "../../lib/config.ts";

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
        margin: "0 0 0.5rem",
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

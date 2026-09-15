/**
 * Same shape as the `/health` endpoints on `hooks` and `loan-app`, so the
 * Render blueprint can point all three services at one path.
 *
 * **Five fields, and they arrived from three different slices.** Each is a
 * thing a human configures by hand, each fails on its own, and each fails at a
 * point where nothing else on screen would say so.
 *
 * Since #82: `signin`, `gateway` and `verifier` — sign-in, the gateway hop and
 * the custom verifier depend on variables set by hand in the Render dashboard
 * and in the Arcade dashboard, and two of the three fail at a step no hook
 * observes, so an unset one is otherwise discovered mid-rehearsal as "the demo
 * does nothing". They say `configured` or `missing` and never which value is
 * wrong, because the value is a credential in two cases out of three.
 *
 * Since #14: `agent`. A cg-web with no `ANTHROPIC_API_KEY` signs Alice in, holds
 * a gateway token and answers the verifier — and then `/chat` answers 503 the
 * first time somebody presses Send.
 *
 * Since #81: `panel_stream` — `live`, `fixture` or `unconfigured`. The odd one
 * out, because it has three answers rather than two: a panel can be watching
 * the live control plane, replaying the fixture on purpose, or watching
 * nothing. Only the last is a fault; `fixture` is a mode somebody chose and the
 * panel says so on screen. It failed quietly for every production deploy
 * between #21 and #81 — the panel replayed a fixture and nothing, here or on
 * screen, said the live control plane was never being watched.
 *
 * It still does not read `APPROVALS_STORE_TOKEN`'s production guard, and it
 * answers `200` whatever it finds — a health check that fails on a
 * misconfiguration would take the service out of rotation instead of telling
 * anyone what to fix, and Render would abandon the deploy before anybody could
 * read this. The refusal lives in the body (`"status":"degraded"`), on the home
 * page, and in the 503 every identity route and the chat route answer.
 * That is what `readIdentitySurface` is for: the same environment, read without
 * the guard that belongs to a credential this endpoint does not use.
 */
import { deploymentReadiness, readIdentitySurface } from "../../lib/config.ts";
import { resetToken } from "../../lib/governance/control-plane.ts";
import { panelStreamHealth } from "../../lib/governance/stream-url.ts";

export const dynamic = "force-dynamic";

export function GET() {
  // `deploymentReadiness` owns the four `configured`/`missing` capabilities and
  // its own roll-up; `panel_stream` is read separately because it is not one of
  // them — see the note above about it having three answers.
  const { status: deployment, ...capabilities } = deploymentReadiness(readIdentitySurface());
  const panel_stream = panelStreamHealth(process.env);

  // `status` first, because it is the field anybody actually reads and the one
  // the other three services answer. `ok` only when every capability is
  // configured *and* the panel is watching something — and still HTTP 200, so
  // Render brings the instance up and a human can read the fields that say
  // which one. #86 and #88 each added a field to this expression; a deployment
  // that satisfies one half and not the other is `degraded`.
  const status = deployment === "ok" && panel_stream !== "unconfigured" ? "ok" : "degraded";

  // Since #106: whether the panel's Reset control is drawn at all. Reported and
  // deliberately NOT folded into `status` — a deployment nobody is presenting
  // from is right to leave `RESET_TOKEN` unset, and calling that degraded would
  // teach a reader to ignore the word. It is here because the alternative is
  // the one thing this project keeps refusing: a control that is absent, and no
  // surface that says so. "The Reset button is missing" then has an answer
  // other than reading the source.
  const reset = resetToken() === "" ? "disabled" : "enabled";

  return Response.json({ status, service: "web", ...capabilities, panel_stream, reset });
}

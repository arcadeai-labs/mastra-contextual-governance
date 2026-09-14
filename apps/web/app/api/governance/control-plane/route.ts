/**
 * The panel's window onto `cg-hooks`, and the only thing that holds
 * `RESET_TOKEN` (#106).
 *
 *     GET   what the control plane says about itself, trimmed to the strip
 *     POST  { mode: "policy" | "demo" }  →  run that reset against cg-hooks
 *
 * A **server** route, and that is the whole design. The Reset button is a
 * presenter's control on a public URL, so the secret authorizing it cannot be
 * in the bundle the audience's laptops also download; the browser posts here
 * with no credential at all and this process presents the bearer.
 *
 * ## What this route does not do
 *
 * It does not authenticate its caller. That is a deliberate limit and worth
 * being plain about: anyone who can load `/panel` on a deployment where
 * `RESET_TOKEN` is set can press this. What the token buys is that the reset
 * cannot be driven from *outside* the deployment — `cg-hooks` is a separate
 * public service, and before this it would have had to be either unauthenticated
 * there or reachable only from a shell. Narrowing it further means a real admin
 * identity, which this demo does not have: no persona is an administrator
 * (DESIGN.md), and inventing one for a button would be inventing an identity
 * the four acts then have to explain. A deployment nobody is presenting from
 * leaves `RESET_TOKEN` unset, and then there is no button and no route that
 * does anything.
 *
 * Both verbs answer **200 with a body that says what happened**, including
 * when the answer is "cg-hooks could not be reached". The panel renders that
 * state; a 500 here would give it an exception to swallow, and a strip that
 * disappears when the control plane does is the failure this surface exists to
 * prevent.
 */
import { readWebConfig } from "../../../../lib/config.ts";
import {
  RESET_MODES,
  readControlPlane,
  resetToken,
  runReset,
  type ResetMode,
} from "../../../../lib/governance/control-plane.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = readWebConfig();
  return Response.json(await readControlPlane(config, { token: resetToken() }));
}

export async function POST(request: Request): Promise<Response> {
  const token = resetToken();
  // Unset here means the control was never rendered, so a POST that arrives
  // anyway is either a stale tab or somebody probing. Same 404 `cg-hooks`
  // gives, for the same reason: an endpoint that is off should not be
  // distinguishable from one that was never built.
  if (token === "") return Response.json({ error: "Not found" }, { status: 404 });

  let mode: unknown = "policy";
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      mode = (JSON.parse(text) as { mode?: unknown }).mode ?? "policy";
    } catch (cause) {
      return Response.json({ error: `body is not JSON: ${String(cause)}` }, { status: 400 });
    }
  }
  if (!RESET_MODES.includes(mode as ResetMode)) {
    return Response.json(
      { error: `mode must be one of ${RESET_MODES.join(", ")}`, got: mode },
      { status: 400 },
    );
  }

  const config = readWebConfig();
  const outcome = await runReset(config, mode as ResetMode, token);
  // The fresh status travels back with the outcome, so the strip updates from
  // the same round trip rather than waiting for the next poll to agree with
  // the sentence it is already showing.
  return Response.json({ ...outcome, report: await readControlPlane(config, { token }) });
}

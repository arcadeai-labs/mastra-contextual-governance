/**
 * Everything `/` asks the gateway for: one `tools/list`, and nothing else.
 *
 * ## What this file used to do, and why it stopped
 *
 * It used to answer two questions on one gateway session — *what may this
 * persona see* (#15's tool list, act 1) and *what do the two applications under
 * review say* (#22's loan files, moved here by #109). The second question is no
 * longer the gateway's: since #157 the bank's own screens read `apps/loan-app`
 * directly as the signed-in person and poll it, so loading `/` makes **one**
 * `tools/list` and **zero** governed tool calls. Every MCP call in the demo now
 * starts in the chat, which is what makes the panel legible: a card on it is
 * something the agent did.
 *
 * `lib/loan-context/loans.ts` carries the argument in full and `DESIGN.md` →
 * Business system records the decision. `test/home-surface.test.ts` asserts the
 * counts off the gateway stand-in's own record rather than describing them.
 *
 * ## What is left
 *
 * A named seam between the page and `lib/agent/tool-list.ts`, which is worth
 * keeping for one reason: the page's cost against the gateway is a number this
 * project has twice got wrong by accident (#109, then #157), and a function
 * whose whole job is "what one page load asks for" is a place to hold a test
 * against it.
 *
 * It does not reseal the session. `sessionTools` may spend a refreshed gateway
 * token, and a server component cannot set a cookie — the route that *can*
 * reseal is `POST /api/chat`, and `lib/agent/tool-list.ts` states the bargain.
 */
import { sessionTools, type SessionTools, type SessionToolsOptions } from "../agent/tool-list.ts";
import type { Session } from "../identity/session.ts";

export interface HomeSurface {
  /** #15's widget, as data. */
  tools: SessionTools;
}

export type HomeSurfaceOptions = SessionToolsOptions;

export async function homeSurface(
  session: Session | null,
  options: HomeSurfaceOptions = {},
): Promise<HomeSurface> {
  return { tools: await sessionTools(session, options) };
}

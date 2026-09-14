/**
 * `/` — the demo.
 *
 * The split screen #22 asks for: the bank's loan origination system on the
 * left, Arcade's control plane on the right. It replaces the #4 scaffold's list
 * of services, which said "every service is a stub that serves a health
 * endpoint" and had not been true for some weeks.
 *
 * A **server** component, and it does exactly two things a client one could not:
 *
 * 1. It unseals the session here, so the gateway tokens in the cookie never
 *    reach the browser. `SignInPanel` is rendered on this side of the boundary
 *    and handed down as an element, so only what it prints crosses.
 * 2. It resolves the panel's stream from the environment at request time.
 *    `next build` inlines `NEXT_PUBLIC_*` into the client bundle while Render
 *    supplies service variables at runtime, so a public variable would be
 *    `undefined` in the deployed browser and perfectly fine under `next dev` —
 *    see `lib/governance/stream-url.ts`.
 */
import { cookies } from "next/headers";

import { configurationProblems, readIdentitySurface } from "../lib/config.ts";
import { readSessionFromCookies } from "../lib/identity/session.ts";
import { resolvePanelStream } from "../lib/governance/stream-url.ts";
import { SignInPanel } from "../components/identity/SignInPanel.tsx";
import { SplitScreen } from "../components/shell/SplitScreen.tsx";

/**
 * Dynamic, because it reads a session cookie and the environment. Saying so
 * explicitly rather than relying on `cookies()` to infer it keeps `next build`
 * from evaluating this component at all — a prerender of a page about who is
 * signed in is either wrong or empty, and it runs under `NODE_ENV=production`
 * with none of the deployment's environment.
 */
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  // `?fixture=1` and the replay's tuning parameters work here exactly as they do
  // on `/panel`, which is what lets the whole screen be rehearsed with no
  // control plane running. The badge on the panel says which it is, always.
  const stream = resolvePanelStream(process.env, await searchParams);

  return (
    <SplitScreen
      stream={stream}
      signedInAs={session?.email ?? null}
      identity={<SignInPanel session={session} problems={configurationProblems(config)} />}
    />
  );
}

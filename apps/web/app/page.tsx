/**
 * `/` — the demo.
 *
 * The split screen #22 asks for: the bank's loan origination system on the
 * left, Arcade's control plane on the right. It replaces the #4 scaffold's list
 * of services, which said "every service is a stub that serves a health
 * endpoint" and had not been true for some weeks.
 *
 * A **server** component, and it does three things a client one could not:
 *
 * 1. It unseals the session here, so the gateway tokens in the cookie never
 *    reach the browser. `SignInPanel` is rendered on this side of the boundary
 *    and handed down as an element, so only what it prints crosses.
 * 2. It opens **one** gateway session and asks it everything this screen needs:
 *    one real `tools/list` with the session's bearer (#15,
 *    `lib/agent/tool-list.ts`), and, on that same listing, the two governed
 *    `Loan_GetLoan` reads the left column shows (#22). Both answers are handed
 *    down as data. They belong on the server for the same reason: the bearer
 *    never leaves this process.
 *
 *    They are one session because of #109. The loan files used to be fetched
 *    from the browser, from `GET /api/loan-context`, which had to list the
 *    gateway's tools again to find `Loan_GetLoan` — so a page load cost two
 *    `tools/list` calls and, against the real gateway, twice the `/access`
 *    fan-out. That route is gone. `test/home-surface.test.ts` asserts the count.
 * 3. It resolves the panel's stream from the environment at request time.
 *    `next build` inlines `NEXT_PUBLIC_*` into the client bundle while Render
 *    supplies service variables at runtime, so a public variable would be
 *    `undefined` in the deployed browser and perfectly fine under `next dev` —
 *    see `lib/governance/stream-url.ts`.
 *
 * ## Where #15's widget sits
 *
 * In the shell's tool-list slot, which is what that slot was cut for. #15's
 * `PersonaToolList` says so from its own side — *"#22 owns the split-screen
 * shell and hosts this widget inside it, so everything this component needs
 * arrives as data"* — and this is the line where the two halves of that
 * sentence meet. Act 1 is an absence: as Bob, `Loan_ApproveLoan` is missing
 * from a list the **gateway** answered, not struck through by anything here.
 */
import { cookies } from "next/headers";

import { configurationProblems, readIdentitySurface } from "../lib/config.ts";
import { readSessionFromCookies } from "../lib/identity/session.ts";
import { resolvePanelStream } from "../lib/governance/stream-url.ts";
import { homeSurface } from "../lib/home/surface.ts";
import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
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
  // No session means no network call: `homeSurface` answers without asking, on
  // both halves at once.
  const { tools, files } = await homeSurface(session, { config });
  // `?fixture=1` and the replay's tuning parameters work here exactly as they do
  // on `/panel`, which is what lets the whole screen be rehearsed with no
  // control plane running. The badge on the panel says which it is, always.
  const stream = resolvePanelStream(process.env, await searchParams);

  return (
    <SplitScreen
      stream={stream}
      signedInAs={session?.email ?? null}
      identity={<SignInPanel session={session} problems={configurationProblems(config)} />}
      loanFiles={files}
      toolList={<PersonaToolList session={session} tools={tools} />}
    />
  );
}

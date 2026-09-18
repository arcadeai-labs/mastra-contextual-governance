/**
 * `/` — the bank's loan origination system, full-screen.
 *
 * **No split view (#155, reversing #22).** Until the 2026-09-18 rehearsal this
 * page was two halves: the bank on the left, the control plane on the right.
 * Every action on the left moved the right at the same moment, so the audience
 * watched two surfaces animate while the presenter explained a third. The
 * control plane now lives on its own full-screen page at `/panel`, and the
 * presenter switches between the two deliberately. `DESIGN.md` → Decisions →
 * Design.
 *
 * What went with the split: the `correlationKey` join. #6's token still rides
 * in every denial's text and the panel still outlines what it is given — but
 * nothing on this page hands it one, because the card and the sentence are no
 * longer on the same screen. It is not reconstructed across tabs.
 *
 * A **server** component, and it does three things a client one could not:
 *
 * 1. It unseals the session here, so the gateway tokens in the cookie never
 *    reach the browser. `SignInPanel` is rendered on this side of the boundary
 *    and handed down as an element, so only what it prints crosses.
 * 2. It opens **one** gateway session and asks it one thing: a real
 *    `tools/list` with the session's bearer (#15, `lib/agent/tool-list.ts`).
 *    That is the *whole* cost of this page against the gateway — one listing,
 *    zero governed tool calls — since #157 moved the loan cards off the MCP
 *    path. They used to be two `Loan_GetLoan` reads made here, which put two
 *    decisions on the control plane before the presenter had said anything and
 *    left the audience unable to tell the agent's calls from the page's chrome.
 *    `test/home-surface.test.ts` asserts the counts.
 *
 *    It also reads the loan book, but not from the gateway: `readLoanBook`
 *    calls `apps/loan-app` over HTTP with this browser's IdP bearer, so the
 *    first paint is already correct and the cards poll `GET /api/loans` from
 *    then on. `lib/loan-context/loans.ts` has the argument. The two reads are
 *    independent — one goes to the gateway, one to the bank's own API — so the
 *    page waits once rather than twice.
 * 3. It resolves **one** address from the environment at request time: where
 *    #20's chat watches for an approval decision. `next build` inlines
 *    `NEXT_PUBLIC_*` into the client bundle while Render supplies service
 *    variables at runtime, so a public variable would be `undefined` in the
 *    deployed browser and perfectly fine under `next dev` — see
 *    `lib/governance/stream-url.ts`.
 *
 *    This is the **only** stream this page touches, and it is an
 *    approval-notice listener, not the governance timeline: it reads
 *    `event: approval` and drops every `event: governance` frame by name
 *    (`lib/governance/approval-stream.ts`). The panel's subscription is gone
 *    from here with the panel. `null` when this deployment has no live control
 *    plane, in which case the page renders exactly as it does now and a turn
 *    that ends waiting stays ended — this page does not depend on
 *    `panel_stream`, which `/health` still reports for `/panel`.
 *
 * ## Where #15's widget sits
 *
 * In the bank pane's tool-list slot, which is what that slot was cut for. #15's
 * `PersonaToolList` says so from its own side — *"everything this component
 * needs arrives as data"* — and this is the line where the two halves of that
 * sentence meet. Act 1 is an absence: as Bob, `Loan_ApproveLoan` is missing
 * from a list the **gateway** answered, not struck through by anything here.
 */
import type { CSSProperties } from "react";
import { cookies } from "next/headers";

import { configurationProblems, readIdentitySurface } from "../lib/config.ts";
import { readSessionFromCookies } from "../lib/identity/session.ts";
import { approvalStreamUrl } from "../lib/governance/stream-url.ts";
import { homeSurface } from "../lib/home/surface.ts";
import { readLoanBook } from "../lib/loan-context/read.ts";
import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import { SignInPanel } from "../components/identity/SignInPanel.tsx";
import { BankPane } from "../components/bank/BankPane.tsx";

/**
 * Dynamic, because it reads a session cookie and the environment. Saying so
 * explicitly rather than relying on `cookies()` to infer it keeps `next build`
 * from evaluating this component at all — a prerender of a page about who is
 * signed in is either wrong or empty, and it runs under `NODE_ENV=production`
 * with none of the deployment's environment.
 */
export const dynamic = "force-dynamic";

/**
 * The presenter's way across, and the only mention of the other surface on this
 * page (#155). Deliberately small, in the corner, and styled inline rather than
 * with a class: `components/bank/bank.css` owns the bank's chrome and this is
 * not part of it, and a `cg-` class here would put the panel's namespace on a
 * page that must not carry one.
 */
const PANEL_LINK: CSSProperties = {
  position: "fixed",
  right: "0.5rem",
  bottom: "0.4rem",
  zIndex: 1,
  font: "inherit",
  fontSize: "0.7rem",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#6d6a62",
  textDecoration: "none",
  opacity: 0.75,
};

export default async function Home() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  // No session means no network call: both of these answer without asking.
  const [{ tools }, loans] = await Promise.all([
    homeSurface(session, { config }),
    readLoanBook(session),
  ]);

  return (
    <>
      <BankPane
        signedInAs={session?.email ?? null}
        identity={<SignInPanel session={session} problems={configurationProblems(config)} />}
        loans={loans}
        toolList={<PersonaToolList session={session} tools={tools} />}
        // #20: the chat watches the control plane for the one frame that
        // resumes a turn a human was asked about. `null` unless there is a live
        // control plane — a fixture replay has no approval frames in it.
        approvalStreamUrl={approvalStreamUrl(process.env)}
      />
      <a href="/panel" style={PANEL_LINK}>
        Control plane ↗
      </a>
    </>
  );
}

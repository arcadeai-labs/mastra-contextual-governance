"use client";

/**
 * The bank's loan origination system, and since #155 the whole of `/`.
 *
 * Deliberately dull. Square corners, hairline rules, uppercase field labels, a
 * navy chrome bar, five tabs of which four go nowhere, and a release number
 * nobody has bumped since 2009. The argument this screen is making is that
 * *this* — a fifteen-year-old system of record with a real loan book behind it —
 * is what agents are being connected to, and a beautiful version quietly undoes
 * it: it makes the governed system look like part of the same product as the
 * thing governing it. #22's issue comment says so in as many words: resist
 * making it pretty.
 *
 * ## Full-screen, with nothing beside it
 *
 * #22 put this pane in the left half of a split screen with Arcade's control
 * plane in the right. #155 removed the split: the control plane is full-screen
 * at `/panel` and the presenter switches to it. Nothing here knows that page
 * exists — no governance pane, no timeline subscription, no `cg-` class — and
 * the one link across is drawn by `app/page.tsx`, outside this component, for
 * exactly that reason.
 *
 * ## What is real here
 *
 * Everything. The loan files are read from `apps/loan-app` through the Arcade
 * gateway as the signed-in person, the sign-in panel is #82's real OIDC
 * sign-in against `apps/idp`, and the chat is #14's real agent. Nothing on this
 * screen is a mock, and the one region that is not built yet says so
 * ({@link ToolListSlot}).
 *
 * ## The fork seam
 *
 * A developer forking this template keeps the control plane entirely and
 * replaces this. That is only true if the bank's styling is somewhere they can
 * delete: it is `components/bank/bank.css`, nothing under `components/bank`
 * imports anything from `components/governance`, and no `cg-` class name
 * appears on this screen. `test/home-screen.test.tsx` fails if any of that
 * stops holding.
 *
 * ## `data-hydrated`
 *
 * The one thing this screen says about itself: whether it is live in a browser
 * yet. The page is server-rendered, so its HTML — including the composer and an
 * authorization card — exists and is inert before React reaches it, and nothing
 * else on the page distinguishes the two states.
 *
 * It is a plain attribute, set once on mount and never read by this code. No
 * style, no behaviour and no branch depends on it; removing it changes what
 * this screen does not at all. What it gives anything driving a real browser is
 * a stable answer to *"can I click yet?"* — a parent's mount effect runs after
 * its children have committed, so this attribute appearing means the chat
 * composer and the loan cards beneath it are hydrated, with their handlers
 * attached. #152 added it because the alternative was reading React's private
 * DOM bookkeeping, which is a promise React never made.
 *
 * It lived on `.cg-split` until #155 deleted that shell. This is the same
 * marker on the component that inherited the job: `BankPane` is now the
 * outermost thing on `/` with a DOM element of its own — `HomeRefreshBoundary`
 * wraps it but renders only a context provider — so its mount effect is still
 * the last one to run over everything this page's tests drive.
 */
import { useEffect, useState, type ReactNode } from "react";

import { Chat } from "../chat/Chat.tsx";
import { LoanFilesView } from "./LoanFiles.tsx";
import type { LoanFilesState } from "../../lib/loan-context/loans.ts";
import { ToolListSlot } from "./ToolListSlot.tsx";
import "./bank.css";

/** The tab strip. Four of them are chrome; this is the screen you are on. */
const TABS = ["Pipeline", "Applications", "Decisions", "Reports", "Admin"] as const;
const CURRENT_TAB = "Applications";

export interface BankPaneProps {
  /** The persona this browser is signed in as, or `null`. Read from the sealed session. */
  signedInAs: string | null;
  /**
   * #82's sign-in panel, rendered on the server and handed down as an element.
   *
   * An element rather than a `Session`, so the sealed cookie is unsealed in the
   * server component that owns it and only what the panel prints crosses to the
   * browser. It is also the persona switcher: `DESIGN.md` → Identity, switching
   * persona is signing out and in, and there is no client-side control that
   * changes a `user_id`.
   */
  identity: ReactNode;
  /**
   * The two applications under review, already read.
   *
   * Data rather than an element, and required rather than optional. The reads
   * are two governed `Loan_GetLoan` calls made in `app/page.tsx` on the same
   * gateway session that listed this persona's tools (#109), so by the time
   * this component exists they have happened — there is nothing for it to
   * fetch and no state for it to hold. Required because a screen that silently
   * drew no applications would look exactly like a control plane that refused
   * both.
   */
  loanFiles: LoanFilesState;
  /** #15's tool list, when there is one. */
  toolList?: ReactNode;
  /**
   * Where the chat watches for an approval decision (#20). Passed through, not
   * read.
   *
   * The only stream this screen touches, and it carries approval notices only
   * — `lib/governance/approval-stream.ts` drops every `event: governance`
   * frame by name. The control plane's own timeline subscription went to
   * `/panel` with the panel (#155). `null` when this deployment has no live
   * control plane, and then nothing here opens a socket at all.
   */
  approvalStreamUrl?: string | null;
  /** Explicit home authorization continuation; the App Router supplies this at the shell boundary. */
  onContinueAuthorization?: () => void | Promise<void>;
}

export function BankPane({
  signedInAs,
  identity,
  loanFiles,
  toolList,
  approvalStreamUrl = null,
  onContinueAuthorization,
}: BankPaneProps) {
  // Inert, and deliberately so: nothing here reads it. See the note above.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <div className="bank" data-hydrated={hydrated ? "true" : undefined}>
      <header className="bank-chrome">
        <p className="bank-chrome-name">Loan Origination System</p>
        <span className="bank-chrome-division">Commercial Lending Division</span>
        <span className="bank-chrome-release">Rel. 7.2.1</span>
      </header>

      <nav className="bank-tabs" aria-label="Sections">
        {TABS.map((tab) => (
          // Not links. There is nothing behind four of them, and a tab that
          // navigates nowhere is worse on a projector than one that plainly
          // cannot be pressed.
          <span key={tab} className="bank-tab" {...(tab === CURRENT_TAB ? { "aria-current": "page" as const } : {})}>
            {tab}
          </span>
        ))}
      </nav>

      {/* The one line the back of the room has to be able to read: who the
          system thinks is using it. Every tool call this screen makes is made
          as this person, so when the control plane on the other page shows a
          refusal the first question — refused for whom — is already answered
          here, where the call was made. */}
      <div className="bank-user">
        <span className="bank-user-label">Signed in as</span>
        <span className="bank-user-value" data-signed-in={signedInAs !== null}>
          {signedInAs ?? "no user"}
        </span>
      </div>

      {/* Reading order is still the order of the demo — the file being decided,
          then the conversation deciding it — but since #155 it runs left to
          right rather than top to bottom. On half a 1920 screen one column was
          right; on the whole of it, a single column gives the transcript and
          its composer the full 1920px and pushes the tool list and the sign-in
          panel under the fold. Two columns put the conversation beside the file
          instead, at a readable measure and at the full height of the viewport,
          with no scrolling needed to reach any of the four regions.

          Both columns are the bank's own application. This is not the split
          #155 removed: that one put a *second system* — the control plane —
          opposite this one, and the two moved together. A loan card changing
          status beside the chat when an approval lands is this system showing
          its own effect (#157). */}
      <div className="bank-body">
        <div className="bank-column bank-column-records">
          <LoanFilesView
            state={loanFiles}
            {...(onContinueAuthorization === undefined ? {} : { onContinueAuthorization })}
          />

          <ToolListSlot>{toolList}</ToolListSlot>

          <section className="bank-panel" aria-label="User session">
            <h2 className="bank-panel-title">User session</h2>
            <div className="bank-panel-body">{identity}</div>
          </section>
        </div>

        <div className="bank-column bank-column-assistant">
          <section className="bank-panel bank-chat" aria-label="Assistant">
            <h2 className="bank-panel-title">Assistant</h2>
            <div className="bank-panel-body">
              <Chat signedInAs={signedInAs} approvalStreamUrl={approvalStreamUrl} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

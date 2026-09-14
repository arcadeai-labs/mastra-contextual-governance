"use client";

/**
 * The left half: the bank's loan origination system.
 *
 * Deliberately dull. Square corners, hairline rules, uppercase field labels, a
 * navy chrome bar, five tabs of which four go nowhere, and a release number
 * nobody has bumped since 2009. The argument the split screen is making is that
 * *this* — a fifteen-year-old system of record with a real loan book behind it —
 * is what agents are being connected to, and a beautiful left half quietly
 * undoes it: it makes the governed system look like part of the same product as
 * the thing governing it. #22's issue comment says so in as many words: resist
 * making it pretty.
 *
 * ## What is real here
 *
 * Everything. The loan files are read from `apps/loan-app` through the Arcade
 * gateway as the signed-in person, the sign-in panel is #82's real OIDC
 * sign-in against `apps/idp`, and the chat is #14's real agent. Nothing on this
 * side is a mock, and the one region that is not built yet says so
 * ({@link ToolListSlot}).
 *
 * ## The fork seam
 *
 * A developer forking this template keeps the right half entirely and replaces
 * the left. That is only true if the left half's styling is somewhere they can
 * delete: it is `components/bank/bank.css`, nothing under `components/bank`
 * imports anything from `components/governance`, and no `cg-` class name
 * appears on this side of the screen. `test/split-screen.test.tsx` fails if any
 * of that stops holding.
 */
import type { ReactNode } from "react";

import { Chat } from "../chat/Chat.tsx";
import type { ChatEvent } from "../../lib/agent/events.ts";
import { LoanFiles } from "./LoanFiles.tsx";
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
  /** #15's tool list, when there is one. */
  toolList?: ReactNode;
  onChatEvent?: (event: ChatEvent) => void;
  onTurnStart?: () => void;
}

export function BankPane({
  signedInAs,
  identity,
  toolList,
  onChatEvent,
  onTurnStart,
}: BankPaneProps) {
  return (
    <div className="bank">
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
          system thinks is using it. Every tool call on both halves of this
          screen is made as this person, so when the panel opposite shows a
          refusal the first question — refused for whom — is already answered. */}
      <div className="bank-user">
        <span className="bank-user-label">Signed in as</span>
        <span className="bank-user-value" data-signed-in={signedInAs !== null}>
          {signedInAs ?? "no user"}
        </span>
      </div>

      <div className="bank-body">
        <LoanFiles />

        <ToolListSlot>{toolList}</ToolListSlot>

        <section className="bank-panel bank-chat" aria-label="Assistant">
          <h2 className="bank-panel-title">Assistant</h2>
          <div className="bank-panel-body">
            <Chat signedInAs={signedInAs} {...(onChatEvent ? { onEvent: onChatEvent } : {})} {...(onTurnStart ? { onTurnStart } : {})} />
          </div>
        </section>

        <section className="bank-panel" aria-label="User session">
          <h2 className="bank-panel-title">User session</h2>
          <div className="bank-panel-body">{identity}</div>
        </section>
      </div>
    </div>
  );
}

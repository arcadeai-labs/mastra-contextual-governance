"use client";

/**
 * The demo, as one screen: the bank's loan system on the left, Arcade's control
 * plane on the right.
 *
 * **The layout is the message.** Two halves, a hard chartreuse rule between
 * them, neither one embedded in the other — because the claim is that the
 * controls live *outside* the system being controlled, and a panel drawn inside
 * the bank's chrome would be arguing the opposite. `DESIGN.md` → Decisions →
 * Design: left half deliberately boring enterprise app, right half
 * Arcade-branded control plane.
 *
 * ## It composes; it does not re-implement
 *
 * Everything on this screen was built by another slice and is used here as it
 * stands:
 *
 * - the sign-in panel and persona switcher (#82, `components/identity`)
 * - the chat with the agent (#14, `components/chat`)
 * - the control-plane panel with its LIVE/FIXTURE badge (#21, #81,
 *   `components/governance`)
 * - the tool list (#15) — a named slot, not a second implementation
 *
 * What this file adds is the split, and one join.
 *
 * ## The join
 *
 * When the chat shows a denial, the panel outlines the audit rows that denial
 * came from. #6 built that seam (`lib/governance/correlation.ts`) and #21 wired
 * the panel to accept a `correlationKey`; nothing had ever handed it one,
 * because the two surfaces had never been on the same page. Now the presenter
 * can point at a sentence in the transcript and at the card it was written by,
 * and the room can see they are the same event rather than take it on trust.
 *
 * The key is the denial's **verbatim** text, which is what carries the
 * `[ref evt_…]` token. It is cleared when a new turn starts: a highlight left
 * over from the last question is a claim about this one.
 *
 * ## Mobile
 *
 * Out of scope, per #1 and the issue. A stacked version of this screen would
 * not make the argument the screen exists to make.
 */
import { useCallback, useState, type ReactNode } from "react";

import { BankPane } from "../bank/BankPane.tsx";
import type { ChatEvent } from "../../lib/agent/events.ts";
import type { CorrelationKey } from "../../lib/governance/correlation.ts";
import type { PanelStream } from "../../lib/governance/stream-url.ts";
// The panel's two public entry points, the same pair `app/panel/page.tsx` uses.
// Nothing here reaches into a lane, a card or the decision table: the right half
// is a whole surface this shell places, not a set of parts it assembles.
import { ControlPlanePanel } from "../governance/ControlPlanePanel.tsx";
import { PanelStreamError } from "../governance/PanelStreamError.tsx";
import "./shell.css";

export interface SplitScreenProps {
  /** Which stream the panel watches, resolved on the server. Address and mode together. */
  stream: PanelStream;
  signedInAs: string | null;
  /** #82's sign-in panel, server-rendered. */
  identity: ReactNode;
  /** #15's tool list, when it lands. */
  toolList?: ReactNode;
}

export function SplitScreen({ stream, signedInAs, identity, toolList }: SplitScreenProps) {
  const [correlationKey, setCorrelationKey] = useState<CorrelationKey | undefined>(undefined);

  const onChatEvent = useCallback((event: ChatEvent) => {
    // Denials only. An allow correlates on `execution_id`, which does not cross
    // the gateway — #6 measured that, and it is why the token rides in the
    // denial's text at all. A fault correlates to nothing by construction:
    // nothing decided anything, so there is no row to point at, and outlining
    // one would be this screen asserting a decision that was never made.
    if (event.kind === "denied") setCorrelationKey({ kind: "message", message: event.reason });
  }, []);

  const onTurnStart = useCallback(() => setCorrelationKey(undefined), []);

  return (
    <div className="cg-split">
      <div className="cg-split-left">
        <BankPane
          signedInAs={signedInAs}
          identity={identity}
          {...(toolList === undefined ? {} : { toolList })}
          onChatEvent={onChatEvent}
          onTurnStart={onTurnStart}
        />
      </div>

      <div className="cg-split-right">
        {/* An unconfigured stream renders instead of the panel, never above it.
            #81: a warning over a running replay is still a running replay, and
            nothing here may open a socket it cannot name. */}
        {stream.mode === "unconfigured" ? (
          <PanelStreamError problem={stream.problem} />
        ) : (
          <ControlPlanePanel stream={stream} correlationKey={correlationKey} />
        )}
      </div>
    </div>
  );
}

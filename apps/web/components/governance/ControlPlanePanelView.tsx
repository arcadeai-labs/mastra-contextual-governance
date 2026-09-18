/**
 * The panel, as a pure function of a timeline.
 *
 * Split out from the subscribing component on purpose: everything worth
 * asserting about this surface — that a denial shows its rule, that a removed
 * value never reaches the markup, that three states are distinguishable
 * without colour — is a property of *this*, and none of it needs a socket, a
 * browser, or a fake timer to check.
 *
 * There is deliberately no prose on the panel. `DESIGN.md` open risk 2 — that
 * Arcade refuses an unmet auth requirement before any hook runs, so such a
 * refusal reaches nothing here — is a real caveat and it lives in
 * `apps/web/README.md`. A paragraph of it on a projector was read as noise in
 * design review, which is a fair reading: nobody at the back of a room reads a
 * footnote, and the space it took belonged to the lanes.
 *
 * ## What #158 took out, and why the lanes keep everything
 *
 * The 2026-09-18 rehearsal verdict was *too noisy*, so this file now draws
 * **one row of chrome** — title, stream badge, connection, and the health strip
 * when there is one — and then the lanes. The **global tally row is gone**: it
 * repeated, in the largest numerals on the screen, a total the three lane
 * headers already carry between them, and it did it in the band of the
 * projector where the first card should be.
 *
 * Nothing stopped being counted. `timeline.counts` is untouched and still totals
 * every decision received; `timeline.laneCounts` is what the headers render,
 * `timeline.test.ts` still asserts the three lanes sum to the global tally, and
 * `panel.test.tsx` asserts the per-lane counters over the same events the tally
 * row used to be asserted over. A number that left the screen but stayed in the
 * model is a presentation cut. A number that stopped being *computed* would be
 * this project's own failure mode, and is not what happened here.
 */
import type { ReactNode } from "react";

import type { GovernanceEvent } from "@cg/policy-schema";

import { correlate, isCorrelated, type CorrelationKey } from "../../lib/governance/correlation.ts";
import type { StreamStatus } from "../../lib/governance/subscribe.ts";
import type { PanelSource } from "../../lib/governance/stream-url.ts";
import { allEvents, HOOK_POINTS, type Timeline } from "../../lib/governance/timeline.ts";
import { Lane } from "./Lane.tsx";

/** Cards drawn per lane. Beyond this a lane counts rather than draws. */
export const VISIBLE_PER_LANE = 6;

const CONNECTION: Readonly<Record<StreamStatus, string>> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
};

export interface ControlPlanePanelViewProps {
  readonly timeline: Timeline;
  readonly status: StreamStatus;
  /** Which stream this is, so the badge can say so. Never inferred from the events. */
  readonly source: PanelSource;
  /**
   * What the chat is currently showing, if anything — a denial's text, or an
   * execution id. Everything it joins to is outlined. Absent means no
   * highlight, which is the normal state.
   */
  readonly correlationKey?: CorrelationKey | undefined;
  /**
   * The control plane's own health, above the lanes (#106). A slot rather than
   * something this component fetches, for the reason everything else here is
   * data: the whole value of this file is that a denial showing its rule, a
   * removed value never reaching the markup and three states being
   * distinguishable without colour are all assertable without a socket. The
   * strip polls, so it is handed down as an element by the component that
   * already owns a subscription.
   *
   * Absent on a fixture replay, and that is the point rather than an
   * omission: a replay has no control plane behind it, and a health strip over
   * one would be describing a service these lanes are not watching (#81).
   */
  readonly controlPlane?: ReactNode;
}

export function ControlPlanePanelView({
  timeline,
  status,
  source,
  correlationKey,
  controlPlane,
}: ControlPlanePanelViewProps) {
  const correlated: GovernanceEvent[] =
    correlationKey === undefined ? [] : correlate(allEvents(timeline), correlationKey);
  const correlatedIds = new Set(correlated.map((event) => event.id));

  return (
    <div className="cg-panel">
      {/* One row, and everything in it is chrome. The lanes start immediately
          under it, at the top of the screen, which is the whole point of the
          cut: three headings and a tally used to push the first card a third
          of the way down a projector. */}
      <header className="cg-header">
        <h2 className="cg-title">Control plane</h2>
        {controlPlane}
        <div className="cg-connection" data-status={status}>
          <StreamBadge source={source} />
          <span className="cg-dot" aria-hidden="true" />
          <span>{CONNECTION[status]}</span>
        </div>
      </header>

      <div className="cg-lanes">
        {HOOK_POINTS.map((hook) => (
          <Lane
            key={hook}
            hook={hook}
            events={timeline.lanes[hook]}
            behind={timeline.behind[hook]}
            counts={timeline.laneCounts[hook]}
            visible={VISIBLE_PER_LANE}
            flashKey={
              timeline.lanes[hook][0]?.id === timeline.latestId
                ? (timeline.lanes[hook][0] ?? null)
                : null
            }
            correlatedIds={correlatedIds}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Which stream this is, named on screen, always.
 *
 * The audience is being asked to believe that what they are watching is a real
 * control plane deciding real calls. Before #81 the live panel said nothing at
 * all and a replay said "Fixture replay" in small type, so the claim rested on
 * the presenter's word. Both modes carry a badge now: the question "is this
 * real?" is answered on the projector rather than from the stage.
 *
 * `LIVE` carries the host because that is the falsifiable part. "Live" alone is
 * a word a fixture could print; `LIVE · cg-hooks.onrender.com` names the
 * service whose `/events` this is, and a wrong one is visible at the back of
 * the room. Chartreuse is Arcade's chrome signifier and already means "the live
 * dot" on this header, so live gets it and the replay is deliberately plainer —
 * never a status colour, which on this panel only ever means a decision.
 */
function StreamBadge({ source }: { source: PanelSource }) {
  return (
    <span className="cg-mode" data-mode={source.mode}>
      {source.mode === "hooks" ? `LIVE · ${source.host}` : "FIXTURE REPLAY"}
    </span>
  );
}

/** Re-exported so callers can highlight without importing two modules. */
export { isCorrelated };

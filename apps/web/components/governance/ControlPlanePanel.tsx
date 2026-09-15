"use client";

/**
 * The panel, wired to a stream.
 *
 * All this adds to {@link ControlPlanePanelView} is a subscription and a piece
 * of state. The stream's address arrives as a prop because it is resolved in a
 * server component — see `lib/governance/stream-url.ts` for why a
 * `NEXT_PUBLIC_` variable would be empty in the deployed browser and fine in
 * development, which is the worst way to find out.
 */
import { useEffect, useState } from "react";

import type { CorrelationKey } from "../../lib/governance/correlation.ts";
import type { WatchableStream } from "../../lib/governance/stream-url.ts";
import { subscribeToGovernanceEvents, type StreamStatus } from "../../lib/governance/subscribe.ts";
import { appendEvents, emptyTimeline } from "../../lib/governance/timeline.ts";
import { ControlPlanePanelView } from "./ControlPlanePanelView.tsx";
import { ControlPlaneStatus } from "./ControlPlaneStatus.tsx";

export interface ControlPlanePanelProps {
  /**
   * Address *and* mode together, never separately: the badge this renders
   * claims which stream the events came from, and two props could disagree.
   * An unconfigured stream never reaches here — `app/panel/page.tsx` renders
   * `PanelStreamError` instead, so no socket is opened and no fixture plays.
   */
  readonly stream: WatchableStream;
  readonly correlationKey?: CorrelationKey | undefined;
}

export function ControlPlanePanel({ stream, correlationKey }: ControlPlanePanelProps) {
  const streamUrl = stream.url;
  const [timeline, setTimeline] = useState(emptyTimeline);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    const controller = new AbortController();

    void subscribeToGovernanceEvents(streamUrl, {
      // The subscriber hands over everything one read of the socket yielded, so
      // a burst of a thousand events costs a handful of renders rather than a
      // thousand. Appending the batch in one update is the other half of that.
      onEvents: (batch) => setTimeline((current) => appendEvents(current, batch)),
      onStatus: setStatus,
      onUnusableFrame: (data, problem) => {
        // Loud on purpose. A frame the panel cannot read is a contract
        // mismatch with the hook server, and the symptom — a panel that shows
        // nothing — looks identical to a control plane deciding nothing.
        console.warn(`[control-plane] unusable frame (${problem}):`, data);
      },
      // The home page's server render reads both loan files through the
      // governed gateway before this hydrated component can open its browser
      // stream. Ask the existing resumable endpoint for the complete log on
      // the first connection so those committed audit rows are visible; after
      // that, subscribe.ts resumes from the last id it actually received.
      initialLastEventId: "0",
      signal: controller.signal,
    });

    return () => controller.abort();
  }, [streamUrl]);

  return (
    <ControlPlanePanelView
      timeline={timeline}
      status={status}
      source={stream}
      correlationKey={correlationKey}
      // Only over the live stream. A fixture replay has no control plane
      // behind it, and a health strip claiming one would be the #81 failure
      // wearing this slice's clothes.
      controlPlane={stream.mode === "hooks" ? <ControlPlaneStatus /> : undefined}
    />
  );
}

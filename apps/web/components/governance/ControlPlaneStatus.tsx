"use client";

/**
 * A strip above the lanes saying whether the control plane behind them is the
 * one this deployment shipped (#106).
 *
 * The lanes carry decisions and nothing else, which leaves three things
 * invisible on the surface whose whole job is making governance visible:
 *
 * - the policy no longer compiles, so every call is being refused and the
 *   lanes are filling with denials that mean "we are broken", not "you may
 *   not";
 * - the rules on the control plane's disk are not the rules in this image, so
 *   an act the audience is about to watch may not be live at all;
 * - `cg-hooks` cannot be reached, so the panel is showing an old timeline and
 *   a quiet minute and a dead service look the same.
 *
 * On 2026-09-14 all three were true at once and the panel looked normal.
 *
 * ## It renders in every state, including the good one
 *
 * A strip that appears only when something is wrong is a strip whose absence
 * has to be trusted. `HEALTHY · LIVE POLICY` is one line and it is the line
 * that makes the warning legible when it replaces it. `--deny` red is reserved
 * on this panel for a decision, so degraded uses `--modify` amber: this is a
 * caveat about the instrument, never a refusal by it.
 */
import { useCallback, useEffect, useState } from "react";

import {
  CONTROL_PLANE_PATH,
  type ControlPlaneReport,
  type ResetMode,
} from "../../lib/governance/control-plane.ts";

export interface ControlPlaneStatusProps {
  /** How often to re-ask. The strip is not a stream; nothing here is hot. */
  readonly pollMs?: number;
  /** Overridden in tests so the route can be served on a port the OS picked. */
  readonly endpoint?: string;
  /**
   * Which mode the Reset button runs.
   *
   * `demo` by the human's decision on #106: the button a presenter reaches for
   * between takes is the rehearsal reset, not the narrow one. The narrow one
   * has its own home — it is offered by the drift warning, where it is the
   * exact remedy for the exact thing being warned about, and nowhere else.
   * A prop so a test can pin both without reaching into module state.
   */
  readonly defaultMode?: ResetMode;
}

type Busy = { readonly mode: ResetMode } | null;

export function ControlPlaneStatus({
  pollMs = 5000,
  endpoint = CONTROL_PLANE_PATH,
  defaultMode = "demo",
}: ControlPlaneStatusProps) {
  const [report, setReport] = useState<ControlPlaneReport | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ResetMode | null>(null);

  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(endpoint, { signal, cache: "no-store" });
        setReport((await response.json()) as ControlPlaneReport);
      } catch (cause) {
        // An aborted poll is a unmount, not a fault.
        if (signal.aborted) return;
        setReport({
          reachable: false,
          host: "this deployment",
          reset: "no-token",
          problem: `the panel could not reach its own control-plane route: ${String(cause)}`,
        });
      }
    },
    [endpoint],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    const timer = setInterval(() => void read(controller.signal), pollMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [read, pollMs]);

  const press = async (mode: ResetMode) => {
    setConfirming(null);
    setBusy({ mode });
    setOutcome(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = (await response.json()) as {
        detail?: string;
        error?: string;
        report?: ControlPlaneReport;
      };
      setOutcome(body.detail ?? body.error ?? `HTTP ${response.status}`);
      if (body.report !== undefined) setReport(body.report);
    } catch (cause) {
      setOutcome(`the reset could not be sent: ${String(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  if (report === null) {
    return (
      <section className="cg-control-plane" data-state="unknown" aria-busy="true">
        <span className="cg-control-plane-badge">CHECKING…</span>
        <p className="cg-control-plane-line">Asking the control plane how it is.</p>
      </section>
    );
  }

  if (!report.reachable) {
    return (
      <section className="cg-control-plane" data-state="unreachable" role="alert">
        <span className="cg-control-plane-badge">UNREACHABLE</span>
        <p className="cg-control-plane-line">{report.problem}</p>
      </section>
    );
  }

  const drift = report.fixture_drift;
  const degraded = report.status !== "healthy";

  return (
    <section
      className="cg-control-plane"
      data-state={degraded ? "degraded" : "healthy"}
      {...(degraded ? { role: "alert" as const } : {})}
    >
      <span className="cg-control-plane-badge">
        {degraded ? "DEGRADED" : "HEALTHY"} · {report.host}
      </span>

      {report.policy.status !== "ready" ? (
        <p className="cg-control-plane-line">
          The policy is <strong>{report.policy.status}</strong>, so every{" "}
          <code>/access</code>, <code>/pre</code> and <code>/post</code> call is being refused.
          {report.policy.error === null ? null : (
            <>
              {" "}
              <span className="cg-control-plane-detail">{report.policy.error}</span>
            </>
          )}
        </p>
      ) : (
        <p className="cg-control-plane-line">
          Policy revision {report.policy.revision ?? "?"} · injection detection{" "}
          {report.injection_detection.state} ({report.injection_detection.patterns} pattern
          {report.injection_detection.patterns === 1 ? "" : "s"})
        </p>
      )}

      {drift === null ? null : (
        <div className="cg-control-plane-drift">
          <p className="cg-control-plane-line">
            <strong>Fixture drift.</strong> {drift.ids.length} row
            {drift.ids.length === 1 ? "" : "s"} on the control plane&apos;s disk differ from the
            policy this image ships. A rule edited live on stage looks exactly like this and is
            meant to survive; so does a fixture change that never reached the disk, and that one
            means an act is not live.
          </p>
          <ul className="cg-control-plane-ids">
            {drift.ids.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
          {/* The remedy, attached to the warning rather than parked in the
              action row: this button is not "a smaller reset", it is the
              answer to the sentence directly above it, and a presenter
              reading that sentence on a projector should not have to look
              somewhere else for what to do about it. Gated on the same
              `reset` state as the button below — an unset RESET_TOKEN takes
              BOTH controls away, never one. */}
          {report.reset === "enabled" ? (
            <div className="cg-control-plane-actions">
              <button
                type="button"
                className="cg-control-plane-button"
                disabled={busy !== null}
                onClick={() => setConfirming("policy")}
              >
                {busy?.mode === "policy" ? "Resyncing…" : "Resync policy"}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {report.reset === "upstream-disabled" ? (
        <p className="cg-control-plane-line cg-control-plane-detail">
          Reset is unavailable: <code>RESET_TOKEN</code> is set on this service but not on{" "}
          {report.host}, so <code>POST /admin/reset</code> does not exist there.
        </p>
      ) : null}

      {report.reset === "enabled" ? (
        <div className="cg-control-plane-actions">
          <button
            type="button"
            className="cg-control-plane-button"
            data-emphasis="primary"
            disabled={busy !== null}
            onClick={() => setConfirming(defaultMode)}
          >
            {busy !== null && busy.mode === defaultMode ? "Resetting…" : "Reset"}
          </button>
        </div>
      ) : null}

      {confirming === null ? null : (
        <div className="cg-control-plane-confirm" role="alertdialog" aria-label="Confirm reset">
          <p className="cg-control-plane-line">{CONFIRMATION[confirming]}</p>
          <div className="cg-control-plane-actions">
            <button
              type="button"
              className="cg-control-plane-button"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cg-control-plane-button"
              data-emphasis="primary"
              onClick={() => void press(confirming)}
            >
              {confirming === "demo" ? "Reset the demo" : "Replace the policy"}
            </button>
          </div>
        </div>
      )}

      {outcome === null ? null : (
        <p className="cg-control-plane-line cg-control-plane-outcome">{outcome}</p>
      )}
    </section>
  );
}

/**
 * What each mode is about to do, in the words that matter to the person
 * pressing it.
 *
 * Both name what SURVIVES as well as what goes, because a reset on a stage is
 * pressed under time pressure and the two modes differ in exactly the thing
 * nobody can undo: the audit log. `demo` is now what the unlabelled "Reset"
 * runs (#106, the human's decision), so its sentence has to carry the whole
 * blast radius rather than most of it — every table it empties, named.
 *
 * Naming `loans.db` is the other half, and it is about *this control* rather
 * than about the demo: an approved LN-2291 survives both modes, because that
 * database belongs to `apps/loan-app` and nothing in the control plane may
 * reach into it (DESIGN.md). A presenter who presses Reset and then finds the
 * loan still approved should read that here, not discover it in front of an
 * audience.
 */
const CONFIRMATION: Record<ResetMode, string> = {
  policy:
    "Replace subjects, the catalogue and every policy and output rule with the fixture this " +
    "image ships, so the live policy is the shipped policy again. Any rule edited live on " +
    "stage is lost. Grants, approval requests and the audit log are kept.",
  demo:
    "The full rehearsal reset. It wipes four things: the policy (subjects, the catalogue, and " +
    "every policy and output rule) is replaced with the fixture this image ships, and grants, " +
    "approval requests and the audit log are emptied — everything this demo has done so far, " +
    "including any rule edited live on stage. It does NOT touch loans.db: approved loans " +
    "belong to the bank's own service and are not reset by this control.",
};

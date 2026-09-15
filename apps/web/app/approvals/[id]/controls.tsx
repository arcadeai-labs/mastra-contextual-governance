"use client";

/**
 * The interactive half of the approval page: who you are acting as, and the
 * two buttons.
 *
 * A client component only because the result of pressing a button has to
 * appear without the message travelling through the URL — a `CHECK_FAILED`
 * remediation string is a paragraph, and putting it in a query parameter would
 * make it forgeable by anyone who can edit an address bar. `useActionState`
 * keeps it server-produced.
 *
 * Both server actions arrive as props. Nothing here talks to Arcade or to the
 * control plane; the browser cannot reach either, and it should not be able to.
 */
import { useActionState } from "react";

import { IDLE, type DecideResult } from "../../../lib/decide.ts";
import { Outcome, pageStyles } from "./view.tsx";

export interface ControlsProps {
  personas: ReadonlyArray<{ user_id: string; display_name: string; role: string }>;
  actingAs: string;
  /** Already decided: the buttons are shown, and refused, rather than hidden. */
  settled: boolean;
  switchPersona: (form: FormData) => Promise<void>;
  decide: (previous: DecideResult, form: FormData) => Promise<DecideResult>;
}

export function DecideControls({
  personas,
  actingAs,
  settled,
  switchPersona,
  decide,
}: ControlsProps) {
  const [result, submit, pending] = useActionState(decide, IDLE);

  return (
    <>
      <form
        action={switchPersona}
        style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}
      >
        <label htmlFor="persona" style={{ fontSize: "0.875rem", color: "var(--muted)" }}>
          Act as
        </label>
        <select
          id="persona"
          name="persona"
          // Keyed on the persona so a switch remounts the select. `defaultValue`
          // is honoured at mount only, and this is a client component that
          // React reconciles rather than remounts when the server re-renders
          // with a new cookie — so without the key the dropdown keeps saying
          // "Charlie" while the panel above it says "Acting as Alice".
          // Two widgets disagreeing about who you are, in the one demo whose
          // whole point is who you are.
          key={actingAs}
          defaultValue={actingAs}
          style={{ ...pageStyles.button, padding: "0.4rem 0.6rem" }}
        >
          {personas.map((persona) => (
            <option key={persona.user_id} value={persona.user_id}>
              {persona.display_name} — {persona.role}
            </option>
          ))}
        </select>
        <button type="submit" style={{ ...pageStyles.button, padding: "0.4rem 0.8rem" }}>
          Switch
        </button>
      </form>

      <form action={submit}>
        <label
          htmlFor="note"
          style={{ display: "block", fontSize: "0.875rem", color: "var(--muted)" }}
        >
          Note to the requester (optional)
        </label>
        <textarea
          id="note"
          name="note"
          rows={2}
          style={{
            width: "100%",
            marginTop: "0.35rem",
            background: "transparent",
            color: "var(--fg)",
            border: "1px solid var(--line)",
            borderRadius: "0.375rem",
            padding: "0.5rem",
            font: "inherit",
          }}
        />
        <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
          <button
            type="submit"
            name="decision"
            value="approved"
            disabled={pending}
            style={{ ...pageStyles.button, borderColor: "#3f9c5a", color: "#3f9c5a" }}
          >
            {pending ? "Sending…" : "Approve"}
          </button>
          <button
            type="submit"
            name="decision"
            value="denied"
            disabled={pending}
            style={{ ...pageStyles.button, borderColor: "#c2494b", color: "#c2494b" }}
          >
            {pending ? "Sending…" : "Deny"}
          </button>
        </div>
        {settled && (
          <p style={{ margin: "0.75rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
            This request has already been decided. The buttons still call the tool — and the
            control plane still refuses them, which is the point.
          </p>
        )}
      </form>

      <Outcome result={result} />
    </>
  );
}

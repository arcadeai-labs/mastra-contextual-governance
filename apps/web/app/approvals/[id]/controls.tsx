"use client";

/**
 * The interactive half of the approval page: the two buttons.
 *
 * A client component only because the result of pressing a button has to
 * appear without the message travelling through the URL — a `CHECK_FAILED`
 * remediation string is a paragraph, and putting it in a query parameter would
 * make it forgeable by anyone who can edit an address bar. `useActionState`
 * keeps it server-produced.
 *
 * **There is no "Act as" control here any more (#180).** It used to sit
 * directly above these buttons, and it was the last persona switcher in the
 * demo, on the one page where identity is load-bearing. Who the call is made
 * as is now the sealed session's answer and is decided on the server, so
 * nothing in the browser — this component included — has any say in it. That is
 * also why this component no longer takes an `actingAs`: it has no use for a
 * name it cannot influence, and a copy of one is a copy that can disagree with
 * the server.
 *
 * The server action arrives as a prop. Nothing here talks to Arcade or to the
 * control plane; the browser cannot reach either, and it should not be able to.
 */
import { useActionState } from "react";

import { IDLE, type DecideResult } from "../../../lib/decide.ts";
import { Outcome, pageStyles } from "./view.tsx";

export interface ControlsProps {
  /** Already decided: the buttons are shown, and refused, rather than hidden. */
  settled: boolean;
  decide: (previous: DecideResult, form: FormData) => Promise<DecideResult>;
}

export function DecideControls({ settled, decide }: ControlsProps) {
  const [result, submit, pending] = useActionState(decide, IDLE);

  return (
    <>
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

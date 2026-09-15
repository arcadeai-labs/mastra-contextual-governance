/**
 * What the approval page looks like. Pure components over plain props, so a
 * test can render them without a Next.js runtime and assert on the text a
 * human would actually read.
 *
 * The denial screen is a first-class part of this file rather than an error
 * boundary, and that is deliberate. Alice clicking her own link gets the same
 * `CHECK_FAILED` her agent got — that is separation of duties working, and it
 * is a beat worth showing. Rendered as a stack trace or a generic error page,
 * the audience reads it as the demo breaking.
 */
import type { ReactNode } from "react";

import type { ApprovalRecord } from "@cg/policy-schema";

import type { DecideResult } from "../../../lib/decide.ts";

const line = "1px solid var(--line)";

const styles = {
  main: { maxWidth: "44rem", margin: "0 auto", padding: "3rem 1.5rem 5rem" },
  eyebrow: {
    margin: 0,
    fontSize: "0.75rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--muted)",
  },
  h1: { fontSize: "1.6rem", margin: "0.4rem 0 0.25rem" },
  id: { color: "var(--muted)", fontSize: "0.8rem", margin: "0 0 1.75rem" },
  row: { display: "flex", gap: "1rem", borderTop: line, padding: "0.7rem 0" },
  label: { width: "11rem", flex: "none", color: "var(--muted)", fontSize: "0.875rem" },
  value: { fontSize: "0.9375rem", minWidth: 0, wordBreak: "break-word" as const },
  panel: { border: line, borderRadius: "0.5rem", padding: "1rem 1.25rem", marginTop: "2rem" },
  button: {
    padding: "0.55rem 1.1rem",
    borderRadius: "0.375rem",
    border: line,
    background: "transparent",
    color: "var(--fg)",
    font: "inherit",
    cursor: "pointer",
  },
} as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={styles.row}>
      <div style={styles.label}>{label}</div>
      <div style={styles.value}>{children}</div>
    </div>
  );
}

/** A number in the unit the seed data counts: US dollars. */
export function money(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

const STATUS_COLOUR: Record<ApprovalRecord["status"], string> = {
  pending: "#c9a227",
  approved: "#3f9c5a",
  denied: "#c2494b",
  expired: "var(--muted)",
};

export function StatusChip({ status }: { status: ApprovalRecord["status"] }) {
  return (
    <span
      style={{
        border: `1px solid ${STATUS_COLOUR[status]}`,
        color: STATUS_COLOUR[status],
        borderRadius: "999px",
        padding: "0.1rem 0.6rem",
        fontSize: "0.75rem",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  );
}

/**
 * Everything the request says, from the one read the link's id allows.
 *
 * Including who was *not* asked: routing chose the lowest sufficient approver
 * and left the chief credit officer alone, and that choice is only visible if
 * the page says so.
 */
export function RequestDetails({ request }: { request: ApprovalRecord }) {
  const notAsked = request.candidate_approver_ids.filter((id) => id !== request.approver_id);

  return (
    <section>
      <Field label="Requested by">
        {request.requester_display_name} <span style={{ color: "var(--muted)" }}>({request.requester_id})</span>
      </Field>
      <Field label="Action">
        <code>{request.action}</code>
      </Field>
      <Field label="Resource">
        <code>{request.resource_id}</code>
      </Field>
      <Field label="Amount">{money(request.amount)}</Field>
      <Field label="Rule tripped">
        {request.rule === null ? (
          <span style={{ color: "var(--muted)" }}>
            The control plane could not name a rule. The authority exceeded was{" "}
            {money(request.required_clearance)}.
          </span>
        ) : (
          <>
            <code>{request.rule.id}</code>
            <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
              {request.rule.description}
            </div>
          </>
        )}
      </Field>
      <Field label="Justification">{request.justification}</Field>
      <Field label="Routed to">
        {request.approver_display_name}{" "}
        <span style={{ color: "var(--muted)" }}>
          (lowest sufficient authority for {money(request.required_clearance)})
        </span>
      </Field>
      {notAsked.length > 0 && (
        <Field label="Also sufficient, not asked">
          <span style={{ color: "var(--muted)" }}>{notAsked.join(", ")}</span>
        </Field>
      )}
      <Field label="Raised">{request.created_at}</Field>
      {request.status !== "pending" && (
        <Field label="Decided">
          {request.decided_by ?? "—"} at {request.decided_at ?? "—"}
          {request.note !== null && (
            <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>{request.note}</div>
          )}
        </Field>
      )}
    </section>
  );
}

/**
 * The result of pressing a button.
 *
 * A refusal names the control that refused, shows the remediation text
 * verbatim, and says plainly that the request is untouched. It is not styled
 * as a crash, because it is not one.
 */
export function Outcome({ result }: { result: DecideResult }) {
  if (result.state === "idle") return null;

  const refused = result.state === "refused";
  const failed = result.state === "failed";
  const colour = refused ? "#c2494b" : failed ? "#c9a227" : "#3f9c5a";
  const heading = refused
    ? "CHECK_FAILED — the control plane refused this decision"
    : failed
      ? "The decision could not be sent"
      : "Decision recorded";

  return (
    <section
      role="status"
      style={{ ...styles.panel, borderColor: colour, borderLeftWidth: "3px" }}
    >
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1rem", color: colour }}>{heading}</h2>
      <p style={{ margin: 0, fontSize: "0.9375rem", whiteSpace: "pre-wrap" }}>{result.message}</p>
      {refused && (
        <p style={{ margin: "0.75rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
          This is the same message the agent received, from the same pre-execution hook, and it
          is recorded in the audit log against the identity that pressed the button. The request
          is unchanged.
        </p>
      )}
      {failed && (
        <p style={{ margin: "0.75rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
          Nothing was decided. This is a fault, not a refusal — no control has spoken.
        </p>
      )}
    </section>
  );
}

/** The page a link with an id nobody recognises lands on. */
export function UnknownRequest({ id, reason }: { id: string; reason: string }) {
  return (
    <main style={styles.main}>
      <p style={styles.eyebrow}>Approval</p>
      <h1 style={styles.h1}>Nothing to decide</h1>
      <p style={{ color: "var(--muted)" }}>{reason}</p>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
        The link carries a request id and nothing else — no token and no authority — so a link
        that no longer resolves is simply a link to a request that is not there. Asked for:{" "}
        <code>{id}</code>.
      </p>
    </main>
  );
}

export interface ApprovalPageProps {
  request: ApprovalRecord;
  /** Who the page is acting as. The identity the tool call is made under. */
  actingAs: string;
  /** Every persona the control plane knows, for the switcher. */
  personas: ReadonlyArray<{ user_id: string; display_name: string; role: string }>;
  /**
   * The interactive block — persona switcher, the two buttons, and whatever
   * came back from pressing one. A client component, passed in, so this shell
   * stays a plain function of its props.
   */
  controls: ReactNode;
}

export function ApprovalPage({ request, actingAs, personas, controls }: ApprovalPageProps) {
  const acting = personas.find((p) => p.user_id === actingAs);

  return (
    <main style={styles.main}>
      <p style={styles.eyebrow}>Approval</p>
      <h1 style={styles.h1}>
        {request.action.replace(/_/g, " ")} — {money(request.amount)} <StatusChip status={request.status} />
      </h1>
      <p style={styles.id}>
        <code>{request.id}</code>
      </p>

      <RequestDetails request={request} />

      <div style={{ ...styles.panel, marginTop: "2.5rem" }}>
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "var(--muted)" }}>
          Acting as <strong style={{ color: "var(--fg)" }}>{acting?.display_name ?? actingAs}</strong>
          {acting !== undefined && ` — ${acting.role}`}. Pressing a button below calls{" "}
          <code>Approvals.Decide</code> through Arcade as that person, so it passes the same
          pre-execution hook as any other tool call. The link itself carries no authority.
        </p>
        {controls}
      </div>
    </main>
  );
}

export const pageStyles = styles;

/**
 * Who is signed in, and what their agent can see.
 *
 * Act 1, on screen. Two facts side by side: the person the session asserts,
 * with the role and authority `DESIGN.md`'s cast gives them, and the tools the
 * **gateway** answered `tools/list` with for that person's bearer. As Bob
 * the approval tool is not in the list — not greyed out, not struck through,
 * not there — because `access.analysts-cannot-see-approve` removed it before
 * the gateway answered.
 *
 * ## What this component deliberately cannot do
 *
 * It has no idea which tools exist. There is no catalogue in this file, no
 * `ApproveLoan` literal, and nothing that could render a tool as hidden — so
 * there is no version of this component that shows Bob a crossed-out approval
 * tool, which would be the picture of a control that does nothing. It renders
 * the list it is handed and says where the list came from.
 *
 * It also does not resolve identity. `session` is #82's sealed session, already
 * unsealed on the server; the role and authority beside it are a *label* looked
 * up from an address the IdP asserted (`lib/identity/roster.ts`). The switcher
 * is `SignInPanel`, and there is no second one.
 *
 * ## Props
 *
 * Two, and they stay two: `session` and `tools`. #22 owns the split-screen
 * shell and hosts this widget inside it, so everything this component needs
 * arrives as data and nothing about the page's layout is decided here.
 */
import { formatAuthority, personaFor, unconfiguredPersonas } from "../../lib/identity/roster.ts";
import type { SessionTools } from "../../lib/agent/tool-list.ts";
import type { Session } from "../../lib/identity/session.ts";

export interface PersonaToolListProps {
  /** #82's sealed session, unsealed on the server. `null` when nobody is signed in. */
  session: Session | null;
  /** The result of one real `tools/list` for that session — `lib/agent/tool-list.ts`. */
  tools: SessionTools;
}

const card: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "6px",
  padding: "1.25rem",
  marginTop: "2rem",
};

const muted: React.CSSProperties = { color: "var(--muted)" };

export function PersonaToolList({ session, tools }: PersonaToolListProps) {
  const persona = personaFor(session?.email);
  const missing = unconfiguredPersonas();

  return (
    <section style={card} aria-label="Signed-in persona and the tools their agent can see">
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Acting as</h2>

      {session ? (
        <>
          <p style={{ margin: 0, fontSize: "1rem" }}>
            {/* The name is the roster's label; the email is the identity. The
                email is always shown, so a missing label never leaves the
                screen without the string the hooks will actually see. */}
            {persona ? <strong>{persona.name}</strong> : <strong style={muted}>Not in this deployment&rsquo;s cast</strong>}{" "}
            <code style={{ fontSize: "0.875rem" }}>{session.email}</code>
          </p>

          {persona ? (
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.25rem 1rem",
                margin: "0.75rem 0 0",
                fontSize: "0.875rem",
              }}
            >
              <dt style={muted}>Role</dt>
              <dd style={{ margin: 0 }}>{persona.role}</dd>
              <dt style={muted}>Approval authority</dt>
              <dd style={{ margin: 0 }}>
                {formatAuthority(persona.clearance)}{" "}
                {/* Said, not implied. `DESIGN.md` lets a presenter raise a
                    clearance live on stage, and this figure is the seeded one —
                    the audit row on the panel is what the control plane
                    actually decided with. */}
                <span style={muted}>as seeded in the policy</span>
              </dd>
            </dl>
          ) : (
            <p style={{ ...muted, fontSize: "0.875rem", marginBottom: 0 }}>
              None of this deployment&rsquo;s role email variables names anybody at that
              address, so there is no role or authority to show.
              {missing.length > 0 ? <> Unset: {missing.map((name) => <code key={name}>{name} </code>)}</> : null}{" "}
              The control plane decides on the address above regardless of what this panel can label.
            </p>
          )}
        </>
      ) : (
        <p style={{ ...muted, fontSize: "0.875rem", margin: 0 }}>
          Nobody is signed in on this browser. The agent acts as whoever signs in here, and there is
          nobody yet.
        </p>
      )}

      {tools.ok ? (
        <details style={{ marginTop: "1.2rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.875rem", fontWeight: 700 }}>
            <span>Tools this persona can see</span>{" "}
            <strong aria-label={`${tools.tools.length} tools`}>({tools.tools.length} tools available)</strong>
          </summary>
          <div style={{ paddingTop: "0.75rem" }}>
            <p style={{ ...muted, fontSize: "0.8125rem", margin: "0 0 0.75rem" }}>
              {/* Where the list came from, on the screen rather than in a comment.
                  The claim being made is that the gateway answered this, and a claim
                  worth making is worth printing. */}
              From the Arcade gateway&rsquo;s own <code>tools/list</code>, for this session&rsquo;s token. Not
              filtered in the browser.
            </p>

            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {tools.tools.map((tool) => (
                <li key={tool.name} style={{ borderTop: "1px solid var(--line)", padding: "0.5rem 0" }}>
                  <code style={{ fontSize: "0.875rem" }}>{tool.name}</code>
                  {tool.description === "" ? null : (
                    <div style={{ ...muted, fontSize: "0.8125rem" }}>{tool.description}</div>
                  )}
                </li>
              ))}
            </ul>

            {tools.tools.length === 0 ? (
              <p style={{ ...muted, fontSize: "0.8125rem", margin: "0.5rem 0 0" }}>
                The gateway advertised nothing this persona may use.
              </p>
            ) : null}

            <p style={{ ...muted, fontSize: "0.8125rem", margin: "0.75rem 0 0" }}>
              {/* "Built-ins filtered and labelled" — the fact of the filter is
                  the point. A quiet drop from eight to six is the same shape of
                  omission this whole demo argues against. */}
              {tools.filtered.length === 0 ? (
                <>The gateway advertised nothing outside this project&rsquo;s toolkits.</>
              ) : (
                <>
                  {tools.filtered.length} further{" "}
                  {tools.filtered.length === 1 ? "entry was" : "entries were"} advertised by the gateway and
                  are not the agent&rsquo;s to call:{" "}
                  {tools.filtered.map((name, index) => (
                    <span key={name}>
                      {index === 0 ? null : ", "}
                      <code>{name}</code>
                    </span>
                  ))}
                  . Arcade&rsquo;s own built-ins, kept out of the model&rsquo;s surface by an allow-list on
                  this project&rsquo;s toolkits.
                </>
              )}
            </p>
          </div>
        </details>
      ) : (
        <p role="status" style={{ fontSize: "0.875rem", margin: 0 }}>
          {/* Never an empty list: "everything was hidden" and "we could not ask"
              are different facts and only one of them is about governance. */}
          No tool list. {tools.reason}
        </p>
      )}
    </section>
  );
}

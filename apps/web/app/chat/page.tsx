/**
 * `/chat` — the agent, and the tool list it was given.
 *
 * A server component, so the session is unsealed on the server and the only
 * thing that reaches the browser is the persona's email. The gateway token
 * never leaves this process; the chat route reads it from the cookie on each
 * turn.
 *
 * The tool list (#15) is fetched here for the same reason: it is one real
 * `tools/list` against the gateway with this session's bearer, which needs a
 * token the browser is never shown. What crosses to the client is the answer,
 * as data.
 *
 * ⚠️ **This is not the demo's screen.** `/` is, and it hosts the same two
 * components — the widget below has a two-prop surface precisely so that the
 * move was a re-parent rather than a rewrite. This page is the tracer bullet's
 * bare scaffold and #155 deliberately left it alone: it is where the chat can
 * be exercised with none of the bank around it.
 */
import { cookies } from "next/headers";

import { Chat } from "../../components/chat/Chat.tsx";
import { configurationProblems, readIdentitySurface } from "../../lib/config.ts";
import { ConfigurationBanner } from "../../components/identity/ConfigurationBanner.tsx";
import { PersonaToolList } from "../../components/identity/PersonaToolList.tsx";
import { approvalStreamUrl } from "../../lib/governance/stream-url.ts";
import { sessionTools } from "../../lib/agent/tool-list.ts";
import { readSessionFromCookies } from "../../lib/identity/session.ts";
import { SIGNIN_PATH, GATEWAY_START_PATH } from "../../lib/identity/handlers.ts";

/** Reads a session cookie; a prerender of "who is signed in" is wrong or empty. */
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  const tools = await sessionTools(session, { config });

  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>Loan operations</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.875rem" }}>
        The agent reaches its tools through the Arcade gateway as the person signed in here. Every
        call passes the control plane first.
      </p>

      <ConfigurationBanner problems={configurationProblems(config)} />

      {session ? null : (
        <p style={{ fontSize: "0.875rem" }}>
          <a href={SIGNIN_PATH}>Sign in</a> first — the agent acts as whoever is signed in on this
          browser, and there is nobody yet.
        </p>
      )}
      {session && !session.gateway ? (
        <p style={{ fontSize: "0.875rem" }}>
          {/* Which of the two absences it is, because they read differently and
              #94 is what happens when they do not. */}
          {session.gateway_rejected_at
            ? "Signed in, but the gateway rejected this browser's token, so it was dropped."
            : "Signed in, but this browser holds no gateway token."}{" "}
          <a href={GATEWAY_START_PATH}>Authorize the gateway</a>.
        </p>
      ) : null}

      <PersonaToolList session={session} tools={tools} />

      {/* Resolved on the server: `NEXT_PUBLIC_*` is inlined at build time and
          Render supplies the environment at runtime, so the browser is handed
          the address rather than working it out (#81, #20). */}
      <Chat signedInAs={session?.email ?? null} approvalStreamUrl={approvalStreamUrl(process.env)} />
    </main>
  );
}

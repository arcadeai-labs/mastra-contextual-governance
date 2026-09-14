/**
 * Placeholder. The real thing is a split screen: a deliberately boring
 * enterprise loan app on the left, the Arcade control plane on the right.
 * The shell lands in #22, the control-plane panel in #21.
 *
 * Since #82 it carries one real thing: the sign-in panel. A server component,
 * so the session is unsealed on the server and only the email and whether a
 * gateway token exists ever reach the browser.
 *
 * #15 adds the second: the persona's role and authority, and the tools the
 * gateway answered `tools/list` with for them. It is here as well as on `/chat`
 * because this is where the sign-in and the gateway hop *land* — a presenter
 * who has just signed in as Sam should be looking at Sam's tool list, not
 * clicking through to find it.
 */
import { cookies } from "next/headers";

import { configurationProblems, readIdentitySurface } from "../lib/config.ts";
import { readSessionFromCookies } from "../lib/identity/session.ts";
import { sessionTools } from "../lib/agent/tool-list.ts";
import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import { SignInPanel } from "../components/identity/SignInPanel.tsx";

const SERVICES = [
  ["apps/web", "this app — chat, persona switcher, approval page, panel"],
  ["apps/hooks", "the control plane — /access, /pre, /post, audit, SSE"],
  ["apps/loan-app", "the governed business system — a plain HTTP API"],
  ["tools/loan", "Python arcade-mcp toolkit — the loan tools, ships via arcade deploy"],
  ["tools/approvals", "Python arcade-mcp toolkit — ships via arcade deploy"],
] as const;

/**
 * Dynamic, because it reads a session cookie. Saying so explicitly rather than
 * relying on `cookies()` to infer it keeps `next build` from evaluating this
 * component at all — a prerender of a page about who is signed in is either
 * wrong or empty, and it runs under `NODE_ENV=production` with none of the
 * deployment's environment.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  // No session means no network call: `sessionTools` answers without asking.
  const tools = await sessionTools(session, { config });

  return (
    <main
      style={{
        maxWidth: "42rem",
        margin: "0 auto",
        padding: "4rem 1.5rem",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        Scaffold
      </p>
      <h1 style={{ fontSize: "1.75rem", margin: "0.5rem 0 1rem" }}>
        Contextual Governance — Mastra × Arcade
      </h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Every service is a stub that serves a health endpoint. Nothing else. The
        point of this slice is that the deploy pipeline works before any logic
        goes into it.
      </p>

      <SignInPanel session={session} problems={configurationProblems(config)} />

      <PersonaToolList session={session} tools={tools} />

      <ul style={{ listStyle: "none", padding: 0, marginTop: "2rem" }}>
        {SERVICES.map(([name, role]) => (
          <li
            key={name}
            style={{ borderTop: "1px solid var(--line)", padding: "0.75rem 0" }}
          >
            <code style={{ fontSize: "0.875rem" }}>{name}</code>
            <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
              {role}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

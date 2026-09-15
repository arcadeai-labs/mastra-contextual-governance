/**
 * What a visitor sees when this deployment is only half configured.
 *
 * Round 2 of #84's review ran a built cg-web with sign-in configured and
 * `ARCADE_GATEWAY_ID` and `ARCADE_API_KEY` absent. `/health` answered
 * `{"status":"ok", … "gateway":"missing","verifier":"missing"}` and `GET /`
 * rendered the ordinary persona buttons and `Gateway token: none` with no
 * warning anywhere. The process stayed Ready, Render kept it in rotation, and
 * the only way to discover that no tool call could ever be made was to click
 * into a flow and read a 503.
 *
 * That is the failure mode this whole project argues against, in our own UI: a
 * control that is not there, presented as one that is. So the same sentences
 * now reach three surfaces — the 503 pages, `/health`, and a red banner in
 * front of whoever opens the page — and all three come from `lib/config.ts`,
 * which is what stops them describing different deployments.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  configurationProblems,
  deploymentReadiness,
  isMisconfigured,
  readIdentitySurface,
} from "../lib/config.ts";
import { SignInPanel } from "../components/identity/SignInPanel.tsx";

/** `openssl rand -hex 32`, written out so this suite's green is not a sample. */
const GOOD_SECRET = "3f9a1c7e5b2d84069a1fe73c05b8d42e6c917ab3fd50e28c47196baf3d0c5e81";

/** Everything a cg-web needs. Individual tests take keys away. */
const COMPLETE = {
  IDP_ISSUER: "https://cg-idp-or5b.onrender.com",
  IDP_CLIENT_ID: "client-c",
  IDP_CLIENT_SECRET: "client-c-secret",
  SESSION_SECRET: GOOD_SECRET,
  PUBLIC_URL: "https://cg-web-sa31.onrender.com",
  ARCADE_GATEWAY_ID: "cg-demo-us",
  ARCADE_API_KEY: "arcade-key",
  // The agent, since #14. In this list for the same reason as the rest: a
  // cg-web without it signs Alice in, holds a gateway token, and then the chat
  // page fails at the point of use.
  ANTHROPIC_API_KEY: "anthropic-key",
} as const;

function render(env: Record<string, string>): string {
  const config = readIdentitySurface(env);
  return renderToStaticMarkup(
    <SignInPanel session={null} problems={configurationProblems(config)} />,
  );
}

/** Tags stripped, whitespace collapsed — what a person actually reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("the banner, with ARCADE_GATEWAY_ID absent", () => {
  const { ARCADE_GATEWAY_ID, ...withoutGateway } = COMPLETE;

  test("it appears, and names the missing variable in the visitor's face", () => {
    const html = render(withoutGateway);

    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("This deployment is not fully configured");
    expect(text(html)).toContain("The gateway hop is not configured");
    // The same sentence `gatewayProblems` produces for the 503 page. One source.
    expect(text(html)).toContain("ARCADE_GATEWAY_ID is not set");
    expect(configurationProblems(readIdentitySurface(withoutGateway)).gateway).toContain(
      "ARCADE_GATEWAY_ID is not set",
    );
  });

  test("sign-in still works, so its buttons stay live", () => {
    const html = render(withoutGateway);
    // Only the gateway is broken. Disabling the personas here would say the
    // wrong thing — a visitor can sign in, and finding out how far they get is
    // the point of the banner above them.
    expect(html).toContain(`href="/api/auth/signin?persona=dana"`);
    expect(html).not.toContain("disabled");
  });

  test("the banner does not repeat sign-in's problems under every heading", () => {
    // `gatewayProblems` is a superset of `signinProblems` by construction.
    // Printing five identical sentences under two headings is how a banner
    // becomes something people stop reading.
    const problems = configurationProblems(readIdentitySurface({ PUBLIC_URL: COMPLETE.PUBLIC_URL }));
    expect(problems.signin).toContain("IDP_ISSUER is not set");
    expect(problems.gateway).not.toContain("IDP_ISSUER is not set");
    expect(problems.gateway).toContain("ARCADE_GATEWAY_ID is not set");
  });
});

describe("the banner, with sign-in itself broken", () => {
  const { IDP_CLIENT_SECRET, ...withoutClientC } = COMPLETE;

  test("the persona buttons are disabled rather than hidden", () => {
    const html = render(withoutClientC);

    // Inert, not absent: hiding them would leave a visitor wondering whether
    // this demo has personas at all.
    expect(html).toContain("disabled");
    expect(html).not.toContain(`href="/api/auth/signin?persona=dana"`);
    expect(text(html)).toContain("Alice");
    expect(text(html)).toContain("IDP_CLIENT_SECRET is not set");
  });

  test("a SESSION_SECRET that is set but too weak reads as a configuration problem too", () => {
    const html = render({ ...COMPLETE, SESSION_SECRET: "x" });
    expect(text(html)).toContain("at least 32 characters");
    expect(html).toContain("disabled");
  });
});

describe("a fully configured deployment", () => {
  test("no banner, live buttons, and /health says ok", () => {
    const config = readIdentitySurface(COMPLETE);

    expect(isMisconfigured(configurationProblems(config))).toBe(false);
    expect(deploymentReadiness(config)).toEqual({
      status: "ok",
      signin: "configured",
      gateway: "configured",
      verifier: "configured",
      agent: "configured",
    });

    const html = render(COMPLETE);
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain("This deployment is not fully configured");
    expect(html).not.toContain("disabled");
    for (const persona of ["dana", "sam", "riley", "morgan"]) {
      expect(html).toContain(`href="/api/auth/signin?persona=${persona}"`);
    }
  });
});

describe("/health's top-level status", () => {
  test("degraded whenever any capability is missing, ok only when none is", () => {
    // Every one-variable-short deployment, because `status` is the field
    // anybody actually reads and the one that said `ok` on a cg-web that could
    // not make a tool call.
    for (const absent of Object.keys(COMPLETE)) {
      const partial = Object.fromEntries(
        Object.entries(COMPLETE).filter(([key]) => key !== absent),
      ) as Record<string, string>;
      const readiness = deploymentReadiness(readIdentitySurface(partial));
      expect(readiness.status).toBe("degraded");
      // And it is never `degraded` with all three capabilities configured —
      // the two halves of the claim have to agree.
      expect([readiness.signin, readiness.gateway, readiness.verifier, readiness.agent]).toContain(
        "missing",
      );
    }

    expect(deploymentReadiness(readIdentitySurface(COMPLETE)).status).toBe("ok");
  });
});

describe("the banner, with ANTHROPIC_API_KEY absent", () => {
  const { ANTHROPIC_API_KEY, ...withoutModel } = COMPLETE;

  test("it names the agent as the broken capability, and only that one", () => {
    // The failure this heading exists for: identity is perfect, the persona
    // signs in, the gateway token is held — and `/chat` answers 503 the first
    // time somebody presses Send, which on this project means on stage.
    const html = render(withoutModel);

    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("The agent is not configured");
    expect(text(html)).toContain("ANTHROPIC_API_KEY is not set");
    expect(text(html)).not.toContain("Signing in is not configured");
    // Sign-in still works, so its buttons stay live — the same reasoning as
    // the gateway case above.
    expect(html).toContain(`href="/api/auth/signin?persona=dana"`);
    expect(html).not.toContain("disabled");
  });

  test("it does not repeat the gateway's problems under the agent heading", () => {
    // `agentProblems` is a superset of `gatewayProblems` by construction, the
    // same way `gatewayProblems` is a superset of `signinProblems`.
    const problems = configurationProblems(readIdentitySurface({ PUBLIC_URL: COMPLETE.PUBLIC_URL }));
    expect(problems.gateway).toContain("ARCADE_GATEWAY_ID is not set");
    expect(problems.agent).not.toContain("ARCADE_GATEWAY_ID is not set");
    expect(problems.agent).toContain("ANTHROPIC_API_KEY is not set");
  });
});

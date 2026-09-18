/**
 * What `/panel` and `/health` say about which stream this deployment watches.
 *
 * Through the page and through the route, never through the helper alone. #81
 * is not a bug in `resolvePanelStream` — that function did exactly what it was
 * written to do. The bug was that the *page* rendered its answer without
 * saying what the answer was, so a production cg-web replayed #5's fixture over
 * a real governed `Loan_GetLoan` and looked, to everyone in the room, like a
 * control plane watching it. A test of the helper would have stayed green
 * through all of that. These render the component tree the browser gets.
 *
 * `PanelPage` is an async server component: awaiting it yields the element, and
 * `renderToStaticMarkup` gives the markup. `useEffect` does not run under
 * static rendering, so nothing here opens a socket — which is also why the
 * "nothing is streamed" claim below is asserted as the absence of the panel
 * itself rather than as an absence of events.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import PanelPage from "../app/panel/page.tsx";
import { GET as health } from "../app/health/route.ts";
import { resolvePanelStream } from "../lib/governance/stream-url.ts";

/**
 * The variables that decide the panel's stream, and the only ones these tests
 * touch. Named explicitly because `apps/web/.env.local` sets `HOOKS_PUBLIC_HOST`
 * for a local run, so a case that means "unset" has to say so.
 */
const STREAM_KEYS = [
  "GOVERNANCE_STREAM",
  "HOOKS_PUBLIC_HOST",
  "NODE_ENV",
  "RENDER",
  // Identity and the agent, because `/health`'s `status` folds five fields
  // together and "degraded" proves nothing about the panel on a deployment
  // where sign-in is also unset — which is every deployment this suite builds
  // by default. `ANTHROPIC_API_KEY` is here for the same reason and one more:
  // it may well be set in the ambient environment of whoever runs the suite
  // (see `test/model.ts`), so a case that means "configured" has to say so
  // rather than inherit it.
  "IDP_ISSUER",
  "IDP_CLIENT_ID",
  "IDP_CLIENT_SECRET",
  "SESSION_SECRET",
  "PUBLIC_URL",
  "ARCADE_GATEWAY_ID",
  "ARCADE_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * `process.env`, writable. TypeScript types `NODE_ENV` as read-only — for good
 * reason in application code, and these tests exist precisely to render the
 * page as a deployment would.
 */
const env = process.env as Record<string, string | undefined>;

const original = Object.fromEntries(STREAM_KEYS.map((key) => [key, env[key]]));

afterEach(() => {
  for (const key of STREAM_KEYS) {
    const was = original[key];
    if (was === undefined) delete env[key];
    else env[key] = was;
  }
});

/** `env` exactly: every key this suite owns and is not given is unset. */
function setEnv(wanted: Partial<Record<(typeof STREAM_KEYS)[number], string>>): void {
  for (const key of STREAM_KEYS) {
    const value = wanted[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

type Env = Partial<Record<(typeof STREAM_KEYS)[number], string>>;

async function panel(wanted: Env, params: Record<string, string> = {}): Promise<string> {
  setEnv(wanted);
  return renderToStaticMarkup(await PanelPage({ searchParams: Promise.resolve(params) }));
}

async function healthBody(wanted: Env): Promise<Record<string, unknown>> {
  setEnv(wanted);
  return (await health().json()) as Record<string, unknown>;
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

/** The deployed shape, which is what `apps/web/Dockerfile` sets on the runner. */
const DEPLOYED = { NODE_ENV: "production" } as const;
const HOOKS_HOST = "cg-hooks.onrender.com";

/**
 * Everything the other three capabilities need, so a `degraded` below is the
 * panel's doing and nothing else's. `openssl rand -hex 32`, written out.
 */
const IDENTITY = {
  IDP_ISSUER: "https://cg-idp-or5b.onrender.com",
  IDP_CLIENT_ID: "client-c",
  IDP_CLIENT_SECRET: "client-c-secret",
  SESSION_SECRET: "3f9a1c7e5b2d84069a1fe73c05b8d42e6c917ab3fd50e28c47196baf3d0c5e81",
  PUBLIC_URL: "https://cg-web-sa31.onrender.com",
  ARCADE_GATEWAY_ID: "cg-demo-us",
  ARCADE_API_KEY: "arcade-key",
  // The agent capability (#14), which `/health` counts alongside the three
  // identity ones. In this fixture for the same reason every other value here
  // is: these tests are about `panel_stream`, and without it `status` would be
  // `degraded` for a reason that has nothing to do with the panel.
  ANTHROPIC_API_KEY: "anthropic-key",
} as const;

describe("a deployed panel that was never told which stream to watch", () => {
  // The measured state of https://cg-web-sa31.onrender.com/panel on
  // 2026-09-11: `render.yaml` declared HOOKS_PUBLIC_HOST and never declared
  // GOVERNANCE_STREAM, so the page served `mode: "fixture"` over a live
  // control plane and said nothing about it.
  const deployed = { ...DEPLOYED, HOOKS_PUBLIC_HOST: HOOKS_HOST } as const;

  test("the page is an error state that names the variable", async () => {
    const markup = await panel(deployed);

    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("This panel is not watching anything");
    expect(text(markup)).toContain("GOVERNANCE_STREAM is not set");
  });

  test("nothing is replayed in its place", async () => {
    const markup = await panel(deployed);

    // The panel is not rendered at all, so there is no subscription to open and
    // no lane for a fixture event to land in. A banner above a running replay
    // would leave the rows on screen, and the rows are the lie.
    // Was `cg-tally` until #158 cut that row; the counters it stood for are the
    // lane headers' now, and the claim is the same one — no count of anything
    // is drawn, because there is nothing to count.
    expect(markup).not.toContain("cg-lane-count");
    expect(markup).not.toContain("cg-lanes");
    expect(markup).not.toContain("<article");
    expect(markup).not.toContain("/api/governance/fixture-stream");
    expect(markup).not.toContain("FIXTURE REPLAY");
  });

  test("/health reports panel_stream unconfigured, and degrades on it", async () => {
    const body = await healthBody(deployed);

    expect(body.panel_stream).toBe("unconfigured");
    expect(body.status).toBe("degraded");
    expect(body.service).toBe("web");
  });

  test("an otherwise perfect deployment is degraded by the panel alone", async () => {
    // The point of the field. With identity fully configured, `status` used to
    // read `ok` on the very cg-web whose panel was replaying a fixture.
    const body = await healthBody({ ...IDENTITY, ...deployed });

    expect(body).toMatchObject({
      status: "degraded",
      signin: "configured",
      gateway: "configured",
      verifier: "configured",
      agent: "configured",
      panel_stream: "unconfigured",
    });
  });

  test("and is `ok` again once it is told which stream to watch", async () => {
    const body = await healthBody({ ...IDENTITY, ...deployed, GOVERNANCE_STREAM: "hooks" });

    expect(body).toMatchObject({ status: "ok", panel_stream: "live" });
  });

  test("the same is true when the host is missing too", async () => {
    expect(text(await panel(DEPLOYED))).toContain("GOVERNANCE_STREAM is not set");
    expect((await healthBody(DEPLOYED)).panel_stream).toBe("unconfigured");
  });

  test("asking for hooks without a host names the host variable instead", async () => {
    const asked = { ...DEPLOYED, GOVERNANCE_STREAM: "hooks" } as const;

    expect(text(await panel(asked))).toContain("HOOKS_PUBLIC_HOST is not set");
    expect((await healthBody(asked)).panel_stream).toBe("unconfigured");
  });

  test("a GOVERNANCE_STREAM this service does not understand is refused by name", async () => {
    const typo = { ...DEPLOYED, GOVERNANCE_STREAM: "hook", HOOKS_PUBLIC_HOST: HOOKS_HOST } as const;

    expect(text(await panel(typo))).toContain("GOVERNANCE_STREAM=hook");
    expect((await healthBody(typo)).panel_stream).toBe("unconfigured");
  });
});

describe("fixture mode, asked for on purpose", () => {
  test("GOVERNANCE_STREAM=fixture renders the panel, labelled FIXTURE REPLAY", async () => {
    const markup = await panel({ ...DEPLOYED, GOVERNANCE_STREAM: "fixture" });

    expect(markup).toContain("FIXTURE REPLAY");
    expect(markup).toContain("cg-lanes");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("LIVE ·");
  });

  test("?fixture=1 does the same for one request, on a deployment set to hooks", async () => {
    const live = { ...DEPLOYED, GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: HOOKS_HOST } as const;
    const markup = await panel(live, { fixture: "1" });

    expect(markup).toContain("FIXTURE REPLAY");
    expect(markup).not.toContain(HOOKS_HOST);
  });

  test("/health calls a deliberate replay `fixture`, and does not degrade on it", async () => {
    const body = await healthBody({ ...DEPLOYED, GOVERNANCE_STREAM: "fixture" });

    // A replay somebody chose, and the panel says so on screen. The failure
    // mode #81 records is a replay nobody chose.
    expect(body.panel_stream).toBe("fixture");
  });

  test("a development clone with nothing configured still plays, and still says so", async () => {
    const markup = await panel({});

    expect(markup).toContain("FIXTURE REPLAY");
    expect(markup).toContain("cg-lanes");
  });
});

describe("live mode", () => {
  const live = { ...DEPLOYED, GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: HOOKS_HOST } as const;

  test("the badge says LIVE and names the host on screen", async () => {
    const markup = await panel(live);

    expect(text(markup)).toContain(`LIVE · ${HOOKS_HOST}`);
    expect(markup).not.toContain("FIXTURE REPLAY");
    expect(markup).not.toContain('role="alert"');
  });

  test("the lanes are there, waiting for the control plane rather than a replay", async () => {
    const markup = await panel(live);

    expect(markup).toContain("cg-lanes");
    expect(markup).toContain("No call has been attempted yet.");
    expect(markup).not.toContain("/api/governance/fixture-stream");
  });

  test("/health reports panel_stream live", async () => {
    expect((await healthBody(live)).panel_stream).toBe("live");
  });

  test("a local hook server is live too, and the badge names it", async () => {
    const markup = await panel({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "localhost:4411" });

    expect(text(markup)).toContain("LIVE · localhost:4411");
  });
});

/**
 * The blueprint, because none of the above can make a deployment loud on its
 * own. `render.yaml` decides what the live cg-web's environment contains, and
 * between #21 and #81 it simply never mentioned GOVERNANCE_STREAM — which is
 * why production was in fixture replay by construction rather than by anyone's
 * choice. The panel refuses that state now instead of hiding it; this keeps the
 * blueprint from re-creating it.
 */
describe("what render.yaml gives cg-web", () => {
  const blueprint = Bun.YAML.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "render.yaml"), "utf8"),
  ) as { services: Array<{ name: string; envVars?: Array<Record<string, unknown>> }> };

  const web = blueprint.services.find((service) => service.name === "cg-web");
  const envVars = web?.envVars ?? [];
  const entry = (key: string) => envVars.find((each) => each["key"] === key);

  test("GOVERNANCE_STREAM is declared, as a plain value, and it is hooks", () => {
    // Not `sync: false`: this is neither a credential nor an address, and
    // `hooks` is what a deployment of this blueprint is for every time. Left
    // for a human to fill in, it would be blank on the first deploy — which is
    // the exact state #81 was opened for.
    expect(entry("GOVERNANCE_STREAM")).toEqual({ key: "GOVERNANCE_STREAM", value: "hooks" });
  });

  test("HOOKS_PUBLIC_HOST stays sync: false, because it cannot be derived", () => {
    // onrender.com subdomains are global and Render suffixes a name that is
    // taken (#59: cg-web is cg-web-sa31). A value here would address somebody
    // else's deployment.
    expect(entry("HOOKS_PUBLIC_HOST")).toEqual({ key: "HOOKS_PUBLIC_HOST", sync: false });
  });

  test("and the pair is what the page reads as live", () => {
    // The blueprint's own values, run through the resolution the page runs, so
    // a blueprint that parses but says the wrong thing cannot pass.
    const stream = resolvePanelStream({
      NODE_ENV: "production",
      GOVERNANCE_STREAM: entry("GOVERNANCE_STREAM")?.["value"] as string,
      HOOKS_PUBLIC_HOST: HOOKS_HOST,
    });

    expect(stream.mode).toBe("hooks");
  });
});

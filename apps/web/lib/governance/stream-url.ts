/**
 * Which stream the panel watches, and how its address is worked out.
 *
 * Read in a **server component**, never in the browser. `.env.example` says why
 * at length: `next build` inlines `NEXT_PUBLIC_*` into the client bundle, while
 * Render supplies service environment variables at runtime, so a
 * `NEXT_PUBLIC_HOOKS_HOST` would be `undefined` in the deployed browser and
 * perfectly fine under `next dev` — a difference that shows up first on stage.
 * The panel takes its stream address as a prop instead.
 *
 * **There is no silent fallback to the replay.** Until #81 there was: an
 * unset `GOVERNANCE_STREAM` — and `render.yaml` never declared it, so that was
 * every production deploy since #21 — resolved to the fixture, and the page
 * rendered a replay of #5's sequence with nothing on screen saying so. On
 * 2026-09-11 a human made a real governed call against the live gateway and
 * watched the panel show the demo instead. A control surface reporting
 * something other than reality, looking exactly like one that works, is the
 * failure this project exists to argue against; having it in our own control
 * surface was the worst possible place for it.
 */
import { assertPublicHost } from "../public-host.ts";


/** The no-backend stream, served by this app from #5's fixture sequence. */
export const FIXTURE_STREAM_PATH = "/api/governance/fixture-stream";

/** The hook server's stream, live since #54. See `subscribe.ts` for the frames. */
export const HOOKS_STREAM_PATH = "/events";

export type StreamMode = "fixture" | "hooks";

/**
 * What the badge needs, and no more: which stream the panel is on, and — when
 * it is the live one — the host it is watching. The audience reads this.
 */
export type PanelSource =
  | { readonly mode: "fixture" }
  | { readonly mode: "hooks"; readonly host: string };

/** The built-in replay of #5's sequence. Correct to be in, never a default in production. */
export interface FixtureStream {
  readonly mode: "fixture";
  readonly url: string;
}

/** The real control plane. `host` is carried so the badge can name it on screen. */
export interface LiveStream {
  readonly mode: "hooks";
  readonly url: string;
  readonly host: string;
}

/**
 * No stream at all, and the sentence saying which variable is at fault.
 *
 * Not an exception, deliberately: the panel renders this as an error state that
 * names the variable, which is a thing a presenter can read off a projector,
 * and `/health` reports it as `panel_stream: "unconfigured"`. A thrown error
 * would give a Next.js 500 page and a health check that took the instance out
 * of rotation — loud, but at nobody who could fix it.
 */
export interface UnconfiguredStream {
  readonly mode: "unconfigured";
  readonly problem: string;
}

/** A stream there is something to subscribe to. */
export type WatchableStream = FixtureStream | LiveStream;

export type PanelStream = WatchableStream | UnconfiguredStream;

/** The only values `GOVERNANCE_STREAM` accepts. Anything else is refused by name. */
export const STREAM_VALUES = ["hooks", "fixture"] as const;

/** Hosts are HOST-form (see `.env.example`); the consumer adds the scheme. */
function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}

/**
 * Deployed or not, which is the only thing that changes what an unset
 * `GOVERNANCE_STREAM` means.
 *
 * `NODE_ENV` is what matters in practice — `apps/web/Dockerfile` sets it on the
 * runner stage, so every Render deploy of this service has it. `RENDER` is
 * there for a deployment that runs the Next server some other way; Render sets
 * it on every service it starts.
 */
function isDeployed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["NODE_ENV"] === "production" || env["RENDER"] === "true";
}

function unconfigured(problem: string): UnconfiguredStream {
  return { mode: "unconfigured", problem };
}

/** `?fixture=1` on the page itself — a per-request opt-in a presenter can type. */
function fixtureRequested(params: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const value = params["fixture"];
  const single = Array.isArray(value) ? value[0] : value;
  return single === "1" || single === "true";
}

/**
 * Where to point the panel, given the process environment and the page's own
 * query string.
 *
 * One knob, `GOVERNANCE_STREAM`, with three states:
 *
 * | value | what the panel does |
 * |---|---|
 * | `hooks` | watches `HOOKS_PUBLIC_HOST` — the live control plane. Without a host: **unconfigured** |
 * | `fixture` | replays #5's sequence, labelled `FIXTURE REPLAY` |
 * | unset | the replay in development; **unconfigured** when deployed |
 *
 * Anything else is refused by name rather than resolved to something. A typo on
 * a Render service page would otherwise be a panel quietly showing the demo.
 *
 * **The replay stays the default in development on purpose.** `apps/hooks` does
 * serve `/events` — the stream half of #20 landed on #54 — but it is a second
 * service with a database of its own, and most of the time a fresh clone does
 * not have it running. Defaulting to it would open the panel on a connection
 * retrying against nothing, which reads as a broken app rather than as a
 * control plane that has not been started. That reasoning does not survive a
 * deploy: a deployed panel is in front of an audience, has a control plane to
 * watch, and must never answer the question "is this real?" with a replay.
 */
export function resolvePanelStream(
  env: Readonly<Record<string, string | undefined>>,
  params: Readonly<Record<string, string | string[] | undefined>> = {},
): PanelStream {
  // Checked whichever mode wins. A bare service name is wrong the moment it is
  // set, and this is the address the *browser* is handed — so the alternative
  // to refusing here is a failed EventSource in a visitor's console. See
  // `../public-host.ts`.
  assertPublicHost("HOOKS_PUBLIC_HOST", env["HOOKS_PUBLIC_HOST"]);

  const host = env["HOOKS_PUBLIC_HOST"]?.trim() ?? "";
  const requested = env["GOVERNANCE_STREAM"]?.trim() ?? "";

  // Before the query string, so `?fixture=1` cannot paper over a variable that
  // is set to something this service does not understand.
  if (requested !== "" && !(STREAM_VALUES as readonly string[]).includes(requested)) {
    return unconfigured(
      `GOVERNANCE_STREAM=${requested} is not a stream this panel can watch. ` +
        "Set it to `hooks` (with HOOKS_PUBLIC_HOST) to watch the live control plane, " +
        "or to `fixture` for the built-in replay.",
    );
  }

  if (fixtureRequested(params) || requested === "fixture") {
    return withFixtureParams({ mode: "fixture", url: FIXTURE_STREAM_PATH }, params);
  }

  if (requested === "hooks") {
    if (host === "") {
      return unconfigured(
        "GOVERNANCE_STREAM=hooks, but HOOKS_PUBLIC_HOST is not set, so there is no address " +
          "to watch. Read the host off the cg-hooks service page in the Render dashboard " +
          "(the host part of the URL shown there) and set it on this service.",
      );
    }
    return { mode: "hooks", url: `${baseUrl(host)}${HOOKS_STREAM_PATH}`, host };
  }

  if (isDeployed(env)) {
    return unconfigured(
      "GOVERNANCE_STREAM is not set. A deployed panel is told which stream to watch rather " +
        "than guessing: set it to `hooks`, with HOOKS_PUBLIC_HOST, for the live control " +
        "plane, or to `fixture` to say on screen that this is a replay.",
    );
  }

  return withFixtureParams({ mode: "fixture", url: FIXTURE_STREAM_PATH }, params);
}

/**
 * What `/health` reports for `panel_stream`, from the same resolution the page
 * runs — so the two can never describe different deployments.
 *
 * The `PublicHostError` a bare service name raises is caught and reported as
 * `unconfigured` rather than propagated. `/health` must answer `200` whatever
 * it finds: Render reads a non-200 on `healthCheckPath` as a dead instance and
 * abandons the deploy, which would take away the one endpoint that says what is
 * wrong. The page still throws on that value, loudly, where a developer sees it.
 */
export function panelStreamHealth(
  env: Readonly<Record<string, string | undefined>>,
): "live" | "fixture" | "unconfigured" {
  try {
    const stream = resolvePanelStream(env);
    return stream.mode === "hooks" ? "live" : stream.mode === "fixture" ? "fixture" : "unconfigured";
  } catch {
    return "unconfigured";
  }
}

/**
 * Where the chat watches for `approval.granted`, or `null` when there is
 * nowhere to watch (#20).
 *
 * The live control plane only. A fixture replay carries #5's governance
 * sequence and no approval frames at all, and an unconfigured panel has no
 * address — in both cases a turn that ends waiting stays ended, the card on
 * screen says so, and nothing polls. Silently resuming off a replay would be
 * the panel's own failure mode (#81) in the chat.
 *
 * Derived from `resolvePanelStream` rather than read separately, so the two
 * surfaces can never describe different deployments.
 */
export function approvalStreamUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  try {
    const stream = resolvePanelStream(env);
    return stream.mode === "hooks" ? stream.url : null;
  } catch {
    // A bare service name in `HOOKS_PUBLIC_HOST`. The page throws on it loudly
    // where a developer sees it; this is asked from the same page and must not
    // throw twice.
    return null;
  }
}

/** The knobs the fixture stream understands. See its route for what they do. */
const FIXTURE_PARAMS = ["delayMs", "repeat", "fanout"] as const;

/**
 * `source` with the fixture stream's own parameters carried over from the
 * page's query string, so `/panel?repeat=2000&delayMs=0` is a burst a
 * presenter can rehearse against and a reviewer can watch, and
 * `/panel?fanout=1` is the measured `/access` fan-out landing in one row.
 *
 * Only in fixture mode. The hook server's stream is not ours to add query
 * parameters to, and a stray `repeat` on it would be meaningless at best.
 */
export function withFixtureParams(
  source: WatchableStream,
  params: Readonly<Record<string, string | string[] | undefined>>,
): WatchableStream {
  if (source.mode !== "fixture") return source;

  const query = new URLSearchParams();
  for (const name of FIXTURE_PARAMS) {
    const value = params[name];
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== "") query.set(name, single);
  }

  const suffix = query.toString();
  return suffix === "" ? source : { ...source, url: `${source.url}?${suffix}` };
}

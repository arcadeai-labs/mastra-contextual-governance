/**
 * The strip over the lanes, mounted in a real DOM (#106).
 *
 * `renderToStaticMarkup` — what every other panel test here uses — cannot ask
 * the two questions that matter about this component. It polls, so its first
 * frame is "checking"; and it confirms before acting, so the claim is that
 * pressing Reset sends *nothing* until a second press. Both are about state
 * over time, so this file mounts it against a route served on a port the OS
 * picked and counts what actually reached the wire.
 *
 * The route is a stand-in for `app/api/governance/control-plane/route.ts`
 * rather than the route itself: that handler's own behaviour against a real
 * control plane is `control-plane-route.test.ts`, and what is under test here
 * is the surface a presenter presses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { ControlPlaneReport } from "../lib/governance/control-plane.ts";

// Bun's own, captured before happy-dom replaces the globals — `Bun.serve`
// refuses a `Response` that is not Bun's. Same reason as `chat-rendering`.
const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeResponse = globalThis.Response;

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register({ url: "http://panel.test/" });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ControlPlaneStatus } = await import("../components/governance/ControlPlaneStatus.tsx");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEALTHY: ControlPlaneReport = {
  reachable: true,
  host: "cg-hooks.onrender.com",
  status: "healthy",
  policy: { status: "ready", revision: 125, error: null },
  fixture_drift: null,
  injection_detection: { state: "armed", patterns: 6 },
  reset: "enabled",
  warnings: [],
};

const DRIFTED: ControlPlaneReport = {
  ...HEALTHY,
  status: "degraded",
  fixture_drift: {
    ids: ["output_rules:post.strip-injected-instructions"],
    changed: ["output_rules:post.strip-injected-instructions"],
    missing: [],
    unexpected: [],
  },
  warnings: ["the policy on disk differs from the fixture shipped in this image"],
};

const FAILED: ControlPlaneReport = {
  ...HEALTHY,
  status: "degraded",
  policy: {
    status: "failed",
    revision: 52,
    error: 'reason names "Approvals.RequestApproval", the spelling hook payloads use',
  },
};

const UNREACHABLE: ControlPlaneReport = {
  reachable: false,
  host: "cg-hooks.onrender.com",
  reset: "enabled",
  problem: "cg-hooks.onrender.com did not answer GET /health (ConnectionRefused).",
};

interface Posted {
  readonly mode: unknown;
}

let report: ControlPlaneReport = HEALTHY;
let posts: Posted[] = [];
let endpoint = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        posts.push((await request.json()) as Posted);
        return NativeResponse.json({ ok: true, detail: "Policy reset from the fixture.", report });
      }
      return NativeResponse.json(report);
    },
  });
  endpoint = `http://localhost:${server.port}/api/governance/control-plane`;
  // The component asks for its own origin's route; only the origin is supplied.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(String(input), init)) as typeof fetch;
});

afterAll(async () => {
  server?.stop(true);
  // Both halves, and both matter: `bun test` runs every file in this service
  // in one process, so a `fetch` left pointing at this file's stand-in and a
  // DOM left registered are inherited by whichever suite runs next.
  globalThis.fetch = nativeFetch;
  await GlobalRegistrator.unregister();
});

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) {
    await act(async () => each.root.unmount());
    each.host.remove();
  }
  posts = [];
  report = HEALTHY;
});

/** Mounts the strip and waits for its first poll to land. */
async function mount(props: { defaultMode?: "policy" | "demo" } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(<ControlPlaneStatus endpoint={endpoint} pollMs={60_000} {...props} />);
  });
  // One more turn for the fetch the effect started.
  await act(async () => {
    await Bun.sleep(30);
  });
  return host;
}

const buttons = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll("button")] as unknown as HTMLButtonElement[];

const labelled = (host: HTMLElement, text: string): HTMLButtonElement => {
  const found = buttons(host).find((button) => button.textContent?.trim() === text);
  if (found === undefined) {
    throw new Error(
      `no button labelled "${text}"; found: ${buttons(host).map((b) => b.textContent).join(", ")}`,
    );
  }
  return found;
};

const click = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => {
    button.click();
    await Bun.sleep(30);
  });
};

// ---------------------------------------------------------------------------

describe("what it says", () => {
  test("a healthy control plane is still named, so the warning has something to replace", async () => {
    const host = await mount();

    expect(host.textContent).toContain("HEALTHY");
    expect(host.textContent).toContain("cg-hooks.onrender.com");
    expect(host.textContent).toContain("revision 125");
    expect(host.textContent).not.toContain("Fixture drift");
    expect(host.querySelector("[data-state='healthy']")).not.toBeNull();
  });

  test("drift names every differing row, and says why it is ambiguous", async () => {
    report = DRIFTED;
    const host = await mount();

    expect(host.textContent).toContain("DEGRADED");
    expect(host.textContent).toContain("Fixture drift");
    expect(host.textContent).toContain("output_rules:post.strip-injected-instructions");
    // The sentence that keeps a presenter from reading it as either one alone.
    expect(host.textContent).toContain("meant to survive");
    expect(host.textContent).toContain("never reached the disk");
    expect(host.querySelector("[role='alert']")).not.toBeNull();
  });

  test("a policy that will not compile says every call is being refused, and quotes the error", async () => {
    report = FAILED;
    const host = await mount();

    expect(host.textContent).toContain("being refused");
    expect(host.textContent).toContain("Approvals.RequestApproval");
  });

  /**
   * The failure this component exists for. A strip that disappeared when the
   * control plane did would leave a panel full of old cards and nothing saying
   * the service behind them had stopped answering.
   */
  test("an unreachable control plane renders louder, not less", async () => {
    report = UNREACHABLE;
    const host = await mount();

    expect(host.textContent).toContain("UNREACHABLE");
    expect(host.textContent).toContain("ConnectionRefused");
    expect(host.querySelector("[data-state='unreachable']")).not.toBeNull();
    expect(host.querySelector("[role='alert']")).not.toBeNull();
  });
});

describe("the Reset control", () => {
  test("is not rendered at all when this service holds no token", async () => {
    report = { ...HEALTHY, reset: "no-token" };
    const host = await mount();

    expect(buttons(host)).toHaveLength(0);
    expect(host.textContent).toContain("HEALTHY");
  });

  test("is not rendered when cg-hooks has no endpoint, and says which service to fix", async () => {
    report = { ...DRIFTED, reset: "upstream-disabled" };
    const host = await mount();

    // Neither control, including the resync that lives inside the warning.
    expect(buttons(host)).toHaveLength(0);
    expect(host.textContent).toContain("RESET_TOKEN");
    expect(host.textContent).toContain("does not exist there");
    // The warning still renders: the drift is real whether or not anybody on
    // this deployment is able to act on it.
    expect(host.textContent).toContain("Fixture drift");
  });

  /**
   * The human's decision on #106: the unlabelled button a presenter reaches
   * for between takes is the FULL rehearsal reset. Mounted with no
   * `defaultMode` at all, so what is pinned here is the component's own
   * default rather than a value this test handed it — the previous version of
   * this file passed `defaultMode: "demo"` explicitly and would have stayed
   * green through a regression to `policy`.
   */
  test("the Reset button runs the full rehearsal reset by default", async () => {
    const host = await mount();

    await click(labelled(host, "Reset"));
    expect(posts).toEqual([]);
    expect(host.querySelector("[role='alertdialog']")).not.toBeNull();

    await click(labelled(host, "Reset the demo"));
    expect(posts).toEqual([{ mode: "demo" }]);
  });

  /**
   * Four tables named, and the one that is not. A presenter presses this
   * under time pressure; the sentence is the only thing between them and an
   * emptied audit log they did not mean to empty.
   */
  test("the confirmation says in words what demo wipes, and what it does not", async () => {
    const host = await mount();

    await click(labelled(host, "Reset"));
    const text = host.textContent ?? "";

    expect(text).toContain("the policy");
    expect(text).toContain("grants");
    expect(text).toContain("approval requests");
    expect(text).toContain("the audit log");
    // The one a presenter would otherwise assume moved, named as this
    // control's boundary rather than as a footnote about the demo.
    expect(text).toContain("does NOT touch loans.db");
    expect(text).toContain("not reset by this control");
  });

  test("confirms before it acts, and sends nothing until it is confirmed", async () => {
    const host = await mount({ defaultMode: "policy" });

    await click(labelled(host, "Reset"));
    expect(posts).toEqual([]);
    // The narrow mode's confirmation names what survives as well as what goes.
    expect(host.textContent).toContain("audit log are kept");
    expect(host.querySelector("[role='alertdialog']")).not.toBeNull();

    await click(labelled(host, "Replace the policy"));
    expect(posts).toEqual([{ mode: "policy" }]);
    expect(host.textContent).toContain("Policy reset from the fixture.");
  });

  test("cancelling sends nothing and puts the strip back", async () => {
    const host = await mount();

    await click(labelled(host, "Reset"));
    await click(labelled(host, "Cancel"));

    expect(posts).toEqual([]);
    expect(host.querySelector("[role='alertdialog']")).toBeNull();
    expect(buttons(host).map((b) => b.textContent)).toContain("Reset");
  });

  test("the default mode is overridable, and is what the button confirms and posts", async () => {
    const host = await mount({ defaultMode: "policy" });

    await click(labelled(host, "Reset"));
    await click(labelled(host, "Replace the policy"));
    expect(posts).toEqual([{ mode: "policy" }]);
  });

  /**
   * The other half of the human's decision: the narrow reset is the drift
   * warning's own remedy, one click, posting `policy` — not the big button
   * wearing a different label.
   */
  test("the drift warning offers a one-click resync, and it posts policy", async () => {
    report = DRIFTED;
    const host = await mount();

    await click(labelled(host, "Resync policy"));
    await click(labelled(host, "Replace the policy"));
    expect(posts).toEqual([{ mode: "policy" }]);
  });

  test("the resync sits inside the drift warning, not in the action row", async () => {
    report = DRIFTED;
    const host = await mount();

    const warning = host.querySelector(".cg-control-plane-drift");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("Resync policy");
    // And the two are distinct controls rather than one relabelled: both are
    // on screen at once, and they post different modes.
    expect(buttons(host).map((b) => b.textContent)).toEqual(["Resync policy", "Reset"]);
  });

  test("no drift, no resync button", async () => {
    const host = await mount();
    expect(buttons(host).map((b) => b.textContent)).toEqual(["Reset"]);
  });

  /**
   * One variable, both surfaces. An unset `RESET_TOKEN` must not leave the
   * resync reachable because it happens to live in a different block from the
   * button — this is the case that regressed when the resync moved.
   */
  test("no token takes BOTH controls away, drift and all", async () => {
    report = { ...DRIFTED, reset: "no-token" };
    const host = await mount();

    expect(buttons(host)).toHaveLength(0);
    // The warning itself still renders: the drift is real whether or not
    // anybody on this deployment can act on it.
    expect(host.textContent).toContain("Fixture drift");
    expect(host.textContent).toContain("output_rules:post.strip-injected-instructions");
  });
});

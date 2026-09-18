/**
 * #129's live panel boundary, end to end.
 *
 * Governed reads land before the browser hydrates the panel. This mounts the
 * real `ControlPlanePanel` after those reads complete, against the real hooks
 * subprocess and its real SSE endpoint, and asserts that the panel recovers the
 * committed rows through its initial replay.
 *
 * The reads used to be the ones `app/page.tsx` made while rendering. #157 moved
 * the loan cards off the MCP path, so a page load makes no tool call at all and
 * there would be nothing for the panel to recover. They are made here instead,
 * on the same real MCP session `lib/agent/tool-list.ts` opens for the chat —
 * which is what the rows on a live panel come from now.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MORGAN, SAM, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
// `homeSurface` for #156's listing, which is still exactly what one page load
// asks the gateway for; `sessionSurface` for the governed reads below, which a
// page load no longer makes at all since #157.
import { homeSurface } from "../lib/home/surface.ts";
import { sessionSurface } from "../lib/agent/tool-list.ts";
import type { Session } from "../lib/identity/session.ts";

// Keep the network implementation captured before happy-dom replaces browser
// globals. The stream still crosses a real socket; this only gives relative
// requests from the health strip a resolvable origin.
const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const NativeHeaders = globalThis.Headers;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTextDecoderStream = globalThis.TextDecoderStream;
const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register({ url: "http://panel.test/" });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ControlPlanePanel } = await import("../components/governance/ControlPlanePanel.tsx");

let harness: AgentHarness;

beforeAll(async () => {
  harness = await startAgentHarness();
  // MCPClient and the real Bun server need the runtime's fetch classes to
  // agree. Keep happy-dom for DOM APIs, but use native network primitives for
  // the governed page load and the SSE response body.
  globalThis.Response = NativeResponse;
  globalThis.Request = NativeRequest;
  globalThis.Headers = NativeHeaders;
  globalThis.ReadableStream = NativeReadableStream;
  globalThis.TextDecoderStream = NativeTextDecoderStream;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const value = String(input);
    // ControlPlaneStatus uses a relative route owned by cg-web. It is not the
    // boundary under test here, but returning a normal response keeps its
    // polling effect from producing an unhandled relative-URL failure.
    if (value.startsWith("/")) {
      return Promise.resolve(
        NativeResponse.json({
          reachable: false,
          host: "panel.test",
          problem: "health strip not under test",
          reset: "no-token",
        }),
      );
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
}, 60_000);

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await harness?.stop();
  await GlobalRegistrator.unregister();
});

function sessionFor(email: string): Session {
  return {
    email,
    signed_in_at: Date.now(),
    gateway: {
      access_token: harness.tokenFor(email),
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-panel-live-test",
    },
  };
}

/**
 * Two real governed `Loan_GetLoan` calls, on one real MCP session.
 *
 * The same path the chat takes: `sessionSurface` lists the persona's tools
 * through `/access` and runs the call the listing produced, so every row this
 * test then looks for was written by the real hooks deciding a real call.
 */
async function readTwoLoans(email: string): Promise<void> {
  const { inside } = await sessionSurface(
    sessionFor(email),
    async (listing) => {
      const tool = listing.tools["Loan_GetLoan"] as { execute: (input: unknown) => Promise<unknown> } | undefined;
      if (tool === undefined) throw new Error("the gateway advertised no Loan_GetLoan");
      for (const loanId of ["LN-2291", "LN-2299"]) await tool.execute({ loan_id: loanId });
      return true;
    },
    { config: harness.config },
  );
  if (inside !== true) throw new Error("the gateway session did not produce a listing");
}

async function until(predicate: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("the hydrated live panel", () => {
  test("shows both Loan_GetLoan reads made before hydration", async () => {
    const before = await harness.audit();
    const beforeIds = new Set(before.map((row) => String(row.id)));
    await readTwoLoans(MORGAN);

    const after = await harness.audit();
    const expectedIds = after
      .filter(
        (row) =>
          !beforeIds.has(String(row.id)) &&
          row.user_id === MORGAN &&
          row.tool === "Loan.GetLoan" &&
          (row.hook === "pre" || row.hook === "post"),
      )
      .map((row) => String(row.id));
    expect(expectedIds).toHaveLength(4);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ControlPlanePanel
            stream={{ mode: "hooks", url: `http://${harness.hooksHost}/events`, host: harness.hooksHost }}
          />,
        );
      });

      await until(
        () => expectedIds.every((id) => container.querySelector(`[data-event-id="${id}"]`) !== null),
        "both server-rendered loan reads in the live panel",
      );

      const cards = expectedIds.map((id) => container.querySelector(`[data-event-id="${id}"]`));
      expect(cards.every((card) => card?.querySelector(".cg-tool")?.textContent === "Loan.GetLoan")).toBe(true);
    } finally {
      root.unmount();
      container.remove();
    }
  });

  /**
   * #156 in the browser rather than in a render-to-string: the same page load,
   * the same real SSE stream, and what the Access lane actually mounts.
   *
   * The listing is asserted by its members, not by counting cards in the lane —
   * the stream replays everything the hooks subprocess has ever written, so
   * another persona's listing is legitimately on screen beside this one.
   */
  test("one persona's listing mounts as one Access card naming what it hid", async () => {
    const before = new Set((await harness.audit()).map((row) => String(row.id)));
    const surface = await homeSurface(sessionFor(SAM), { config: harness.config });
    expect(surface.tools.ok).toBe(true);

    const listing = (await harness.audit()).filter(
      (row) => !before.has(String(row.id)) && row.user_id === SAM && row.hook === "access",
    );
    // Six governed tools decided in one burst, one of them hidden.
    expect(listing.length).toBeGreaterThan(1);
    const ids = listing.map((row) => String(row.id));
    const newest = ids[0] as string;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ControlPlanePanel
            stream={{ mode: "hooks", url: `http://${harness.hooksHost}/events`, host: harness.hooksHost }}
          />,
        );
      });

      await until(
        () => container.querySelector(`[data-event-id="${newest}"]`) !== null,
        "the analyst's listing in the live panel",
      );

      const cards = [...container.querySelectorAll('section[aria-labelledby="cg-lane-access"] article')];
      const mine = cards.filter((card) => ids.some((id) => card.textContent?.includes(id)));

      // Every decision in the burst is on one card, and that card is a listing.
      expect(mine).toHaveLength(1);
      const card = mine[0] as Element;
      expect(card.getAttribute("data-listing")).toBe("true");
      expect(card.querySelector(".cg-tool")?.textContent).toBe("tools/list");
      for (const id of ids) expect(card.textContent).toContain(id);
      expect(card.textContent).toContain("Loan.ApproveLoan");
      expect(card.textContent).toContain("access.analysts-cannot-see-approve");
    } finally {
      root.unmount();
      container.remove();
    }
  });
});

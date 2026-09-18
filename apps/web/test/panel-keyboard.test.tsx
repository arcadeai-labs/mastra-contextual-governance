/**
 * The panel's keyboard surface, exercised on a mounted panel rather than on
 * markup.
 *
 * Two things live here, and both are public surfaces rather than CSS settings:
 *
 * 1. The lane event regions scroll from the keyboard — PageDown/ArrowDown and
 *    the horizontal arrows move the same containers a presenter reaches with
 *    Tab.
 * 2. Since #158 a card's `reason` is **folded**, and a fold that could only be
 *    opened with a pointer would have quietly taken the rule's own words off
 *    this panel for anybody not holding the trackpad. So: closed by default,
 *    the text in the DOM the whole time, and opened by activating a real
 *    `<summary>`.
 *
 *    That last part is why the assertion is on the *element* as well as on the
 *    behaviour. `<summary>` is the one control a browser puts in the tab order
 *    and opens on Enter and Space without a line of our JavaScript; a `<div>`
 *    with an `onClick` would pass a click-based test and be unreachable from a
 *    keyboard. The element is the claim.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { aGovernanceEvent } from "@cg/policy-schema";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ControlPlanePanelView } from "../components/governance/ControlPlanePanelView.tsx";
import { appendEvents, emptyTimeline } from "../lib/governance/timeline.ts";

GlobalRegistrator.register({ url: "http://panel-keyboard.test/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) {
    await act(async () => each.root.unmount());
    each.host.remove();
  }
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** The mounted panel, and the host it is in. */
async function mountPanel(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  const timeline = appendEvents(
    emptyTimeline(),
    Array.from({ length: 12 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}`, hook: "pre", reason: `reason ${index}` }),
    ),
  );
  await act(async () => {
    root.render(
      <ControlPlanePanelView
        timeline={timeline}
        status="live"
        source={{ mode: "fixture" }}
      />,
    );
  });
  return host;
}

async function mount(): Promise<HTMLElement> {
  const host = await mountPanel();

  const region = host.querySelector<HTMLElement>('[aria-label="Pre decisions"]');
  if (region === null) throw new Error("the Pre event region was not rendered");

  // happy-dom does not perform layout. Give the handler the same measurable
  // viewport a browser provides so the test verifies actual page-sized motion.
  Object.defineProperty(region, "clientHeight", { configurable: true, value: 100 });
  return region;
}

function key(region: HTMLElement, key: string, shiftKey = false): void {
  region.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, shiftKey }));
}

describe("keyboard scrolling for long event histories", () => {
  test("PageDown and ArrowUp move the focused lane without a pointer", async () => {
    const region = await mount();

    expect(region.tabIndex).toBe(0);
    expect(region.scrollTop).toBe(0);
    key(region, "PageDown");
    expect(region.scrollTop).toBe(85);
    key(region, "ArrowUp");
    expect(region.scrollTop).toBe(61);
  });

  test("ArrowRight and Shift+Home expose horizontal overflow controls", async () => {
    const region = await mount();

    Object.defineProperty(region, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(region, "scrollWidth", { configurable: true, value: 400 });
    key(region, "ArrowRight");
    expect(region.scrollLeft).toBe(24);
    key(region, "Home", true);
    expect(region.scrollLeft).toBe(0);
  });
});

describe("a card's reason is folded, and the fold is not a pointer", () => {
  /** The first card's `Why` disclosure, and the reason inside it. */
  async function firstWhy(): Promise<{ details: HTMLDetailsElement; summary: HTMLElement }> {
    const host = await mountPanel();
    const details = host.querySelector<HTMLDetailsElement>(".cg-event .cg-why");
    if (details === null) throw new Error("no card carried a Why disclosure");
    const summary = details.querySelector<HTMLElement>("summary");
    if (summary === null) throw new Error("the Why disclosure carried no summary");
    return { details, summary };
  }

  test("it is closed when the card lands", async () => {
    const { details } = await firstWhy();

    expect(details.open).toBe(false);
  });

  test("the rule's words are in the document the whole time, folded or not", async () => {
    const { details } = await firstWhy();

    // A fold, not a truncation and not a fetch. Nothing about this card waits
    // on a click to exist — the panel is photographed as often as it is read.
    expect(details.textContent).toContain("reason 11");
    expect(details.querySelector(".cg-reason")?.textContent).toBe("reason 11");
  });

  test("the control is a native summary, which is what puts it in the tab order", async () => {
    const { details, summary } = await firstWhy();

    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.parentElement).toBe(details);
    expect(details.tagName).toBe("DETAILS");
    // Enter and Space on a focused summary are dispatched by the browser as a
    // click, so activating it is the same event either way — which is exactly
    // why the element has to be the real one.
    expect(summary.textContent).toBe("Why");
  });

  test("activating it opens the fold", async () => {
    const { details, summary } = await firstWhy();

    await act(async () => {
      summary.click();
    });

    expect(details.open).toBe(true);
  });

  test("every card in a lane carries its own fold, closed", async () => {
    const host = await mountPanel();
    const folds = [...host.querySelectorAll<HTMLDetailsElement>(".cg-event .cg-why")];

    expect(folds.length).toBeGreaterThanOrEqual(6);
    expect(folds.every((fold) => !fold.open)).toBe(true);
  });
});

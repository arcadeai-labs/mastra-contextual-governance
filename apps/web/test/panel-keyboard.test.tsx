/**
 * The lane event regions are a public keyboard surface, not just a CSS
 * overflow setting. Exercise the mounted panel so PageDown/ArrowDown and the
 * horizontal arrows actually move the same scroll containers a presenter can
 * focus with Tab.
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

async function mount(): Promise<HTMLElement> {
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

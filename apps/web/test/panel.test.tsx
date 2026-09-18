/**
 * What the panel actually renders.
 *
 * Assertions are on markup, through the component's own props, with nothing
 * mocked. The properties being checked here are the ones the demo's credibility
 * rests on: a denial names the rule that fired, a removed value never reaches
 * the page, and no state is encoded in colour alone.
 */
import { describe, expect, test } from "bun:test";
import type { GovernanceEvent } from "@cg/policy-schema";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";
import { renderToStaticMarkup } from "react-dom/server";

import { ControlPlanePanelView } from "../components/governance/ControlPlanePanelView.tsx";
import type { CorrelationKey } from "../lib/governance/correlation.ts";
import type { PanelSource } from "../lib/governance/stream-url.ts";
import type { StreamStatus } from "../lib/governance/subscribe.ts";
import { appendEvents, emptyTimeline } from "../lib/governance/timeline.ts";

function render(
  events: readonly GovernanceEvent[],
  options: {
    status?: StreamStatus;
    source?: PanelSource;
    correlationKey?: CorrelationKey;
  } = {},
): string {
  const timeline = appendEvents(emptyTimeline(), events);
  return renderToStaticMarkup(
    <ControlPlanePanelView
      timeline={timeline}
      status={options.status ?? "live"}
      source={options.source ?? { mode: "fixture" }}
      correlationKey={options.correlationKey}
    />,
  );
}

/** Every card in `markup`, split apart so a lane's contents can be asserted on. */
function cards(markup: string): string[] {
  return markup.split("<article").slice(1).map((chunk) => `<article${chunk}`);
}

describe("three lanes", () => {
  test("all three are named, always, even before anything arrives", () => {
    const markup = render([]);

    expect(markup).toContain("Access");
    expect(markup).toContain("Pre");
    expect(markup).toContain("Post");
  });

  test("each lane says in plain language what it controls", () => {
    const markup = render([]);

    expect(markup).toContain("Which tools this person can see");
    expect(markup).toContain("Whether this call may be made");
    expect(markup).toContain("What is allowed back to the model");
  });

  test("an empty lane invites watching rather than showing a blank", () => {
    const markup = render([]);

    expect(markup).toContain("No call has been attempted yet.");
  });

  test("#5's fixture sequence renders every one of its events", () => {
    const markup = render(aGovernanceEventSequence());

    expect(cards(markup)).toHaveLength(5);
  });
});

describe("allow, deny and modify are distinguishable without colour", () => {
  const sequence = aGovernanceEventSequence();

  test("each decision carries a word", () => {
    const markup = render(sequence);

    expect(markup).toContain("Allowed");
    expect(markup).toContain("Denied");
    expect(markup).toContain("Modified");
  });

  test("each decision carries a glyph as well", () => {
    const markup = render(sequence);

    expect(markup).toContain("✓");
    expect(markup).toContain("✕");
    expect(markup).toContain("≠");
  });

  test("the three glyphs are all different", () => {
    expect(new Set(["✓", "✕", "≠"]).size).toBe(3);
  });

  test("each card is tagged with its decision, so CSS colours it", () => {
    const markup = render(sequence);

    expect(markup).toContain('data-decision="allow"');
    expect(markup).toContain('data-decision="deny"');
    expect(markup).toContain('data-decision="modify"');
  });

  test("the tally counts each decision", () => {
    const markup = render([
      aGovernanceEvent({ id: "evt_1", decision: "deny" }),
      aGovernanceEvent({ id: "evt_2", decision: "deny" }),
      aGovernanceEvent({ id: "evt_3", decision: "allow" }),
    ]);

    expect(markup).toContain('<span class="cg-stat-value">2</span><span class="cg-stat-label">Denied</span>');
    expect(markup).toContain('<span class="cg-stat-value">1</span><span class="cg-stat-label">Allowed</span>');
  });
});

describe("a denial shows the specific rule that fired", () => {
  test("the rule_id is on the card", () => {
    const markup = render([
      aGovernanceEvent({
        id: "evt_1",
        decision: "deny",
        rule_id: "rule.clearance",
        reason: "Exceeds your approval authority of 50000.",
      }),
    ]);

    expect(markup).toContain("rule.clearance");
  });

  test("so is the reason, in full rather than truncated", () => {
    const reason =
      "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. " +
      "To proceed, call Approvals.RequestApproval then retry Loan.ApproveLoan unchanged.";
    const markup = render([aGovernanceEvent({ id: "evt_1", decision: "deny", reason })]);

    expect(markup).toContain("exceeds your approval authority of 50000");
    expect(markup).toContain("retry Loan.ApproveLoan unchanged");
  });

  test("and the tool, and who was refused", () => {
    const markup = render([
      aGovernanceEvent({
        id: "evt_1",
        decision: "deny",
        tool: "Loan.ApproveLoan",
        user_id: "alice@northwind.test",
      }),
    ]);

    expect(markup).toContain("Loan.ApproveLoan");
    expect(markup).toContain("alice@northwind.test");
  });

  test("a rule_id of null renders no empty rule slot", () => {
    const markup = render([aGovernanceEvent({ id: "evt_1", rule_id: null })]);

    expect(markup).not.toContain('class="cg-rule"');
  });

  test("an allow shows its rule too — 'which rule permitted this' is act 1's question", () => {
    const markup = render([
      aGovernanceEvent({ id: "evt_1", decision: "allow", rule_id: "rule.analyst-read" }),
    ]);

    expect(markup).toContain("rule.analyst-read");
  });
});

describe("long audit values remain reachable", () => {
  test("a long reason and input-shaped detail stay intact in the decision card", () => {
    const inputValue = "apr_" + "x".repeat(160);
    const reason =
      "DENIED: the approval notice could not be delivered for input request_id=" +
      inputValue +
      ". Preserve this complete operational detail while the caller investigates the delivery path.";
    const markup = render([
      aGovernanceEvent({
        id: "evt_long_reason",
        hook: "pre",
        decision: "deny",
        tool: "Approvals.RequestApproval",
        reason,
        rule_id: "pre.approval-notice-delivery",
      }),
    ]);

    expect(markup).toContain(reason);
    expect(markup).toContain(inputValue);
    expect(markup).toContain('class="cg-reason"');
  });

  test("each lane exposes its event history as a keyboard-reachable region", () => {
    const markup = render([]);

    for (const hook of ["Access", "Pre", "Post"]) {
      expect(markup).toContain(
        `<div class="cg-lane-events" role="region" aria-label="${hook} decisions" aria-keyshortcuts="ArrowDown ArrowUp PageDown PageUp ArrowLeft ArrowRight Home End Space" tabindex="0">`,
      );
    }
  });
});

/**
 * What a `modify` shows, and what it must never show.
 *
 * This block used to build its event from `before`/`after` payloads. Those are
 * not fields a `GovernanceEvent` has any more (#101, finishing #16): the panel
 * is handed `redactions[]` — where and why — and draws the mask from the path
 * rather than from a value nobody sent it.
 */
describe("a modification shows what was taken, and never the value", () => {
  test("an allow draws no diff at all", () => {
    const markup = render([aGovernanceEvent({ id: "evt_1", decision: "allow" })]);

    expect(markup).not.toContain('class="cg-diff"');
  });

  test("a leaf removed outright says so rather than showing an empty after", () => {
    const markup = render([
      aGovernanceEvent({
        id: "evt_gone",
        hook: "post",
        decision: "modify",
        redactions: [
          { path: "$.ssn", rule_id: "rule.redact-ssn", pattern_id: null, kind: "remove" },
        ],
      }),
    ]);

    expect(markup).toContain("removed entirely");
    expect(markup).toContain("$.ssn");
  });

  test("each row is labelled path, before and after", () => {
    const markup = render([
      aGovernanceEvent({
        id: "evt_labelled",
        hook: "post",
        decision: "modify",
        redactions: [
          {
            path: "$.bank_account_number",
            rule_id: "post.redact-borrower-identifiers",
            pattern_id: null,
            kind: "mask",
          },
        ],
      }),
    ]);
    const diff = markup.slice(markup.indexOf('class="cg-diff"'));

    expect(diff).toContain('class="cg-diff-path">$.bank_account_number');
    expect(diff).toContain(">before<");
    expect(diff).toContain(">after<");
  });
});

/**
 * The shape a real `/post` redaction arrives in, which is the shape this panel
 * got wrong until #16's review: `redactions[]` and **no payload at all**, so
 * the payload diff had two `undefined`s to compare, produced no rows, and
 * printed "the payload came back unchanged" over act 3.
 *
 * A redaction event is a `modify` and the lane has to show it as one — the rule
 * that fired, every path it took, and the mask that stands where the value was.
 */
describe("a redaction event, which carries no payload to diff", () => {
  const redaction = aGovernanceEvent({
    id: "evt_payloadless",
    hook: "post",
    decision: "modify",
    tool: "Loan.GetLoan",
    // Null because two rules fired, which is the ordinary case for LN-2291: the
    // per-leaf ids are on the records, and rendering them is the point.
    rule_id: null,
    reason: "Output rewritten before it reached the model; 3 redaction(s) by 2 rule(s).",
    redactions: [
      { path: "$.bank_account_number", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" },
      { path: "$.tax_id", rule_id: "post.redact-borrower-identifiers", pattern_id: null, kind: "mask" },
      {
        path: "$.underwriter_notes",
        rule_id: "post.strip-injected-instructions",
        pattern_id: "pattern.injected-instruction",
        kind: "remove",
      },
    ],
  });

  /** The card's diff, so a lane's chrome cannot satisfy an assertion about it. */
  const diffOf = (markup: string): string => markup.slice(markup.indexOf('class="cg-diff"'));

  test("every redacted path is named", () => {
    const diff = diffOf(render([redaction]));

    expect(diff).toContain("$.bank_account_number");
    expect(diff).toContain("$.tax_id");
    expect(diff).toContain("$.underwriter_notes");
  });

  test("each path shows a mask where the value was", () => {
    const diff = diffOf(render([redaction]));

    // Three rows, each with the hatched mask and the word that makes it
    // unmistakably an absence rather than a value in a masked font.
    expect(diff.split('class="cg-mask"').length - 1).toBe(3);
    expect(diff).toContain("value withheld");
    // And what the model received in its place, per kind.
    expect(diff).toContain(">masked<");
    expect(diff).toContain("removed entirely");
  });

  test("both rules that fired are named, per leaf", () => {
    const diff = diffOf(render([redaction]));

    expect(diff).toContain('class="cg-diff-rule">post.redact-borrower-identifiers');
    // The pattern sweep names the scanner as well as the rule, because "which
    // regex found this" is what act 4 gets asked from the audience.
    expect(diff).toContain("post.strip-injected-instructions · pattern.injected-instruction");
  });

  test("it is not described as unchanged", () => {
    // The regression this describe exists for. The word must not appear on the
    // card at all: an event carrying an account of what it removed is never
    // unchanged, whatever the renderer failed to read.
    expect(render([redaction])).not.toContain("unchanged");
  });

  test("and it still reads as a modification", () => {
    const markup = render([redaction]);

    expect(markup).toContain('data-decision="modify"');
    expect(markup).toContain("Modified");
  });

  test("no value reaches the markup, because the event never carried one", () => {
    const markup = render([redaction]);

    expect(markup).not.toContain("6011329948175302");
    expect(markup).not.toContain("47-3389012");
  });

  test("a /post event that removed nothing still says so", () => {
    // The other half of the rule: the placeholder is reserved for an event with
    // an empty account and no payload. `/post` does produce that — a tool no
    // output rule names — and it belongs on the panel, because a lane that only
    // ever draws when something was taken cannot be told from a broken one.
    const markup = render([
      aGovernanceEvent({
        id: "evt_untouched",
        hook: "post",
        decision: "modify",
        tool: "Loan.SearchLoans",
        redactions: [],
      }),
    ]);

    expect(markup).toContain("The payload came back unchanged.");
  });
});

/**
 * The claim #101 exists to make true: the built-in FIXTURE REPLAY draws the
 * same card as a live `/post`.
 *
 * This is not two assertions that happen to agree — it is one predicate run
 * over both. A forker with no Arcade account sees only the replay, so a replay
 * that renders a different card teaches the wrong contract, and the way that
 * failed before was silent: the old fixture carried `before`/`after`, the live
 * hook stopped sending them on #16, and both still "rendered".
 */
describe("the fixture replay renders the same card the live Post lane does", () => {
  /** Everything about a redaction card that is shape rather than content. */
  function shapeOf(event: GovernanceEvent): Record<string, unknown> {
    const markup = render([event]);
    const card = cards(markup).find((chunk) => chunk.includes('data-decision="modify"')) ?? "";
    const diff = card.slice(card.indexOf('class="cg-diff"'));
    const records = event.redactions ?? [];

    return {
      decision: card.includes('data-decision="modify"'),
      rows: diff.split('class="cg-diff-row"').length - 1,
      masks: diff.split('class="cg-mask"').length - 1,
      maskReads: diff.includes("value withheld"),
      pathsNamed: records.every((record) => diff.includes(record.path)),
      rulesNamed: diff.split('class="cg-diff-rule"').length - 1,
      // A pattern sweep names its scanner beside the rule; a named field path
      // does not. Both forms have to be reachable from the replay.
      patternAnnotated: records.some((record) => record.pattern_id !== null)
        ? diff.includes(" · ")
        : null,
      unchanged: card.includes("unchanged"),
    };
  }

  const live = aGovernanceEvent({
    id: "evt_live",
    hook: "post",
    decision: "modify",
    tool: "Loan.GetLoan",
    rule_id: null,
    reason: "Output rewritten before it reached the model; 2 redaction(s) by 2 rule(s).",
    redactions: [
      {
        path: "$.bank_account_number",
        rule_id: "post.redact-borrower-identifiers",
        pattern_id: null,
        kind: "mask",
      },
      {
        path: "$.underwriter_notes",
        rule_id: "post.strip-injected-instructions",
        pattern_id: "pattern.injected-instruction",
        kind: "remove",
      },
    ],
  });

  const replayed = aGovernanceEventSequence().find((event) => event.decision === "modify");

  test("the replay has a modify to render at all", () => {
    expect(replayed).toBeDefined();
    expect(replayed?.redactions ?? []).not.toHaveLength(0);
  });

  test("card for card, the two are the same shape", () => {
    expect(shapeOf(replayed!)).toEqual(shapeOf(live));
  });

  test("and neither is described as unchanged", () => {
    expect(shapeOf(replayed!).unchanged).toBe(false);
    expect(shapeOf(live).unchanged).toBe(false);
  });

  test("the whole replay puts no removed value on the page", () => {
    const markup = render(aGovernanceEventSequence());

    expect(markup).not.toContain("0000000000");
    expect(markup).not.toContain("Ignore all previous instructions");
  });
});

describe("nothing is hidden behind a hover", () => {
  test("every card's rule, reason, tool and user are in the markup as text", () => {
    const markup = render([
      aGovernanceEvent({
        id: "evt_1",
        decision: "deny",
        tool: "Loan.ApproveLoan",
        user_id: "alice@northwind.test",
        rule_id: "rule.clearance",
        reason: "Exceeds your authority.",
      }),
    ]);

    for (const text of [
      "Loan.ApproveLoan",
      "alice@northwind.test",
      "rule.clearance",
      "Exceeds your authority.",
      "Denied",
    ]) {
      expect(markup).toContain(text);
    }
  });

  test("no element carries a title attribute, which is hover-only information", () => {
    expect(render(aGovernanceEventSequence())).not.toContain("title=");
  });
});

describe("a lane past what it can draw counts the rest", () => {
  /**
   * A whole-project `/access` sweep, which is what overflows this lane: one
   * decision per tool, so 10,844 of them are 10,844 *different* tools.
   *
   * Since #156 one person's sweep is one **listing** card — it is one
   * catalogue-wide question about one person, which is exactly what the card
   * is for — so what a sweep tests here is no longer "many rows" but "the
   * decisions a bounded lane could not keep are still counted". The card
   * states the members the lane still holds; everything it let go is in the
   * lane header, and between them every decision received is accounted for.
   */
  const sweep = (count: number, user = "supervisor@example.com"): GovernanceEvent[] =>
    Array.from({ length: count }, (_, index) =>
      aGovernanceEvent({
        id: `evt_${user}_${index}`,
        hook: "access",
        user_id: user,
        tool: `Widgets.tool_${index}`,
      }),
    );

  test("a sweep the lane can hold is one card and nothing is behind it", () => {
    const markup = render(sweep(20));

    expect(markup).toContain("20 decisions");
    expect(markup).not.toContain("cg-lane-behind");
  });

  test("the count includes what the timeline itself let go", () => {
    // 10,000 received, 50 still held and drawn inside one listing card — every
    // one of the rest is accounted for in the header.
    expect(render(sweep(10_000))).toContain("9,950 earlier decisions");
  });

  test("the overflow is stated, not silently dropped, when the rows are what overflow", () => {
    // Twenty people listing three tools each: twenty cards, six drawn, and the
    // forty-two decisions inside the fourteen cards that were not are counted.
    const many = Array.from({ length: 20 }, (_, index) =>
      sweep(3, `person-${index}@example.com`),
    ).flat();

    expect(render(many)).toContain("42 earlier decisions");
  });

  test("one is singular", () => {
    const events = Array.from({ length: 7 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}`, hook: "pre" }),
    );

    expect(render(events)).toContain("1 earlier decision");
  });

  test("the tally still reports everything received, not just what is drawn", () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}`, hook: "access", decision: "deny" }),
    );

    expect(render(events)).toContain('<span class="cg-stat-value">300</span>');
  });
});

describe("the connection, said out loud", () => {
  test("live", () => {
    expect(render([], { status: "live" })).toContain("Live");
  });

  test("connecting", () => {
    expect(render([], { status: "connecting" })).toContain("Connecting");
  });

  test("reconnecting, without the events already shown going away", () => {
    const markup = render(aGovernanceEventSequence(), { status: "reconnecting" });

    expect(markup).toContain("Reconnecting");
    expect(cards(markup)).toHaveLength(5);
  });

  test("a fixture replay is labelled, so a rehearsal cannot mistake it for live", () => {
    expect(render([], { source: { mode: "fixture" } })).toContain("FIXTURE REPLAY");
  });

  test("the live stream says LIVE and names the host it is watching", () => {
    // #81: "Live" alone is a word a replay could print. The host is the part
    // somebody at the back of the room can check against the deployment.
    const markup = render([], { source: { mode: "hooks", host: "cg-hooks.onrender.com" } });

    expect(markup).toContain("LIVE · cg-hooks.onrender.com");
    expect(markup).not.toContain("FIXTURE REPLAY");
  });
});

describe("no prose on the projector", () => {
  // The layer-2 caveat (DESIGN.md open risk 2) was a paragraph in the bottom
  // left. Design review cut it: nobody at the back of a room reads a footnote,
  // and the space belonged to the lanes. It lives in apps/web/README.md now.
  test("the bottom-left paragraph is gone", () => {
    const markup = render(aGovernanceEventSequence());

    expect(markup).not.toContain("cg-footnote");
    expect(markup).not.toContain("leaves no record");
  });

  test("the panel ends with the lanes", () => {
    expect(render([]).trimEnd().endsWith("</div></div>")).toBe(true);
  });
});

describe("correlation to what the chat is showing", () => {
  const events = [
    aGovernanceEvent({ id: "evt_2p9wq4nb7c", hook: "pre", execution_id: "exec_1", decision: "deny" }),
    aGovernanceEvent({ id: "evt_8t3zh6vd2m", hook: "post", execution_id: "exec_1", decision: "modify" }),
    aGovernanceEvent({ id: "evt_5r1nc8jk4q", hook: "pre", execution_id: "exec_2", decision: "allow" }),
  ];

  test("nothing is outlined when the chat is not showing a denial", () => {
    expect(render(events)).not.toContain('data-correlated="true"');
  });

  test("a denial's token outlines its own execution's events", () => {
    const markup = render(events, {
      correlationKey: { kind: "message", message: "Denied. [ref evt_2p9wq4nb7c]" },
    });

    const correlated = cards(markup).filter((card) => card.includes('data-correlated="true"'));
    expect(correlated).toHaveLength(2);
    expect(correlated.join("")).not.toContain("evt_5r1nc8jk4q");
  });

  test("a message Arcade mangled outlines nothing and drops nothing", () => {
    const markup = render(events, {
      correlationKey: { kind: "message", message: "Blocked by policy, no token here." },
    });

    expect(markup).not.toContain('data-correlated="true"');
    expect(cards(markup)).toHaveLength(3);
  });
});

describe("the flash that makes causality visible", () => {
  test("only the lane the newest event landed in flashes", () => {
    const markup = render([
      aGovernanceEvent({ id: "evt_1", hook: "access" }),
      aGovernanceEvent({ id: "evt_2", hook: "pre", decision: "deny" }),
    ]);

    const flashes = markup.split('class="cg-flash"').length - 1;
    expect(flashes).toBe(1);
    expect(markup).toContain('class="cg-flash" data-decision="deny"');
  });

  test("an empty panel flashes nothing", () => {
    expect(render([])).not.toContain("cg-flash");
  });
});

describe("the panel is a component, not a page", () => {
  test("it renders no html, head or body of its own, so #22 can embed it", () => {
    const markup = render(aGovernanceEventSequence());

    expect(markup.startsWith('<div class="cg-panel">')).toBe(true);
    expect(markup).not.toContain("<body");
  });
});

describe("each card is tinted by its decision", () => {
  // The design review's central ask: from across a room the block of colour is
  // what carries. `data-decision` is what globals.css hangs the tint, the left
  // accent bar and the inset edge on, so every card must be tagged with it and
  // the three tags must differ.
  const one = (decision: "allow" | "deny" | "modify"): string =>
    cards(render([aGovernanceEvent({ id: `evt_${decision}`, decision })]))[0] ?? "";

  test("a denied card carries the deny tint", () => {
    expect(one("deny")).toContain('class="cg-event" data-decision="deny"');
  });

  test("an allowed card carries the allow tint", () => {
    expect(one("allow")).toContain('class="cg-event" data-decision="allow"');
  });

  test("a modified card carries the modify tint", () => {
    expect(one("modify")).toContain('class="cg-event" data-decision="modify"');
  });

  test("the three tints are different from one another", () => {
    const tags = (["allow", "deny", "modify"] as const).map(
      (decision) => /data-decision="(\w+)"/.exec(one(decision))?.[1],
    );

    expect(new Set(tags).size).toBe(3);
    expect(tags).toEqual(["allow", "deny", "modify"]);
  });

  test("the decision label inside the card matches the tint it carries", () => {
    expect(one("deny")).toContain("Denied");
    expect(one("allow")).toContain("Allowed");
    expect(one("modify")).toContain("Modified");
  });
});

describe("each lane header carries its own counts", () => {
  /** The `<header>` of one lane, so a count cannot be matched from elsewhere. */
  function laneHeader(markup: string, hook: "access" | "pre" | "post"): string {
    const at = markup.indexOf(`id="cg-lane-${hook}"`);
    const from = markup.lastIndexOf("<header", at);
    return markup.slice(from, markup.indexOf("</header>", at));
  }

  const events = [
    aGovernanceEvent({ id: "evt_a1", hook: "access", decision: "deny" }),
    aGovernanceEvent({ id: "evt_p1", hook: "pre", decision: "deny" }),
    aGovernanceEvent({ id: "evt_p2", hook: "pre", decision: "allow" }),
    aGovernanceEvent({ id: "evt_o1", hook: "post", decision: "modify" }),
    aGovernanceEvent({ id: "evt_o2", hook: "post", decision: "modify" }),
    aGovernanceEvent({ id: "evt_o3", hook: "post", decision: "allow" }),
  ];

  test("pre shows one allowed and one denied", () => {
    const header = laneHeader(render(events), "pre");

    expect(header).toContain('data-decision="allow"><span class="cg-lane-count-value">1</span>');
    expect(header).toContain('data-decision="deny"><span class="cg-lane-count-value">1</span>');
  });

  test("post shows one allowed and two modified", () => {
    const header = laneHeader(render(events), "post");

    expect(header).toContain('data-decision="allow"><span class="cg-lane-count-value">1</span>');
    expect(header).toContain('data-decision="modify"><span class="cg-lane-count-value">2</span>');
  });

  test("access shows only its one denial, and no counts it did not make", () => {
    const header = laneHeader(render(events), "access");

    expect(header).toContain('data-decision="deny"><span class="cg-lane-count-value">1</span>');
    expect(header).not.toContain('data-decision="allow"');
    expect(header).not.toContain('data-decision="modify"');
  });

  test("a lane counts only its own hook, never another lane's", () => {
    const header = laneHeader(render(events), "access");

    // Six events in total, five of them in other lanes.
    expect(header).not.toContain("cg-lane-count-value\">2<");
    expect(header).not.toContain("cg-lane-count-value\">6<");
  });

  test("an empty lane draws no counters at all rather than three zeroes", () => {
    const header = laneHeader(render([]), "pre");

    expect(header).not.toContain("cg-lane-counts");
    expect(header).not.toContain(">0<");
  });

  test("the global tally still totals every lane", () => {
    const markup = render(events);

    expect(markup).toContain('<span class="cg-stat-value">2</span><span class="cg-stat-label">Allowed</span>');
    expect(markup).toContain('<span class="cg-stat-value">2</span><span class="cg-stat-label">Denied</span>');
    expect(markup).toContain('<span class="cg-stat-value">2</span><span class="cg-stat-label">Modified</span>');
  });

  test("lane counts keep counting past what the lane can draw", () => {
    const flood = Array.from({ length: 400 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}`, hook: "access", decision: "deny" }),
    );

    expect(laneHeader(render(flood), "access")).toContain(
      '<span class="cg-lane-count-value">400</span>',
    );
  });
});

describe("the type hierarchy the card is read through", () => {
  const event = aGovernanceEvent({
    id: "evt_1",
    decision: "deny",
    tool: "Loan.ApproveLoan",
    user_id: "alice@northwind.test",
    rule_id: "rule.clearance",
    reason: "Exceeds your approval authority of 50000.",
  });

  test("the tool call is its own element, ahead of the decision", () => {
    const card = cards(render([event]))[0] ?? "";

    expect(card.indexOf('class="cg-tool"')).toBeLessThan(card.indexOf('class="cg-decision"'));
  });

  test("the rule is a chip, not another line of the same kind as the tool", () => {
    const card = cards(render([event]))[0] ?? "";

    expect(card).toContain('<p class="cg-rule">rule.clearance</p>');
    expect(card.indexOf('class="cg-decision"')).toBeLessThan(card.indexOf('class="cg-rule"'));
  });

  test("time leads the card and the user sits at the far end of the same line", () => {
    const card = cards(render([event]))[0] ?? "";
    const meta = card.slice(card.indexOf('class="cg-event-meta"'), card.indexOf('class="cg-tool"'));

    expect(meta).toContain("cg-event-time");
    expect(meta).toContain("cg-event-user");
    expect(meta.indexOf("cg-event-time")).toBeLessThan(meta.indexOf("cg-event-user"));
    expect(card.indexOf('class="cg-event-meta"')).toBeLessThan(card.indexOf('class="cg-tool"'));
  });

  test("the reason is prose, carrying no identifier styling", () => {
    const card = cards(render([event]))[0] ?? "";

    expect(card).toContain(
      '<p class="cg-reason">Exceeds your approval authority of 50000.</p>',
    );
  });
});

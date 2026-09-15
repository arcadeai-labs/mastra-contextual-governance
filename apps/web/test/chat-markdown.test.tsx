/**
 * #99 — what the chat is allowed to draw out of text it did not write.
 *
 * Three separate claims, and only the first is about legibility:
 *
 * 1. **Markdown renders**, as a subset: links, emphasis, strong, inline code,
 *    paragraphs. The model emitted `[Authorize access](…)` on the Render URL and
 *    the screen showed the brackets.
 * 2. **Nothing else renders.** The reply is the one surface on this screen that
 *    a prompt injection gets to write — act 4 is a loan file trying to — so an
 *    HTML payload in a `text` event is shown as text, and a link the parser will
 *    not vouch for is shown as text too. That second half is the one people
 *    forget: escaping every tag and then emitting `javascript:` in an `href` has
 *    escaped nothing.
 * 3. **The authorization card prints the name and the link and stops.** Arcade's
 *    `llm_instructions` are words for the model, they carry the full authorize
 *    URL, and on the Render URL they overflowed the card by several hundred
 *    pixels. They stay in the event, where `test/gateway-token-rejected.test.ts`
 *    reads them; they are off the screen.
 *
 * Markup-level, through `renderToStaticMarkup`, the way every other React test
 * in this service works — these are properties of a pure render.
 * `test/chat-rendering.test.tsx` is the one that needs a DOM, and needs it for
 * a different claim.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { EventView } from "../components/chat/Chat.tsx";
import { Markdown } from "../components/chat/Markdown.tsx";
import { inlines, paragraphs, safeHref } from "../components/chat/markdown.ts";
import { transcript } from "../components/chat/transcript.ts";

const CHAT = join(import.meta.dir, "..", "components", "chat");

/**
 * React's one route from a string to markup. Spelled in pieces so this file can
 * name the thing it forbids without tripping its own rule.
 */
const ESCAPE_HATCH = `dangerously${"SetInnerHTML"}`;

function render(source: string): string {
  return renderToStaticMarkup(<Markdown source={source} />);
}

describe("the safe subset renders", () => {
  test("a link is a link, and it opens away from the turn in progress", () => {
    const markup = render("Open [the authorization page](https://cg-idp.example/oauth2/authorize).");

    expect(markup).toContain(`href="https://cg-idp.example/oauth2/authorize"`);
    expect(markup).toContain(">the authorization page</a>");
    expect(markup).toContain(`target="_blank"`);
    expect(markup).toContain(`rel="noreferrer"`);
    // The brackets #99 saw on screen are gone.
    expect(markup).not.toContain("[the authorization page]");
  });

  test("emphasis, strong and inline code each render as themselves", () => {
    expect(render("it is *not* a denial")).toContain("<em>not</em>");
    expect(render("it is _not_ a denial")).toContain("<em>not</em>");
    expect(render("it is **not** a denial")).toContain("<strong>not</strong>");
    expect(render("call `Loan_GetLoan` first")).toContain("Loan_GetLoan</code>");
  });

  test("a blank line starts a paragraph and a single newline does not", () => {
    expect(paragraphs("One.\n\nTwo.")).toHaveLength(2);
    expect(paragraphs("One.\nstill one.")).toHaveLength(1);
    // Whitespace-only is nothing, not an empty paragraph.
    expect(paragraphs("   \n\n  ")).toEqual([]);
  });

  test("markdown inside a code span stays literal", () => {
    const markup = render("the pattern is `a *b* c`");

    expect(markup).toContain("a *b* c</code>");
    expect(markup).not.toContain("<em>b</em>");
  });

  test("an unmatched asterisk is an asterisk, not the start of a run", () => {
    // Models write these constantly. A greedy parser turns the rest of the
    // reply into emphasis and the reply stops being readable.
    const markup = render("2 * 3 is 6 and the rate is 4.5% * 2");

    expect(markup).not.toContain("<em>");
    expect(markup).toContain("2 * 3 is 6");
  });
});

describe("nothing outside the subset renders", () => {
  const PAYLOAD = '<img src=x onerror="alert(1)"><b>bold</b><script>alert(2)</script>';

  test("an HTML payload in a text event is shown as text", () => {
    const markup = renderToStaticMarkup(<EventView event={{ kind: "text", text: PAYLOAD }} />);

    // Escaped, every one of them. No tag the model chose is in this document.
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("a javascript: link is printed as the text the model wrote", () => {
    const markup = render("Please visit [your account](javascript:fetch('/api/chat')).");

    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("href");
    // Visible rather than silently dropped: whoever put it there, the person
    // reading the reply deserves to see what was in it.
    expect(markup).toContain("javascript:fetch(&#x27;/api/chat&#x27;)");
  });

  test("only http and https are vouched for", () => {
    expect(safeHref("https://cg-idp.example/oauth2/authorize")).toBe(
      "https://cg-idp.example/oauth2/authorize",
    );
    expect(safeHref("http://localhost:4413/login")).toBe("http://localhost:4413/login");
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      // Relative: this service's own routes are not somewhere the model has any
      // business sending a person, and `/api/…` is exactly where it would try.
      "/api/arcade/start",
      "//evil.example/x",
    ]) {
      expect({ href: hostile, safe: safeHref(hostile) }).toEqual({ href: hostile, safe: null });
    }
  });

  test("the chat has no route to raw HTML at all", () => {
    // The claim above is only worth as much as this one. One React escape hatch
    // anywhere on this side of the seam and the parser's care stops mattering.
    //
    // Comments stripped, the same way `test/split-screen.test.tsx` strips them
    // for the seam rules: every file in this directory explains why the escape
    // hatch is forbidden, and a rule nobody may write down is a rule nobody can
    // follow.
    for (const name of readdirSync(CHAT)) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const source = withoutComments(readFileSync(join(CHAT, name), "utf8"));
      expect({ name, raw: source.includes(ESCAPE_HATCH) }).toEqual({ name, raw: false });
    }
  });

  test("markdown is rendered in the model's prose and nowhere else", () => {
    // A rule's remediation text is rendered verbatim — `[ref evt_…]` and all —
    // because #21's panel joins on that token. Markdown in a denial would eat
    // the brackets, and the two screens would describe different events.
    const reason = "DENIED: *check* the [ref evt_kbfcdksrpk] row before retrying.";
    const markup = renderToStaticMarkup(
      <EventView event={{ kind: "denied", tool: "Loan_ApproveLoan", reason, ref: "evt_kbfcdksrpk" }} />,
    );

    expect(markup).toContain("[ref evt_kbfcdksrpk]");
    expect(markup).toContain("*check*");
    expect(markup).not.toContain("<em>");
  });
});

describe("consecutive text events are one block", () => {
  test("the fold is over consecutive events, and a tool call breaks it", () => {
    expect(
      transcript([
        { kind: "text", text: "Rea" },
        { kind: "text", text: "ding." },
        { kind: "tool-call", tool: "Loan_GetLoan", inputs: {} },
        { kind: "text", text: "Don" },
        { kind: "text", text: "e." },
      ]),
    ).toEqual([
      { kind: "reply", text: "Reading." },
      { kind: "event", event: { kind: "tool-call", tool: "Loan_GetLoan", inputs: {} } },
      { kind: "reply", text: "Done." },
    ]);
  });

  test("a turn with no text is unchanged", () => {
    expect(transcript([{ kind: "done", calls: 0 }])).toEqual([
      { kind: "event", event: { kind: "done", calls: 0 } },
    ]);
  });

  test("the parser terminates on a reply built to nest", () => {
    // Bounded by construction — every recursive call is on a strictly shorter
    // substring — and capped anyway. A reply is attacker-influenced text; it
    // does not get to hang the render loop.
    const nested = `${"*".repeat(400)}deep${"*".repeat(400)}`;
    expect(inlines(nested).length).toBeGreaterThan(0);
    expect(renderToStaticMarkup(<Markdown source={nested} />)).toContain("deep");
  });
});

describe("the authorization card is a name and a link", () => {
  const LLM_INSTRUCTIONS =
    "Please show the following link to the end user formatted as markdown: " +
    "https://cg-idp-sa31.onrender.com/oauth2/authorize?client_id=abc123&redirect_uri=" +
    "https%3A%2F%2Fcloud.arcade.dev%2Fapi%2Fv1%2Foauth%2Fcallback&response_type=code&state=xyz";

  const layer2 = renderToStaticMarkup(
    <EventView
      event={{
        kind: "authorization",
        tool: "Loan_GetLoan",
        url: "https://cloud.arcade.dev/api/v1/oauth/flow/abc",
        instructions: LLM_INSTRUCTIONS,
      }}
    />,
  );

  test("the tool is named and the link is the only link", () => {
    expect(layer2).toContain("Loan_GetLoan");
    expect(layer2).toContain(`href="https://cloud.arcade.dev/api/v1/oauth/flow/abc"`);
    expect([...layer2.matchAll(/<a /g)]).toHaveLength(1);
  });

  test("neither the URL nor the instructions are printed", () => {
    // The overflow #99 measured: hundreds of pixels of query string in a card
    // that had a working link two lines above it.
    expect(layer2).not.toContain("Please show the following link");
    expect(layer2).not.toContain("cg-idp-sa31.onrender.com");
    expect(layer2).not.toContain("client_id");
    // The `href` is the one place the URL belongs, and nowhere in the text.
    expect(text(layer2)).not.toContain("https://");
  });

  test("it still says that nothing was refused and nothing was recorded", () => {
    expect(layer2).toContain("A credential is missing");
    expect(layer2).toContain("Nothing was refused");
    expect(layer2).toContain("no rule ran and nothing was written to the audit log");
    expect(layer2).not.toContain("denied");
  });

  test("hop 1 is told from layer 2 by the name, not by reading the words", () => {
    // Since #94 the same event kind also carries the gateway refusing this
    // browser's bearer. `tool` is the structured field that distinguishes them
    // and the card prints it; it does not sniff the instructions for a URL or
    // guess a hop from a spelling.
    const hop1 = renderToStaticMarkup(
      <EventView
        event={{
          kind: "authorization",
          tool: "cg-demo-us",
          url: "/api/arcade/start?next=%2Fchat",
          instructions:
            "The gateway rejected this browser's bearer with a 401 for alice@bank.example.",
        }}
      />,
    );

    expect(hop1).toContain("cg-demo-us — authorization needed");
    expect(hop1).toContain(`href="/api/arcade/start?next=%2Fchat"`);
    // Ours are still instructions for the model. Off the screen too — the wire
    // keeps them, and `test/gateway-token-rejected.test.tsx` reads them there.
    expect(hop1).not.toContain("401");
    expect(hop1).not.toContain("alice@bank.example");
  });
});

/** Source with `/* … *\/` and `//` comments removed. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Markup with the tags removed, so an assertion can be about what is readable. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

"use client";

/**
 * The model's prose, rendered.
 *
 * The parsing is `markdown.ts`; this is only the elements. Keeping them apart is
 * what makes the safety claim checkable: the parser returns data and has no way
 * to say "HTML", and this file renders that data as React children, which
 * escape. **There is no `dangerouslySetInnerHTML` here and there must never
 * be** — `test/chat-markdown.test.tsx` reads this directory's source and fails
 * if one appears, because the reply is the one surface on this screen a prompt
 * injection gets to write (act 4).
 *
 * `target="_blank"` on every link for the same reason the authorization card
 * has it: this screen is a live demo mid-turn, and a link that navigates the
 * page away takes the transcript, the panel and the turn with it.
 */
import type { Inline } from "./markdown.ts";
import { paragraphs } from "./markdown.ts";

/**
 * `pre-wrap`, so a single newline inside a paragraph survives. The model uses
 * them for lists and for line-broken figures, and collapsing them is how a
 * four-line summary becomes one long line.
 */
const paragraph: React.CSSProperties = { margin: "0.5em 0", whiteSpace: "pre-wrap" };

const code: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.92em",
};

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {paragraphs(source).map((block, index) => (
        // `data-kind`, the same seam the cards below it carry, and for the same
        // reason: it names which of the eight event kinds this came from, so a
        // test can count the blocks a turn produced without reaching for a
        // style or a position. #99's acceptance is a count of exactly these.
        <p key={index} data-kind="text" style={paragraph}>
          <Inlines nodes={block.children} />
        </p>
      ))}
    </>
  );
}

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineView key={index} node={node} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: Inline }) {
  switch (node.kind) {
    case "text":
      return <>{node.text}</>;
    case "code":
      return <code style={code}>{node.text}</code>;
    case "em":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case "strong":
      return (
        <strong>
          <Inlines nodes={node.children} />
        </strong>
      );
    case "link":
      // `href` came through `safeHref`: `http:` or `https:` and nothing else.
      return (
        <a href={node.href} target="_blank" rel="noreferrer">
          <Inlines nodes={node.children} />
        </a>
      );
  }
}

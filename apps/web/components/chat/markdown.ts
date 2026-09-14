/**
 * A safe subset of markdown, parsed into a tree the chat renders as React
 * elements. Links, emphasis, strong, inline code, and paragraphs. Nothing else.
 *
 * ## Why a parser and not a library
 *
 * Not "we could not find one". The reply this parses is **attacker-influenced
 * text**. Act 4 of this demo is a loan file whose underwriter notes carry an
 * instruction aimed at the model, and the model's reply is the one surface on
 * this screen that a prompt injection gets to write. Whatever renders it is a
 * security boundary, so it is small enough to read in one sitting and it has
 * exactly one hole to keep shut:
 *
 * **There is no path from this module to raw HTML.** It returns data. The
 * caller renders that data as React children, which escape. No
 * `dangerouslySetInnerHTML` anywhere on this side of the seam, which is not a
 * convention here but a test (`test/chat-markdown.test.tsx`). A markdown
 * library that takes `html: false` as an *option* is a library where the safe
 * behaviour is one config line from being off.
 *
 * The second hole is the link, and it is the one people forget: a renderer that
 * escapes every tag and then emits `<a href="javascript:…">` has escaped
 * nothing. Only `http:` and `https:` survive {@link safeHref}; anything else
 * renders as the literal text the model wrote, which is both safe and honest —
 * the person sees what was actually in the reply.
 *
 * ## What it deliberately does not do
 *
 * Headings, lists, block quotes, tables, images, reference links, HTML blocks.
 * A model that writes `- one` per line gets three lines inside one paragraph,
 * which reads fine, and none of them is a new element with a new escaping
 * question. #99 asked for "links, emphasis, code"; this is that and no more.
 */

/** One run of inline content. `text` is always literal — never markup. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "em"; children: Inline[] }
  | { kind: "strong"; children: Inline[] }
  /** `href` has already passed {@link safeHref}; it is `http:` or `https:`. */
  | { kind: "link"; href: string; children: Inline[] };

/** One paragraph. Blocks are what the model's blank lines separate. */
export interface Paragraph {
  kind: "paragraph";
  children: Inline[];
}

/**
 * The inline grammar, as one alternation so a single left-to-right scan decides
 * every token. Order is the precedence:
 *
 * 1. **Code first.** Everything inside backticks is literal, which is the point
 *    of code, so `` `a*b*c` `` must not come out emphasised.
 * 2. **Links before emphasis**, so `[read *this*](…)` keeps its label whole and
 *    a `*` inside a URL does not start an emphasis run.
 * 3. **`**` before `*`**, or every strong run parses as two empty emphases.
 *
 * Every delimiter is non-greedy, and two lookarounds do the rest of the work of
 * keeping ordinary prose ordinary:
 *
 * - **A delimiter may not be followed or preceded by a space.** `2 * 3 is 6 and
 *   the rate is 4.5% * 2` is a sentence models write constantly, and without
 *   this it renders with half of it emphasised.
 * - **`_` may not sit between word characters.** Every tool in this demo is
 *   spelled `Loan_GetLoan` on the wire and the model says so in its replies;
 *   `search_loans_by_status` must not come out as prose with a word italicised
 *   in the middle of it. CommonMark makes the same exception for the same
 *   reason.
 */
const INLINE =
  /`([^`]+)`|\[([^\]\n]*)\]\(\s*([^()\s]+)\s*\)|\*\*(?!\s)(.+?)(?<!\s)\*\*|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9])/s;

/**
 * The href to render, or `null` to render the link as the text the model wrote.
 *
 * `http:` and `https:` only. The list is allow, not deny, deliberately: a deny
 * list of `javascript:` and `data:` is a list somebody has to keep up with, and
 * `vbscript:`, `blob:` and the next one are on it only after they are found.
 *
 * A relative link is not accepted either. This service's own pages are not
 * somewhere the model has any business sending a person, and `/api/…` is
 * exactly where it would be worth sending them.
 */
export function safeHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/**
 * Inline markdown, as a tree. Anything unrecognised stays literal text.
 *
 * Recursion is bounded by construction: every recursive call is on a strictly
 * shorter substring — the delimiters themselves are consumed — so a reply built
 * to nest a thousand deep terminates. `depth` caps it anyway at a point no
 * prose reaches, and past it the remaining source renders as text rather than
 * markup.
 */
export function inlines(source: string, depth = 0): Inline[] {
  if (source === "") return [];
  if (depth > 8) return [{ kind: "text", text: source }];

  const match = INLINE.exec(source);
  if (match === null || match.index === undefined) return [{ kind: "text", text: source }];

  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  const head: Inline[] = before === "" ? [] : [{ kind: "text", text: before }];
  const tail = inlines(after, depth);

  const [, code, label, href, strong, star, underscore] = match;

  if (code !== undefined) return [...head, { kind: "code", text: code }, ...tail];

  if (href !== undefined) {
    const safe = safeHref(href);
    // Not a link we will make clickable. Rendered as the source wrote it, so a
    // `javascript:` payload is visible as text rather than silently dropped —
    // whoever put it there, the person reading deserves to see it.
    if (safe === null) return [...head, { kind: "text", text: match[0] }, ...tail];
    return [
      ...head,
      { kind: "link", href: safe, children: inlines(label ?? "", depth + 1) },
      ...tail,
    ];
  }

  if (strong !== undefined)
    return [...head, { kind: "strong", children: inlines(strong, depth + 1) }, ...tail];

  const emphasis = star ?? underscore;
  if (emphasis !== undefined)
    return [...head, { kind: "em", children: inlines(emphasis, depth + 1) }, ...tail];

  return [...head, { kind: "text", text: match[0] }, ...tail];
}

/**
 * A reply, as paragraphs.
 *
 * One blank line or more separates two paragraphs; a single newline stays
 * inside one and the chat renders it with `pre-wrap`, because a model that
 * wrote a line break meant one. An empty or whitespace-only reply is no
 * paragraphs rather than one empty one — `Chat.tsx` then draws nothing, which
 * is what an empty reply should look like.
 */
export function paragraphs(source: string): Paragraph[] {
  return source
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => ({ kind: "paragraph" as const, children: inlines(block) }));
}

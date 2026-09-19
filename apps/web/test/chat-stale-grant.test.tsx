/**
 * #123 — what the chat says when the grant Arcade holds has gone stale.
 *
 * The failure it describes is real and measured: reset `apps/idp`, and Arcade
 * goes on presenting the hop-2 token cg-idp has just forgotten. The tool call
 * comes back as a `fault` whose message is `apps/loan-app`'s own sentence, and
 * nothing in it carries an `authorization_url`, an `invalid_token` code or a
 * status — so there is no re-authorization card to render and this suite does
 * not pretend otherwise. What it holds is that the card **says which failure
 * this is and names the one recovery**, rather than the generic "any side
 * effects are unknown" that is true of every fault and useful for none.
 *
 * Markup, through the component's own prop, with nothing mocked — the shape
 * of `persona-tool-list.test.tsx`. The claim is what a person reads; the
 * streaming that puts it there is `chat-rendering.test.tsx`'s subject and
 * `test/reset-grants.test.ts` holds the other end, that the string this is
 * keyed on is the string the loan book really produces.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FaultConsequence } from "../components/chat/FaultConsequence.tsx";
import { staleGrant, STALE_GRANT_SIGNATURE } from "../lib/agent/stale-grant.ts";

/**
 * Arcade's wrapping of the tool's message, verbatim from #123's report, with
 * `apps/loan-app`'s sentence inside it. Written out rather than built from the
 * constant so the test would still fail if the constant drifted away from what
 * the service actually emits.
 */
const STALE =
  "[TOOL_RUNTIME_FATAL] ToolExecutionError during execution of tool 'get_loan': " +
  "The identity provider rejected the token.";

/** Ordinary plumbing failures, for the contrast. Every one of these is a fault too. */
const ORDINARY = [
  "The loan origination system could not be reached.",
  "The identity provider could not be reached.",
  // The one that used to wear the same words as a stale grant, and no longer
  // does — a rate refusal needs a minute, not a dashboard.
  "The identity provider answered 429 and did not say whether this token is still good.",
];

const render = (message: string) => renderToStaticMarkup(<FaultConsequence message={message} />);

describe("a stale hop-2 grant is named, with its recovery", () => {
  test("the card says the provider no longer recognises the token Arcade holds", () => {
    const markup = render(STALE);

    expect(markup).toContain('data-fault-cause="stale-grant"');
    expect(markup).toContain("no longer recognises the token Arcade holds");
    expect(markup).toMatch(/identity provider was reset|grant was revoked/);
  });

  test("it names the manual step, and says retrying will not help", () => {
    const markup = render(STALE);

    // The recovery has to be an instruction someone can follow, not "try
    // again" — Arcade believes the grant is live and will not re-challenge, so
    // a retry is the one thing that reliably does nothing (#123, #75).
    expect(markup).toContain("Revoke the cg-idp authorization for this user in the Arcade dashboard");
    expect(markup).toContain("retrying");
  });

  test("it states that nothing reached the loan book, because nothing did", () => {
    const markup = render(STALE);

    // `apps/loan-app` resolves the caller before it touches the book, so a
    // refusal here never got that far — on a write as much as on a read. The
    // generic line cannot say this and has to hedge.
    expect(markup).toContain("Nothing was read from or written to the loan book");
    expect(markup).not.toContain("Any side effects are unknown");
  });

  test("it never claims a decision, and offers no link it cannot produce", () => {
    const markup = render(STALE);

    expect(markup).not.toMatch(/denied|refused by|control plane/i);
    expect(markup).not.toContain("<a ");
    expect(markup).not.toMatch(/https?:\/\//);
  });

  test("every other fault keeps the wording that claims nothing", () => {
    for (const message of ORDINARY) {
      const markup = render(message);
      expect(markup).toContain("Any side effects are unknown");
      expect(markup).not.toContain("stale-grant");
      expect(markup).not.toContain("Arcade dashboard");
    }
  });

  test("the signature is matched inside Arcade's wrapper, not only at the start", () => {
    // Arcade prefixes the tool's message; a check anchored to the start of the
    // string would silently never fire, which is the shape of control this
    // project exists to keep out.
    expect(STALE.startsWith(STALE_GRANT_SIGNATURE)).toBe(false);
    expect(staleGrant(STALE)).not.toBeNull();
    expect(staleGrant(STALE_GRANT_SIGNATURE)).not.toBeNull();
    expect(staleGrant("")).toBeNull();
  });
});

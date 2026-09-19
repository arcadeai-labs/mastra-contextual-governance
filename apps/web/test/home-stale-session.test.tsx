/**
 * The screen stops contradicting itself about whether you are signed in (#176).
 *
 * In the human's screenshot on 2026-09-19 the top chrome read `SIGNED IN AS
 * bob@megaforce.tech`, the assistant read *"Acting as bob@megaforce.tech —
 * every tool call is made as this person"*, and between them the loan book read
 * *"The loan system did not accept this browser's sign-in as
 * bob@megaforce.tech."*
 *
 * Both halves were individually honest. `signedInAs` comes from the sealed
 * session cookie, which is intact; the `expired` state is a real 401 from the
 * bank's API on that person's own IdP bearer. The screen still asserted two
 * opposite things at once, and the one the audience reads first is the one in
 * the big navy bar.
 *
 * ## Why this file exists rather than three more cases in `home-screen.test.tsx`
 *
 * Because the state has to be **reached**, not spelled out. Four failure
 * surfaces on this repo lied inside two days — #167, #170, #151, and the one
 * folded into #175 — every one of them because the path was written and never
 * exercised, and a test that hands `BankPane` a literal
 * `{ status: "expired", message: "…" }` is exactly that shape: it proves the
 * render and says nothing about whether anything ever produces the value.
 *
 * So the state comes out of `readLoanBook` — the real module the server
 * component calls — against a real HTTP server that answers a real `401` to a
 * real `Authorization: Bearer …`. The one thing standing in is the loan book
 * itself, at the network edge, because *that* half is measured against the real
 * `apps/loan-app` subprocess with a real sign-in in `test/api-loans.test.ts`
 * ("a token the identity provider refuses is the same re-sign-in"). Nothing
 * between the socket and the pixels is mocked, and the message on screen is the
 * one `lib/loan-context/read.ts` wrote rather than one this file did.
 *
 * ## The distinction that must survive
 *
 * A stale bearer is **not** governance. No hook ran, nothing was refused, and
 * `expiredFor`'s copy says so in as many words. A screen that dressed an
 * expired sign-in as a policy denial would be this demo arguing against its own
 * thesis in front of the audience it is trying to convince — so "nothing was
 * refused by policy" is asserted here as a property of the whole screen, not
 * just of the card it is written on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BankPane } from "../components/bank/BankPane.tsx";
import { readLoanBook } from "../lib/loan-context/read.ts";
import type { LoanBookState } from "../lib/loan-context/loans.ts";
import type { Session } from "../lib/identity/session.ts";

const BOB = "bob@megaforce.tech";

/** Every request the stand-in saw, so the 401 is known to have been a real ask. */
let seen: Array<{ path: string; authorization: string | null }> = [];
let loanBook: ReturnType<typeof Bun.serve>;
let host: string;

/**
 * The loan book, refusing this browser's bearer.
 *
 * Port `0`: this worktree owns a block of ten and the reviewer's owns another,
 * so nothing here may pick a number — the OS does, and the port is read back.
 */
beforeAll(() => {
  loanBook = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, authorization: request.headers.get("authorization") });
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
  });
  host = `localhost:${loanBook.port}`;
});

afterAll(() => loanBook.stop(true));

/**
 * A browser that signed in an hour ago and whose loan-system bearer the bank
 * has stopped accepting.
 *
 * `expires_at` is in the future on purpose. The interesting case is not a token
 * this service already knows is dead — it is one that looks fine by our own
 * clock and that the bank refuses anyway, because `expires_at` is this
 * service's note to itself and only the issuer decides. No `refresh_token`, so
 * nothing can be renewed behind the test's back.
 */
function staleSession(): Session {
  return {
    email: BOB,
    signed_in_at: Date.now() - 3_600_000,
    idp: { access_token: "a-bearer-the-bank-no-longer-accepts", expires_at: Date.now() + 3_600_000 },
  };
}

/** The whole of `/` as `app/page.tsx` composes it, for the book it was given. */
function screen(book: LoanBookState): string {
  return renderToStaticMarkup(
    <BankPane
      signedInAs={BOB}
      identity={<p>the session controls, server-rendered</p>}
      loans={book}
      approvalStreamUrl={null}
    />,
  );
}

/** Tags stripped, whitespace collapsed — what a person in the room actually reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&mdash;|&#x2014;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the expired state, reached rather than assumed", () => {
  test("a 401 from the loan book is an expired sign-in, and the read really happened", async () => {
    seen = [];
    const book = await readLoanBook(staleSession(), { host });

    expect(book.status).toBe("expired");
    // The refusal was answered to a request this code made, carrying this
    // person's bearer. Without this the rest of the file could be asserting
    // about a state produced by nothing.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/loans");
    expect(seen[0]?.authorization).toBe("Bearer a-bearer-the-bank-no-longer-accepts");
  });

  test("the copy still says nothing was refused by policy", async () => {
    const book = await readLoanBook(staleSession(), { host });

    expect(book.status).toBe("expired");
    const message = (book as Extract<LoanBookState, { status: "expired" }>).message;
    expect(message).toContain("Nothing was refused by policy");
    expect(message).toContain("sign in again");
    expect(message).toContain(BOB);
  });
});

describe("the chrome and the assistant, with the loan book expired", () => {
  let expired: LoanBookState;
  let markup: string;

  beforeAll(async () => {
    expired = await readLoanBook(staleSession(), { host });
    markup = screen(expired);
  });

  test("the chrome stops presenting the session as good", () => {
    const bar = markup.slice(markup.indexOf(`class="bank-user"`), markup.indexOf(`class="bank-body"`));

    expect(bar).toContain(`data-session="stale"`);
    expect(text(bar)).toContain("Sign-in stale");
    // The email stays: it is still who this browser signed in as, and it is
    // still the join key the panel on the other page names. What goes is the
    // claim that the sign-in works.
    expect(bar).toContain(BOB);
    expect(text(bar)).not.toContain("Signed in as");
  });

  test("the chrome says what to do about it, in the chrome", () => {
    const bar = markup.slice(markup.indexOf(`class="bank-user"`), markup.indexOf(`class="bank-body"`));

    expect(text(bar)).toContain("Nothing was refused by policy");
    expect(bar).toContain(`href="/api/auth/signin"`);
    expect(text(bar)).toContain("sign in again");
  });

  test("the assistant stops claiming the tool calls land as that person", () => {
    const chat = markup.slice(markup.indexOf(`aria-label="Assistant"`));

    expect(chat).toContain(`data-acting-as="stale"`);
    expect(text(chat)).not.toContain("every tool call is made as this person");
    expect(text(chat)).toContain("has stopped accepting that sign-in");
    expect(text(chat)).toContain(BOB);
  });

  /**
   * The criterion, stated about the whole page rather than about either half.
   *
   * Each of the three surfaces was individually defensible in the screenshot.
   * What the issue is about is the screen as one object, so the assertion is
   * made over all of it at once.
   */
  test("no surface on the page claims a working sign-in", () => {
    const reading = text(markup);

    expect(reading).not.toContain("Signed in as");
    expect(reading).not.toContain("Acting as");
    expect(reading).not.toContain("every tool call is made as this person");
    // Said three times, once by each surface that was contradicting the others
    // in the screenshot: the chrome, the loan book's own card, and the
    // assistant. Every one of them repeats the sentence rather than any one of
    // them being the only place a reader could learn it — and repeating *this*
    // sentence is the point, because the thing all three must not imply is a
    // refusal.
    expect([...reading.matchAll(/Nothing was refused by policy/g)]).toHaveLength(3);
  });

  test("none of it reads as a policy decision", () => {
    const reading = text(markup);

    expect(reading).not.toMatch(/\bdenied\b|\bblocked\b|not allowed|CHECK_FAILED|\[ref evt_/i);
    // And it does not reach for the panel's vocabulary to explain itself.
    expect(reading).not.toMatch(/policy decision was made|control plane|governance|hook/i);
  });
});

describe("the same screen with a loan book that answers", () => {
  /**
   * The other direction, so "stale" cannot quietly become the only thing this
   * screen knows how to say. A control that fires on everything is
   * indistinguishable from a control that fires on nothing — this project's
   * recurring failure, pointed at our own UI.
   */
  test("nothing is stale, and both surfaces say the ordinary thing", () => {
    const markup = screen({ status: "loaded", actor: BOB, loans: [] });
    const reading = text(markup);

    expect(markup).toContain(`data-session="active"`);
    expect(markup).toContain(`data-acting-as="active"`);
    expect(reading).toContain("Signed in as");
    expect(reading).toContain("Acting as");
    expect(reading).not.toContain("Sign-in stale");
    expect(reading).not.toContain("Nothing was refused by policy");
  });
});

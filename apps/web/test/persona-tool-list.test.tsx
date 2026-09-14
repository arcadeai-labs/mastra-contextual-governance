/**
 * What the act 1 widget actually renders.
 *
 * Assertions are on markup, through the component's own two props, with nothing
 * mocked — the same shape as `panel.test.tsx`. The properties checked here are
 * the ones the beat's credibility rests on:
 *
 * - the tool that was hidden is **absent**, not rendered as struck-through or
 *   greyed out. A crossed-out `ApproveLoan` would be a picture of a control that
 *   does nothing, and it is the single most tempting thing to add to this
 *   screen.
 * - the built-ins that were filtered are **named**, because "eight became six"
 *   is an arithmetic nobody should have to take on trust.
 * - a failure to list is a sentence, never an empty list.
 * - the authority figure is labelled as the seeded one, since a presenter may
 *   raise a clearance live and this screen does not read the policy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import type { SessionTools } from "../lib/agent/tool-list.ts";
import type { Session } from "../lib/identity/session.ts";

const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";

/** The roster reads `process.env`, which is where a deployment's four addresses live. */
const CONFIGURED = {
  PERSONA_DANA_EMAIL: DANA,
  PERSONA_SAM_EMAIL: SAM,
  PERSONA_RILEY_EMAIL: "riley.chen@bank.example",
  PERSONA_MORGAN_EMAIL: "morgan.ellis@bank.example",
} as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [key, value] of Object.entries(CONFIGURED)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function session(email: string): Session {
  return { email, signed_in_at: 0, gateway: { access_token: "tok", expires_at: 0, client_id: "c" } };
}

const SAM_TOOLS: SessionTools = {
  ok: true,
  tools: [
    { name: "Loan_SearchLoans", description: "Find loan applications in the loan book." },
    { name: "Loan_GetLoan", description: "Read one loan application's complete file by ID." },
    { name: "Loan_DenyLoan", description: "Decline a loan application with a stated reason." },
  ],
  filtered: ["System_ManageAuthorization", "Arcade_ListApps"],
};

const DANA_TOOLS: SessionTools = {
  ok: true,
  tools: [
    ...SAM_TOOLS.ok ? SAM_TOOLS.tools : [],
    { name: "Loan_ApproveLoan", description: "Approve a loan application for a given dollar amount." },
  ],
  filtered: ["System_ManageAuthorization", "Arcade_ListApps"],
};

const render = (props: Parameters<typeof PersonaToolList>[0]) => renderToStaticMarkup(<PersonaToolList {...props} />);

describe("the persona, with role and authority", () => {
  test("all three are on screen, and the email is the identity", () => {
    const markup = render({ session: session(DANA), tools: DANA_TOOLS });

    expect(markup).toContain("Dana Okafor");
    expect(markup).toContain("Loan Officer");
    expect(markup).toContain("$50,000");
    // The address, always: it is the string Arcade sees as `user_id` and the
    // loan book records as the actor, and a screen about who the agent acts as
    // that shows only a friendly name is showing the label and hiding the fact.
    expect(markup).toContain(DANA);
  });

  test("Sam's authority is zero, and zero is written out rather than left blank", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    expect(markup).toContain("Sam Reyes");
    expect(markup).toContain("Credit Analyst");
    expect(markup).toContain("$0");
  });

  test("the figure says it is the seeded one", () => {
    // `DESIGN.md` lets a presenter raise a clearance live on stage, and this
    // component never reads the policy. A number presented as live truth would
    // be a control surface asserting a value it did not fetch.
    expect(render({ session: session(DANA), tools: DANA_TOOLS })).toContain("as seeded in the policy");
  });

  test("an address the deployment does not name is said out loud, not guessed at", () => {
    const markup = render({ session: session("stranger@elsewhere.example"), tools: SAM_TOOLS });

    expect(markup).toContain("stranger@elsewhere.example");
    expect(markup).toContain("PERSONA_*_EMAIL");
    // No borrowed role and no borrowed figure.
    expect(markup).not.toContain("Loan Officer");
    expect(markup).not.toContain("$50,000");
  });

  test("nobody signed in says so", () => {
    const markup = render({ session: null, tools: { ok: false, reason: "Nobody is signed in." } });
    expect(markup).toContain("Nobody is signed in");
  });
});

describe("the tool list", () => {
  test("as Sam the approval tool is absent — not struck through, not greyed out, absent", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    expect(markup).toContain("Loan_SearchLoans");
    expect(markup).toContain("Loan_GetLoan");
    expect(markup).toContain("Loan_DenyLoan");
    // The assertion the whole act rests on. There is nothing on this screen for
    // anyone to point at and ask "why is it still there?"
    expect(markup).not.toContain("ApproveLoan");
    expect(markup).not.toContain("approve_loan");
  });

  test("as Dana it is there", () => {
    expect(render({ session: session(DANA), tools: DANA_TOOLS })).toContain("Loan_ApproveLoan");
  });

  test("the page says where the list came from, and that it was not filtered here", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    // The claim is on the screen, not only in a comment: a UI that filtered a
    // full catalogue client-side would render the same three rows while proving
    // the opposite thing, so it says which of the two it did.
    expect(markup).toContain("tools/list");
    expect(markup).toContain("Not filtered in the browser");
  });

  test("the filtered built-ins are named, not quietly dropped", () => {
    const markup = render({ session: session(DANA), tools: DANA_TOOLS });

    expect(markup).toContain("System_ManageAuthorization");
    expect(markup).toContain("Arcade_ListApps");
    expect(markup).toContain("2 further");
  });

  test("a list that could not be fetched is a sentence, never an empty list", () => {
    const markup = render({
      session: session(DANA),
      tools: { ok: false, reason: "The gateway listed no tools at all." },
    });

    expect(markup).toContain("No tool list.");
    expect(markup).toContain("The gateway listed no tools at all.");
    // And nothing that reads as "this persona may use nothing".
    expect(markup).not.toContain("advertised nothing this persona may use");
  });

  test("an empty-but-successful list says the gateway advertised nothing usable", () => {
    const markup = render({ session: session(SAM), tools: { ok: true, tools: [], filtered: [] } });
    expect(markup).toContain("advertised nothing this persona may use");
  });
});

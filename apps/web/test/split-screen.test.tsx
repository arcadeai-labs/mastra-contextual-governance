/**
 * The shell: what is on each half of the screen, and what keeps them apart.
 *
 * Assertions are on markup, through each component's own props, with nothing
 * mocked — the same shape as `test/panel.test.tsx`, for the same reason: every
 * property this slice is accountable for is a property of a pure render.
 *
 * Three groups, and the last is the one worth reading:
 *
 * 1. **The split.** Enterprise app left, control plane right, in that order,
 *    with the persona, the loan files and the chat on the left and the panel's
 *    stream badge on the right.
 * 2. **A denial is not an error state.** The trap #22's issue names. A red
 *    crash banner reads to a room as "the demo broke", when what happened is the
 *    system working exactly as designed, and the two must not look alike.
 * 3. **The fork seam.** A developer restyles the left half and keeps the right
 *    entirely. That is a claim about imports and class names, so it is checked
 *    against the source rather than asserted in a comment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { BankPane } from "../components/bank/BankPane.tsx";
import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import { EventView } from "../components/chat/Chat.tsx";
import { LoanFilesView } from "../components/bank/LoanFiles.tsx";
import { LoanFileCard } from "../components/bank/LoanFileCard.tsx";
import { SplitScreen } from "../components/shell/SplitScreen.tsx";
import { TOOL_LIST_SLOT } from "../components/bank/ToolListSlot.tsx";
import { GATEWAY_START_PATH, SIGNIN_PATH } from "../lib/identity/handlers.ts";
import type { LoanFilesState, LoanRead } from "../lib/loan-context/loans.ts";
import type { Session } from "../lib/identity/session.ts";
import type { SessionTools } from "../lib/agent/tool-list.ts";
import type { PanelStream } from "../lib/governance/stream-url.ts";

const HERE = import.meta.dir;
const WEB = join(HERE, "..");

const FIXTURE_STREAM: PanelStream = { mode: "fixture", url: "/api/governance/fixture-stream" };
const LIVE_STREAM: PanelStream = {
  mode: "hooks",
  url: "https://cg-hooks.onrender.com/events",
  host: "cg-hooks.onrender.com",
};

function shell(options: { stream?: PanelStream; signedInAs?: string | null; loanFiles?: LoanFilesState } = {}): string {
  return renderToStaticMarkup(
    <SplitScreen
      stream={options.stream ?? FIXTURE_STREAM}
      signedInAs={options.signedInAs === undefined ? "alice@bank.example" : options.signedInAs}
      identity={<p>the sign-in panel, server-rendered</p>}
      loanFiles={options.loanFiles ?? FILES}
    />,
  );
}

const SAM = "bob@bank.example";

const samSession = (): Session => ({
  email: SAM,
  signed_in_at: 0,
  gateway: { access_token: "tok", expires_at: 0, client_id: "c" },
});

/**
 * What the gateway answers `tools/list` with for Bob — three tools, not four.
 *
 * `Loan_ApproveLoan` is missing because `access.analysts-cannot-see-approve`
 * removed it before the gateway answered, which is act 1. It is measured
 * end-to-end in `test/act1-tool-list.test.ts` (#15); here it is a fixture,
 * because what this file is asserting is that #22's layout does not put it back.
 */
const SAM_TOOLS: SessionTools = {
  ok: true,
  tools: [
    { name: "Loan_SearchLoans", description: "Find loan applications in the loan book." },
    { name: "Loan_GetLoan", description: "Read one loan application's complete file by ID." },
    { name: "Approvals_RequestApproval", description: "Ask a human for approval." },
  ],
  filtered: ["System_ManageAuthorization", "Arcade_ListApps"],
};

const NORTHWIND: LoanRead = {
  loan_id: "LN-2291",
  outcome: "read",
  loan: {
    loan_id: "LN-2291",
    borrower_name: "Northwind Bakery LLC",
    amount: 95000,
    status: "pending",
    purpose: "Second location build-out",
    submitted_at: "2026-08-19",
    credit_score: 712,
    annual_revenue: 2340000,
    years_in_business: 8,
    underwriter_notes: "Debt service coverage 1.4x on trailing twelve months.",
  },
};

/**
 * What `app/page.tsx` hands the shell since #109: the reads, already made, in
 * the same gateway session that listed the persona's tools. There is no
 * fetching component under here any more, so a fixture is all the shell needs.
 */
const FILES: LoanFilesState = {
  status: "loaded",
  body: { reads: [NORTHWIND], actor: "alice@bank.example", tool: "Loan_GetLoan" },
};

describe("the split", () => {
  test("the enterprise app is on the left and the control plane on the right", () => {
    const markup = shell();

    const left = markup.indexOf(`class="cg-split-left"`);
    const right = markup.indexOf(`class="cg-split-right"`);
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(left);
    // The bank's chrome inside the left half, the panel's title inside the right.
    expect(markup.indexOf("Loan Origination System")).toBeGreaterThan(left);
    expect(markup.indexOf("Loan Origination System")).toBeLessThan(right);
    expect(markup.indexOf("Control plane")).toBeGreaterThan(right);
  });

  /**
   * The other half of this contract — that the attribute *appears* once the
   * shell mounts — is measured on the real thing, by
   * `test/home-loan-next-browser.test.ts`, whose readiness gate waits for it
   * and would time out if it never arrived. What matters here is that the
   * server does not claim it: an attribute present in the server's own HTML
   * would answer "yes, hydrated" to a page that is nothing of the kind, which
   * is the failure #152 exists to close.
   */
  test("the server never claims the shell is hydrated", () => {
    const markup = shell();

    expect(markup).toContain(`class="cg-split"`);
    expect(markup).not.toContain("data-hydrated");
  });

  test("the left half reads as an internal banking tool rather than a demo", () => {
    const markup = shell();

    expect(markup).toContain("Loan Origination System");
    expect(markup).toContain("Commercial Lending Division");
    expect(markup).toContain("Rel. 7.2.1");
    for (const tab of ["Pipeline", "Applications", "Decisions", "Reports", "Admin"]) {
      expect(markup).toContain(tab);
    }
    // It does not call itself a demo, a scaffold or a governance anything. The
    // bank's software has never heard of Arcade; the panel opposite is what
    // knows about governance.
    //
    // Scoped to the shell's **own** chrome, which is what `shell()` renders:
    // both demo fixtures the left half hosts — #82's sign-in panel and #15's
    // tool list — arrive as props and are stubbed here. Those two do name the
    // gateway, and should: they are the demo's own furniture standing inside the
    // bank's screen, in the same category as the persona switcher. What must not
    // creep in is this file's chrome announcing itself.
    expect(leftHalf(markup)).not.toMatch(/demo|scaffold|Arcade/i);
  });

  test("the panel says which stream it is watching, on either half", () => {
    expect(shell({ stream: LIVE_STREAM })).toContain("LIVE · cg-hooks.onrender.com");
    expect(shell({ stream: FIXTURE_STREAM })).toContain("FIXTURE REPLAY");
  });

  test("an unconfigured stream replaces the panel rather than sitting above it", () => {
    const markup = shell({
      stream: { mode: "unconfigured", problem: "GOVERNANCE_STREAM is not set." },
    });

    expect(markup).toContain("GOVERNANCE_STREAM is not set.");
    // No lanes: nothing subscribed, and no replay is running underneath a warning.
    expect(markup).not.toContain("cg-lanes");
  });

  test("the person the whole screen is acting as is named, large, on the left", () => {
    const markup = shell({ signedInAs: "alice@bank.example" });

    expect(markup).toContain("Signed in as");
    expect(markup).toContain("alice@bank.example");
    expect(markup).toContain(`data-signed-in="true"`);
  });

  test("nobody signed in is said plainly, not left blank", () => {
    const markup = shell({ signedInAs: null });

    expect(markup).toContain("no user");
    expect(markup).toContain(`data-signed-in="false"`);
  });

  test("the persona switcher is on the left half, rendered by whoever owns it", () => {
    // Handed down as an element from the server component, so the sealed
    // session is unsealed on the server. This asserts the slot, not #82's
    // markup: the switcher is `components/identity`'s and stays there.
    expect(shell()).toContain("the sign-in panel, server-rendered");
  });

  test("the chat is on the left, and says who it is acting as", () => {
    const markup = shell();

    expect(markup).toContain("Assistant");
    expect(markup).toContain("Acting as");
    expect(markup).toContain("Send");
  });

  test("the tool list has a named slot, and the shell does not fill it with its own", () => {
    const markup = renderToStaticMarkup(
      <BankPane signedInAs="alice@bank.example" identity={null} loanFiles={FILES} />,
    );

    expect(markup).toContain(`data-slot="${TOOL_LIST_SLOT}"`);
    expect(markup).toContain("No tool list was supplied");
    // No tool names invented here. A second, client-side tool list is exactly
    // the control-that-does-nothing this project is organised against.
    expect(markup).not.toContain("Loan_ApproveLoan");
  });

  test("the slot renders what it is given and drops the placeholder", () => {
    const markup = renderToStaticMarkup(
      <BankPane
        signedInAs="alice@bank.example"
        identity={null}
        loanFiles={FILES}
        toolList={<p>four tools, from the gateway</p>}
      />,
    );

    expect(markup).toContain("four tools, from the gateway");
    expect(markup).not.toContain("No tool list was supplied");
  });

  /**
   * The composition the merge with #15 exists to make.
   *
   * `app/page.tsx` asks the gateway what this session may see and hands
   * `PersonaToolList` into the shell's slot. This is that arrangement rendered:
   * act 1's absence — `Loan_ApproveLoan` missing from Bob's list — surviving
   * inside #22's layout, with the list still saying where it came from.
   *
   * Both halves of the claim are checked, because only one of them is about
   * governance: the tool is absent, **and** nothing in the shell draws it as
   * hidden. A crossed-out approval tool is the single most tempting thing to add
   * to this screen and it would be a picture of a control that does nothing.
   */
  test("the shell hosts #15's gateway-sourced list, and act 1's absence survives it", () => {
    const markup = renderToStaticMarkup(
      <BankPane
        signedInAs={SAM}
        identity={null}
        loanFiles={FILES}
        toolList={<PersonaToolList session={samSession()} tools={SAM_TOOLS} />}
      />,
    );

    expect(markup).toContain(`data-slot="${TOOL_LIST_SLOT}"`);
    expect(markup).toContain("Loan_SearchLoans");
    expect(markup).toContain("Loan_GetLoan");
    expect(markup).not.toContain("Loan_ApproveLoan");
    // #15's provenance line, still on screen inside the bank's chrome.
    expect(markup).toContain("tools/list");
    // And the built-in it filtered, named rather than quietly dropped.
    expect(markup).toContain("System_ManageAuthorization");
  });
});

describe("the loan context", () => {
  test("the application under decision is on screen: borrower, amount, status", () => {
    const markup = renderToStaticMarkup(<LoanFileCard read={NORTHWIND} />);

    expect(markup).toContain("LN-2291");
    expect(markup).toContain("Northwind Bakery LLC");
    expect(markup).toContain("$95,000");
    expect(markup).toContain("pending");
    expect(markup).toContain("2,340,000");
  });

  test("a masked field is printed as the mask, not formatted away", () => {
    // What act 3 leaves behind once `/post` rewrites a field (#16). The screen
    // reads the loan book through the same governed path as everything else, so
    // it has to be able to show a value that came back redacted.
    const markup = renderToStaticMarkup(
      <LoanFileCard
        read={{
          loan_id: "LN-2291",
          outcome: "read",
          loan: { loan_id: "LN-2291", borrower_name: "Northwind Bakery LLC", amount: "[redacted]" },
        }}
      />,
    );

    expect(markup).toContain("[redacted]");
  });

  test("a refused read names the rule's own words and its audit row", () => {
    const markup = renderToStaticMarkup(
      <LoanFileCard
        read={{
          loan_id: "LN-2291",
          outcome: "denied",
          reason: "DENIED: analysts do not read complete files. [ref evt_kbfcdksrpk]",
          ref: "evt_kbfcdksrpk",
        }}
      />,
    );

    expect(markup).toContain("DENIED: analysts do not read complete files. [ref evt_kbfcdksrpk]");
    expect(markup).toContain("evt_kbfcdksrpk");
    expect(markup).toContain("audit log");
    // Not plumbing. The sentence the fault card uses must not appear here.
    expect(markup).not.toMatch(/no policy decision was made/i);
  });

  test("a broken loan book says nothing was decided, and never says refused", () => {
    const markup = renderToStaticMarkup(
      <LoanFileCard
        read={{ loan_id: "LN-2299", outcome: "fault", message: "connect ECONNREFUSED" }}
      />,
    );

    expect(markup).toContain("No policy decision was made and nothing was recorded");
    expect(markup).not.toMatch(/refused this read|denied by/i);
  });

  test("a missing credential is a link and describes a pending authorization", () => {
    const markup = renderToStaticMarkup(
      <LoanFileCard
        read={{
          loan_id: "LN-2291",
          outcome: "authorization",
          url: "https://cloud.arcade.dev/api/v1/oauth/flow/abc",
        }}
      />,
    );

    expect(markup).toContain(`href="https://cloud.arcade.dev/api/v1/oauth/flow/abc"`);
    expect(markup).toContain("This read is paused pending provider authorization");
    expect(markup).not.toMatch(/no policy decision was made/i);
  });

  test("a loan authorization card offers Continue and never renders an unsafe URL", () => {
    const markup = renderToStaticMarkup(
      <LoanFileCard
        read={{
          loan_id: "LN-2291",
          outcome: "authorization",
          url: "javascript:alert(1)",
          instructions: "Authorize the provider, then continue.",
        }}
        onContinueAuthorization={() => undefined}
      />,
    );

    expect(markup).not.toContain("javascript:");
    expect(markup).toContain("Complete provider authorization, then use Continue.");
    expect(markup).not.toContain("then reload");
    expect(markup).toContain('data-action="continue-loan-authorization"');
    expect(markup).toContain("Continue");
  });

  test("a signed-out reader is told where to go rather than shown an empty table", () => {
    const markup = renderToStaticMarkup(
      <LoanFilesView
        state={{ status: "refused", refusal: { error: "Nobody is signed in.", action: "signin" } }}
      />,
    );

    expect(markup).toContain("Nobody is signed in.");
    expect(markup).toContain(`href="${SIGNIN_PATH}"`);
  });

  test("the files say who they were read as", () => {
    const markup = renderToStaticMarkup(
      <LoanFilesView
        state={{
          status: "loaded",
          body: { reads: [NORTHWIND], actor: "alice@bank.example", tool: "Loan_GetLoan" },
        }}
      />,
    );

    expect(markup).toContain("alice@bank.example");
  });
});

/**
 * The trap this slice is named for.
 *
 * "Chat streams, shows tool calls as they happen, and renders denials without
 * looking like an error state." Before this slice a denial, a run failure and a
 * dead socket were all drawn in the same `#fdecea` box with the same `#b3261e`
 * border. Three claims about the world, one appearance — and the one the
 * audience reads is "the demo broke".
 */
describe("a denial is a decision, not an error", () => {
  const denied = renderToStaticMarkup(
    <EventView
      event={{
        kind: "denied",
        tool: "Loan_ApproveLoan",
        reason: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. [ref evt_kbfcdksrpk]",
        ref: "evt_kbfcdksrpk",
      }}
    />,
  );
  const fault = renderToStaticMarkup(
    <EventView
      event={{ kind: "fault", tool: "Loan_GetLoan", message: "connect ECONNREFUSED" }}
    />,
  );
  const failed = renderToStaticMarkup(
    <EventView event={{ kind: "error", message: "the provider returned 500" }} />,
  );

  test("it is announced as a decision, with the tool and the word", () => {
    expect(denied).toContain("Control plane decision");
    expect(denied).toContain("Loan_ApproveLoan");
    expect(denied).toContain("denied");
  });

  test("the rule author's sentence survives verbatim, correlation token and all", () => {
    expect(denied).toContain(
      "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. [ref evt_kbfcdksrpk]",
    );
  });

  test("it is not an alert; nothing went wrong", () => {
    expect(denied).not.toContain(`role="alert"`);
    expect(fault).toContain(`role="alert"`);
  });

  test("it does not wear the colours a failure wears", () => {
    // The specific inversion #22's issue warns about: a denial that looks like
    // a crash. Whatever the two palettes are, they may not be the same one.
    expect(background(denied)).not.toBe(background(fault));
    expect(background(denied)).not.toBe(background(failed));
    // …and the two kinds of failure look alike, because they are alike: nothing
    // decided anything in either.
    expect(background(fault)).toBe(background(failed));
  });

  test("a failure describes incomplete outcome and unknown side effects", () => {
    expect(fault).toContain("The tool outcome is incomplete");
    expect(fault).toContain("Any side effects are unknown");
    expect(failed).toContain("The turn is incomplete");
    expect(failed).toContain("Any side effects from attempted tools are unknown");
    expect(fault).not.toMatch(/no policy decision was made/i);
    expect(fault).not.toContain("nothing was recorded");
    expect(failed).not.toMatch(/no policy decision was made/i);
    expect(failed).not.toContain("nothing was recorded");
    expect(denied).toContain("Recorded in the audit log");
  });

  test("a persisted approval delivery failure keeps its detail without claiming nothing was recorded", () => {
    const deliveryFault = renderToStaticMarkup(
      <EventView
        event={{
          kind: "fault",
          tool: "Approvals_RequestApproval",
          message:
            "Approval request apr_j0ffxn5c05tg was recorded and routed to Charlie, but Slack method " +
            "users.lookupByEmail failed with error code invalid_arguments; the notice was not delivered. " +
            "Do not retry this approval request: retrying would create a duplicate.",
        }}
      />,
    );

    expect(deliveryFault).toContain("apr_j0ffxn5c05tg");
    expect(deliveryFault).toContain("users.lookupByEmail failed with error code invalid_arguments");
    expect(deliveryFault).toContain("The tool outcome is incomplete");
    expect(deliveryFault).toContain("Any side effects are unknown");
    expect(deliveryFault).not.toContain("nothing was recorded");
    expect(deliveryFault).not.toMatch(/no policy decision was made/i);
  });

  test("layer 2 is neither: a link, and no claim that anything was refused", () => {
    const authorization = renderToStaticMarkup(
      <EventView
        event={{
          kind: "authorization",
          tool: "Loan_GetLoan",
          url: "https://cloud.arcade.dev/api/v1/oauth/flow/abc",
        }}
      />,
    );

    expect(authorization).toContain(`href="https://cloud.arcade.dev/api/v1/oauth/flow/abc"`);
    expect(authorization).not.toContain("denied");
    expect(background(authorization)).not.toBe(background(denied));
  });

  test("a turn that ended waiting is neither: nothing refused, nothing broken", () => {
    // #20. Amber, like layer 2, because the claim about the world is the same:
    // no rule ran, nothing was refused, and what happens next belongs to a
    // person. A `waiting` card in the denial's colours would read as the demo
    // having been stopped, when what it is is the demo working.
    const waiting = renderToStaticMarkup(
      <EventView
        event={{
          kind: "waiting",
          tool: "Approvals_RequestApproval",
          request_id: "apr_0m4xq7bd91kz",
          approver: "Charlie",
          approver_id: "charlie@bank.example",
        }}
      />,
    );

    expect(waiting).toContain("Charlie");
    expect(waiting).toContain("apr_0m4xq7bd91kz");
    expect(waiting).not.toContain(`role="alert"`);
    expect(background(waiting)).not.toBe(background(denied));
    expect(background(waiting)).not.toBe(background(fault));
  });

  test("a resume shows the message it injected, verbatim", () => {
    // The one thing an audience can check about a resume is whether the agent
    // was told what to do or told what had happened. Hiding the injected
    // message would be asking them to take it on trust.
    const message =
      "Approval request apr_0m4xq7bd91kz — approve_loan on LN-2291 for 95000 — was approved " +
      "by Charlie (charlie@bank.example) at 2026-09-14T10:00:00.000Z.";
    const resumed = renderToStaticMarkup(
      <EventView
        event={{
          kind: "resumed",
          request_id: "apr_0m4xq7bd91kz",
          decision: "approved",
          decided_by: "charlie@bank.example",
          message,
        }}
      />,
    );

    expect(resumed).toContain(message);
    expect(resumed).not.toContain(`role="alert"`);
  });

  test("tool calls are shown as they happen, with their inputs", () => {
    const call = renderToStaticMarkup(
      <EventView
        event={{ kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: "LN-2291" } }}
      />,
    );

    expect(call).toContain("Loan_GetLoan");
    expect(call).toContain("LN-2291");
  });
});

/**
 * The fork seam.
 *
 * #22: "the layout is also the forking seam — a developer restyles the left and
 * keeps the right entirely, so keep the styling boundaries clean enough that
 * replacing the left touches no governance code."
 *
 * That is a claim nobody can keep by intention alone, so it is checked against
 * the source. The direction matters: the **left** may not reach into the right.
 * The shell may touch both — it is the seam — and is held to the narrower rule
 * that it uses the panel's two public entry points and none of its parts.
 */
describe("the fork seam", () => {
  const LEFT_HALF = ["components/bank", "components/chat"];

  function sourcesUnder(relative: string): Array<{ path: string; source: string }> {
    const directory = join(WEB, relative);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts") || name.endsWith(".css"))
      .map((name) => ({
        path: `${relative}/${name}`,
        // Comments stripped. Every file on this side of the seam explains where
        // the seam is and what is on the other side of it, and a rule that
        // could not be written about would be a rule nobody could follow.
        source: withoutComments(readFileSync(join(directory, name), "utf8")),
      }));
  }

  test("nothing in the left half imports a governance component", () => {
    for (const { path, source } of LEFT_HALF.flatMap(sourcesUnder)) {
      expect({ path, imports: /from\s+"[^"]*components\/governance/.test(source) }).toEqual({
        path,
        imports: false,
      });
    }
  });

  test("no governance class name is used on the left half", () => {
    // `cg-` is the panel's namespace and `app/globals.css` owns every one of
    // them. A left half that reached for `.cg-event` would break when the panel
    // restyled, which is the coupling this seam exists to prevent.
    for (const { path, source } of LEFT_HALF.flatMap(sourcesUnder)) {
      expect({ path, uses: /\bcg-[a-z]/.test(source) }).toEqual({ path, uses: false });
    }
  });

  test("the left half's stylesheet styles nothing but the left half", () => {
    const selectors = withoutComments(readFileSync(join(WEB, "components/bank/bank.css"), "utf8"));

    expect(selectors).not.toContain(".cg-");
    for (const selector of selectors.matchAll(/^\.([a-z-]+)/gm)) {
      expect(selector[1]).toStartWith("bank");
    }
  });

  test("the shell uses the panel as a whole surface, never as parts", () => {
    const source = readFileSync(join(WEB, "components/shell/SplitScreen.tsx"), "utf8");
    // `components/governance`, reached as `../governance/…` from here. Excluding
    // `lib/governance`, which is not the panel: `correlation.ts` is #6's join,
    // a module both surfaces are meant to share.
    const imported = [...source.matchAll(/from\s+"([^"]*governance\/([A-Za-z]+)\.tsx?)"/g)]
      .filter((match) => !(match[1] as string).includes("lib/governance"))
      .map((match) => match[2]);

    expect(imported.sort()).toEqual(["ControlPlanePanel", "PanelStreamError"]);
    // The same pair `app/panel/page.tsx` uses. Anything else — a lane, a card,
    // the decision table — would be this shell assembling the panel rather than
    // placing it, and #21 could no longer change its own insides.
    for (const internal of ["Lane", "EventCard", "MaskedDiff", "decisions", "ControlPlanePanelView"]) {
      expect(source).not.toContain(`governance/${internal}`);
    }
  });

  test("the paths the left half links to are the ones identity actually serves", () => {
    // `components/bank/LoanFiles.tsx` writes the two out rather than importing a
    // server module into a client component. A duplicated literal drifts; this
    // is what stops it.
    const source = readFileSync(join(WEB, "components/bank/LoanFiles.tsx"), "utf8");

    expect(source).toContain(`href: "${SIGNIN_PATH}"`);
    expect(source).toContain(`href: "${GATEWAY_START_PATH}"`);
  });

  test("the home shell owns Continue through Next router.refresh", () => {
    const page = readFileSync(join(WEB, "app/page.tsx"), "utf8");
    const boundary = readFileSync(join(WEB, "components/shell/HomeRefreshBoundary.tsx"), "utf8");

    expect(page).toContain("<HomeRefreshBoundary>");
    expect(boundary).toContain("router.refresh()");
  });

  /**
   * The other direction of the same claim: `apps/web` reads the loan book
   * through the gateway and by no other route. A direct database read would be
   * invisible on screen and would make the left half a liar — see
   * `lib/home/surface.ts`.
   */
  test("nothing this service serves opens the loan book directly", () => {
    for (const directory of ["lib", "app", "components"]) {
      for (const path of walk(join(WEB, directory))) {
        const source = readFileSync(path, "utf8");
        expect({ path, opens: /from\s+"bun:sqlite"/.test(source) }).toEqual({ path, opens: false });
        expect({ path, reaches: source.includes("LOAN_APP_PUBLIC_HOST") }).toEqual({
          path,
          reaches: false,
        });
      }
    }
  });
});

/**
 * Source with `/* … *\/` and `//` comments removed.
 *
 * Every seam test here reads prose as well as code, and the prose on this side
 * of the seam is mostly *about* the other side. A rule you cannot write down
 * without breaking it is not a rule anybody can follow.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts`/`.tsx` under `directory`, recursively. */
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Everything inside the left column, so a test can assert on that half alone. */
function leftHalf(markup: string): string {
  const start = markup.indexOf(`class="cg-split-left"`);
  const end = markup.indexOf(`class="cg-split-right"`);
  return markup.slice(start, end === -1 ? undefined : end);
}

/** The `background` an inline style set, so two cards can be compared without naming a hex. */
function background(markup: string): string {
  return /background:([^;"]+)/.exec(markup)?.[1]?.trim() ?? "none";
}

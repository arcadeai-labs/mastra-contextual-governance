/**
 * Hop 2 identity/tool binding, through the real local services.
 *
 * This is the narrow regression for #133. The verifier is the production
 * handler, `apps/idp` is a real Better Auth subprocess, and the Arcade stand-in
 * performs the provider code exchange against the real IdP token and userinfo
 * routes when it finalizes `next_uri`. The stand-in is still the only Arcade
 * boundary, but it now models the important order: auth requirements happen
 * before the tool call, and a grant is usable only when the confirmed persona
 * equals the OAuth identity Arcade obtained for that grant.
 *
 * The local path is correct when those identities agree: Loan_SearchLoans sees
 * the existing grant and does not issue a fresh challenge. A deliberately
 * mismatched provider identity reproduces the live symptom (a challenge before
 * the tool and hooks), proving the failure mode without claiming that the live
 * Arcade connection was mismatched. The remaining live-only gap is the
 * Arcade-side connection record/trace, which this repository cannot inspect
 * without changing provider configuration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { flowReference, identityReference } from "../lib/identity/verifier.ts";
import {
  Browser,
  PEOPLE,
  prepareProviderCode,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
} from "./identity-harness.ts";

let harness: IdentityHarness;

beforeAll(async () => {
  harness = await startIdentityHarness();
});

afterAll(async () => {
  await harness?.stop();
});

beforeEach(() => {
  harness.arcade.clearToolGrantsForTest();
  harness.arcade.confirmations.length = 0;
  harness.arcade.grantObservations.length = 0;
  harness.arcade.loanSearchCalls.length = 0;
  harness.arcade.nextUriFetches.length = 0;
  harness.arcade.nextUriHits.length = 0;
});

async function loanSearch(token: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.arcade.url}/mcp/cg-demo-us`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "loan-search",
      method: "tools/call",
      params: { name: "Loan_SearchLoans", arguments: {} },
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function setupFlow(
  browser: Browser,
  confirmedAs: "dana" | "sam",
  providerAs: "dana" | "sam",
): Promise<{ flowId: string; token: string }> {
  await signInAs(browser, harness, confirmedAs, { stopAt: "/api/arcade/start" });
  // A mismatch must come from a distinct real IdP session. Reusing Dana's
  // browser would correctly keep the IdP session as Dana and would not test
  // the identity split this regression is designed to expose.
  const providerBrowser = providerAs === confirmedAs ? browser : new Browser();
  if (providerBrowser !== browser) {
    await signInAs(providerBrowser, harness, providerAs, { stopAt: "/api/arcade/start" });
  }
  const provider = await prepareProviderCode(providerBrowser, harness, providerAs);
  const flowId = `hop2-${crypto.randomUUID()}`;
  // The code is retained inside the harness, never returned or logged. Binding
  // it before verify mirrors Arcade already holding the provider authorization
  // leg when it redirects to the custom verifier.
  harness.arcade.bindProviderCode(flowId, provider.authorizationState, provider.codeVerifier);
  const verified = await browser.fetch(`${harness.webUrl}/api/arcade/verify?flow_id=${flowId}`);
  expect(verified.status).toBe(200);
  return { flowId, token: harness.arcade.issueToolToken(PEOPLE[confirmedAs].email) };
}

describe("an already-authorized Dana-equivalent hop-2 grant", () => {
  test("finalizes through real cg-idp and Loan_SearchLoans receives that grant", async () => {
    const browser = new Browser();
    const before = (await harness.idpLog()).split("\n").filter((line) => line.includes("grant=authorization_code")).length;
    const { flowId, token } = await setupFlow(browser, "dana", "dana");
    const after = (await harness.idpLog()).split("\n").filter((line) => line.includes("grant=authorization_code")).length;

    // Sign-in used the real route once; finalizing next_uri adds another real
    // authorization_code exchange at the IdP. No test stub can satisfy this.
    expect(after).toBeGreaterThan(before);
    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: true },
    ]);
    expect(harness.arcade.nextUriFetches).toEqual([flowId]);
    expect(harness.arcade.grantObservations).toEqual([
      {
        flow_id: flowId,
        confirmed_user_id: PEOPLE.dana.email,
        effective_user_id: PEOPLE.dana.email,
        finalized: true,
      },
    ]);

    const called = await loanSearch(token);
    expect(called.response.status).toBe(200);
    expect(called.body.result).toBeDefined();
    expect(JSON.stringify(called.body)).not.toContain("authorization_url");
    expect(harness.arcade.loanSearchCalls).toEqual([
      { user_id: PEOPLE.dana.email, grant_flow_id: flowId, outcome: "grant" },
    ]);

    // The values are a test-only observation; the production diagnostic joins
    // the same three facts with fixed-length, non-secret references.
    expect(identityReference(harness.arcade.grantObservations[0]!.confirmed_user_id)).toBe(
      identityReference(harness.arcade.grantObservations[0]!.effective_user_id!),
    );
    expect(flowReference(flowId)).toMatch(/^flow_[0-9a-f]{16}$/);
    expect(identityReference(PEOPLE.dana.email)).toMatch(/^id_[0-9a-f]{16}$/);
  });

  test("a confirmed Dana flow with a Sam OAuth identity gets the live symptom", async () => {
    const browser = new Browser();
    const { flowId, token } = await setupFlow(browser, "dana", "sam");

    expect(harness.arcade.confirmations).toEqual([
      { flow_id: flowId, user_id: PEOPLE.dana.email, authorized: false },
    ]);
    expect(harness.arcade.grantObservations).toEqual([
      {
        flow_id: flowId,
        confirmed_user_id: PEOPLE.dana.email,
        effective_user_id: PEOPLE.sam.email,
        finalized: false,
      },
    ]);

    const challenged = await loanSearch(token);
    expect(challenged.response.status).toBe(200);
    expect(JSON.stringify(challenged.body)).toContain("authorization_url");
    expect(harness.arcade.loanSearchCalls).toEqual([
      { user_id: PEOPLE.dana.email, grant_flow_id: null, outcome: "fresh_challenge" },
    ]);
    // There is no grant and therefore no tool/hook execution to inspect — the
    // same upstream behavior described by the live report.
    expect(harness.arcade.nextUriFetches).toEqual([flowId]);
  });
});

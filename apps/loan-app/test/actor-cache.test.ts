/**
 * How often this service asks the identity provider who is calling — which is
 * the thing #166 was about, and the thing no existing test could see.
 *
 * The live failure was not a wrong answer. Every answer was right; there were
 * simply thirty of them a minute per open screen, the provider counts requests
 * on `/oauth2/userinfo`, and once its counter was full nobody could sign in.
 * A test that asserts only "the right email comes back" passes in both worlds.
 * So these drive repeated requests through `actorFromRequest` and assert the
 * **number of calls that reach the provider**, against a stand-in that counts
 * them. Nothing here is mocked: the stand-in is a real server on a real port
 * speaking the one endpoint this module uses, the same double
 * `test/api.test.ts` has always used.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import {
  ActorError,
  actorFromRequest,
  forgetRememberedActors,
  rememberedKeys,
  RESOLUTION_TTL_MS,
  tokenFingerprint,
} from "../src/actor.ts";

const ALICE = "alice@example.test";
const BOB = "bob@example.test";

/** What the stand-in provider does with the next request, and what it has seen. */
let answers: Record<string, string> = {};
let status: number | null = null;
let calls = 0;

let idp: Server<unknown>;
let idpHost: string;

beforeAll(() => {
  idp = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });

      calls++;
      // A forced status stands in for the provider refusing or throttling.
      if (status !== null) return new Response("refused", { status });

      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const email = token === undefined ? undefined : answers[token];
      if (email === undefined) return new Response("invalid_token", { status: 401 });

      return Response.json({ sub: email, email, email_verified: true });
    },
  });
  idpHost = `localhost:${idp.port}`;
});

afterAll(() => {
  idp?.stop(true);
});

afterEach(() => {
  forgetRememberedActors();
  answers = {};
  status = null;
  calls = 0;
});

/** One request from a bank screen, or from a tool, as the service sees it. */
function read(token: string): Request {
  return new Request("http://loan-app.test/loans", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function write(token: string): Request {
  return new Request("http://loan-app.test/loans/LN-2291/approve", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("how often the provider is asked", () => {
  test("thirty polls of one screen cost one call, not thirty", async () => {
    answers = { "tok-alice": ALICE };

    const seen = [];
    for (let poll = 0; poll < 30; poll++) seen.push(await actorFromRequest(read("tok-alice"), idpHost));

    // 30 polls is a minute of one screen at #157's 2s interval. The provider's
    // measured ceiling on this endpoint is 60 requests, so before this was
    // remembered a single screen spent half of it every minute.
    expect(calls).toBe(1);
    expect(new Set(seen)).toEqual(new Set([ALICE]));
  });

  test("two people are two answers, not one shared one", async () => {
    answers = { "tok-alice": ALICE, "tok-bob": BOB };

    expect(await actorFromRequest(read("tok-alice"), idpHost)).toBe(ALICE);
    expect(await actorFromRequest(read("tok-bob"), idpHost)).toBe(BOB);
    expect(await actorFromRequest(read("tok-alice"), idpHost)).toBe(ALICE);
    expect(await actorFromRequest(read("tok-bob"), idpHost)).toBe(BOB);

    expect(calls).toBe(2);
  });

  test("a write asks every time, however recently a read was answered", async () => {
    answers = { "tok-alice": ALICE };

    await actorFromRequest(read("tok-alice"), idpHost);
    expect(calls).toBe(1);

    expect(await actorFromRequest(write("tok-alice"), idpHost)).toBe(ALICE);
    expect(await actorFromRequest(write("tok-alice"), idpHost)).toBe(ALICE);

    // No entry in the loan book's decision history is taken on a remembered
    // token; that is what keeps the staleness bound from mattering.
    expect(calls).toBe(3);
  });
});

describe("how long an answer lasts", () => {
  test("it is still used at the last moment of its lifetime", async () => {
    answers = { "tok-alice": ALICE };
    const start = 1_700_000_000_000;

    await actorFromRequest(read("tok-alice"), idpHost, start);
    expect(await actorFromRequest(read("tok-alice"), idpHost, start + RESOLUTION_TTL_MS - 1)).toBe(ALICE);

    expect(calls).toBe(1);
  });

  test("it is not used a millisecond later", async () => {
    answers = { "tok-alice": ALICE };
    const start = 1_700_000_000_000;

    await actorFromRequest(read("tok-alice"), idpHost, start);
    await actorFromRequest(read("tok-alice"), idpHost, start + RESOLUTION_TTL_MS);

    expect(calls).toBe(2);
  });

  test("a token revoked behind our back is refused once the answer expires", async () => {
    answers = { "tok-alice": ALICE };
    const start = 1_700_000_000_000;

    expect(await actorFromRequest(read("tok-alice"), idpHost, start)).toBe(ALICE);

    // The provider stops recognising it — the person signed out, or an admin
    // revoked the grant.
    answers = {};

    expect(await actorFromRequest(read("tok-alice"), idpHost, start + 1)).toBe(ALICE);
    await expect(actorFromRequest(read("tok-alice"), idpHost, start + RESOLUTION_TTL_MS)).rejects.toThrow(
      /rejected the token/,
    );
  });

  test("a revoked token is refused on a write immediately, and the read stops working too", async () => {
    answers = { "tok-alice": ALICE };

    await actorFromRequest(read("tok-alice"), idpHost);
    answers = {};

    await expect(actorFromRequest(write("tok-alice"), idpHost)).rejects.toThrow(/rejected the token/);
    // The refusal erased what was held, so the next read does not sail on for
    // another minute on an answer the provider has just contradicted.
    expect(rememberedKeys()).toEqual([]);
    await expect(actorFromRequest(read("tok-alice"), idpHost)).rejects.toThrow(/rejected the token/);
  });
});

describe("what is never remembered", () => {
  test("a refusal is not remembered as a success", async () => {
    answers = { "tok-alice": ALICE };
    status = 401;

    await expect(actorFromRequest(read("tok-alice"), idpHost)).rejects.toThrow(ActorError);
    expect(rememberedKeys()).toEqual([]);
  });

  test("a 429 is not remembered at all, so a bad minute is not an outage", async () => {
    answers = { "tok-alice": ALICE };
    status = 429;

    // And it is not reported as a bad token either: 429 is the provider
    // saying something about itself. A person told their grant was rejected
    // would go and authorize again, which is not the recovery for this and
    // costs the one thing a rehearsal does not have (#123).
    const refusal = await actorFromRequest(read("tok-alice"), idpHost).then(
      (email) => new Error(`expected a refusal, resolved to ${email}`),
      (cause: unknown) => cause,
    );
    if (!(refusal instanceof ActorError)) throw refusal;
    expect(refusal.message).toBe(
      "The identity provider answered 429 and did not say whether this token is still good.",
    );
    // 503, not 401. The status is what the caller acts on, and a 401 here
    // would send a working sign-in back round the login page.
    expect(refusal.status).toBe(503);
    expect(rememberedKeys()).toEqual([]);

    // The moment the provider answers again, so does this service. A refusal
    // kept for a minute would have turned the provider's own one-minute
    // refusal window into a second minute of the loan book refusing everyone,
    // which is worse than the thing being fixed.
    status = null;
    expect(await actorFromRequest(read("tok-alice"), idpHost)).toBe(ALICE);
    expect(calls).toBe(2);
  });

  test("a provider that cannot be reached is a 503 and is not remembered", async () => {
    const nowhere = `localhost:${idp.port === 1 ? 2 : 1}`;

    const failed = await actorFromRequest(read("tok-alice"), nowhere).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(ActorError);
    expect((failed as ActorError).status).toBe(503);
    expect(rememberedKeys()).toEqual([]);
  });

  test("a response with no email is not remembered", async () => {
    answers = {};
    const noEmail = Bun.serve({ port: 0, fetch: () => Response.json({ sub: "someone" }) });
    try {
      await expect(actorFromRequest(read("tok-alice"), `localhost:${noEmail.port}`)).rejects.toThrow(
        /does not identify an email/,
      );
      expect(rememberedKeys()).toEqual([]);
    } finally {
      noEmail.stop(true);
    }
  });

  test("the bearer itself. Answers are filed under a digest of it", async () => {
    answers = { "tok-alice": ALICE };

    await actorFromRequest(read("tok-alice"), idpHost);

    const keys = rememberedKeys();
    expect(keys).toEqual([tokenFingerprint("tok-alice")]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    // The thing that must never be true: a live access token sitting in a map
    // in this process, where a heap dump or a careless log would hand someone
    // working credentials.
    expect(keys.join("|")).not.toContain("tok-alice");
  });

  test("the digest is per-token and says nothing about the token", () => {
    expect(tokenFingerprint("tok-alice")).toBe(tokenFingerprint("tok-alice"));
    expect(tokenFingerprint("tok-alice")).not.toBe(tokenFingerprint("tok-bob"));
    // Salted per process, so a digest lifted from here means nothing anywhere
    // else — including against a rainbow table of plausible tokens.
    expect(tokenFingerprint("tok-alice")).not.toBe(
      new Bun.CryptoHasher("sha256").update("tok-alice").digest("hex"),
    );
  });
});

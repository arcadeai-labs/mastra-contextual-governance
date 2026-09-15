/**
 * The sealed session cookie: what it protects, and what happens when it grows
 * past what a browser will hold.
 *
 * Two properties the demo rests on. The cookie holds a gateway bearer token, so
 * **it must be unreadable without `SESSION_SECRET`** — not merely signed, not
 * merely opaque-looking. And two JWTs plus an email exceed the 4KB a browser
 * gives one cookie, so **chunking is the normal case, not an edge**; a browser
 * that is handed an oversized `Set-Cookie` drops it silently, and the symptom
 * is a sign-in that appears to work and then forgets.
 */
import { describe, expect, test } from "bun:test";

import { readWebConfig } from "../lib/config.ts";
import { readCookies } from "../lib/identity/cookies.ts";
import { CHUNK_LIMIT, chunk, chunkName, clearedChunks, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, clearSession, readSession, writeSession, type Session } from "../lib/identity/session.ts";

const SECRET = "a-session-secret-for-the-suite-0123456789";

const config = (overrides: Record<string, string> = {}) =>
  readWebConfig({ SESSION_SECRET: SECRET, PUBLIC_URL: "https://cg-web-sa31.onrender.com", ...overrides });

/**
 * One byte of a sealed value, deterministically changed.
 *
 * XOR with `0x01`, so the byte always differs — and since base64url is
 * injective over byte arrays of the same length, the encoded string always
 * differs too. Every other way of "corrupting" a value this suite tried had a
 * silent no-op hiding in it.
 *
 * `part` is 1 for the nonce and 2 for the ciphertext-and-tag, matching
 * `v1.<iv>.<ciphertext+tag>`.
 */
function flipByte(sealed: string, part: 1 | 2, index: number): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[part]!, "base64url");
  bytes[index] = bytes[index]! ^ 0x01;
  parts[part] = bytes.toString("base64url");
  return parts.join(".");
}

/** A request carrying whatever `Set-Cookie` headers a previous response wrote. */
function requestCarrying(headers: Headers, url = "https://cg-web-sa31.onrender.com/"): Request {
  const jar = new Map<string, string>();
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0]!;
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === "" || /max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return new Request(url, {
    headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
  });
}

describe("the seal", () => {
  test("a sealed value opens back to what went in", async () => {
    const sealed = await seal({ email: "alice@bank.example", n: 1 }, SECRET);
    expect(await openSealed<{ email: string; n: number }>(sealed, SECRET)).toEqual({
      email: "alice@bank.example",
      n: 1,
    });
  });

  test("the contents are not readable without the key", async () => {
    const sealed = await seal({ email: "alice@bank.example" }, SECRET);
    // Not "hard to read" — absent. The address does not appear in the cookie in
    // any encoding a `grep` or a `base64 -d` would find.
    expect(sealed).not.toContain("dana");
    expect(Buffer.from(sealed.split(".")[2]!, "base64url").toString("utf8")).not.toContain("dana");
    expect(await openSealed(sealed, "a-different-secret-entirely-9876543210")).toBeNull();
  });

  test("a tampered byte does not open — every byte of the nonce and the ciphertext", async () => {
    const sealed = await seal({ email: "alice@bank.example" }, SECRET);

    // Every byte, both parts: the 12-byte nonce and the ciphertext with its
    // 16-byte GCM tag. Exhaustive rather than sampled, because the thing under
    // test is that *no* single-byte edit survives, and a spot check is a claim
    // about the byte it happened to pick.
    let checked = 0;
    for (const part of [1, 2] as const) {
      const length = Buffer.from(sealed.split(".")[part]!, "base64url").length;
      for (let index = 0; index < length; index += 1) {
        const flipped = flipByte(sealed, part, index);
        // Prove the edit landed before asserting what it costs. The previous
        // version of this test swapped the last two base64url characters, which
        // is a no-op whenever they are equal — round 2 of #84's review caught it
        // failing on a *valid* cookie, 147 times in 10,000. A tamper test that
        // can silently assert nothing is worse than no tamper test.
        expect(flipped).not.toBe(sealed);
        expect(await openSealed(flipped, SECRET)).toBeNull();
        checked += 1;
      }
    }

    // 12 nonce bytes + ciphertext + a 16-byte tag. The floor is a guard against
    // this loop quietly running zero times if the format ever changes.
    expect(checked).toBeGreaterThan(12 + 16);
  });

  test("truncating the tag does not open either", async () => {
    const sealed = await seal({ email: "alice@bank.example" }, SECRET);
    const body = Buffer.from(sealed.split(".")[2]!, "base64url");
    const parts = sealed.split(".");
    for (const dropped of [1, 8, 16]) {
      parts[2] = body.subarray(0, body.length - dropped).toString("base64url");
      expect(parts.join(".")).not.toBe(sealed);
      expect(await openSealed(parts.join("."), SECRET)).toBeNull();
    }
  });

  test("a value from another format version does not open", async () => {
    const sealed = await seal({ email: "alice@bank.example" }, SECRET);
    expect(await openSealed(sealed.replace(/^v1\./, "v2."), SECRET)).toBeNull();
  });

  test("junk, empty and truncated values are all just nothing", async () => {
    for (const value of ["", "not-a-cookie", "v1.short", "v1..", (await seal({}, SECRET)).slice(0, 20)]) {
      expect(await openSealed(value, SECRET)).toBeNull();
    }
  });

  test("sealing without a usable secret is refused rather than done weakly", async () => {
    // Both arms, because only the first one existed until round 1 of #84's
    // review — and `SESSION_SECRET=x` is the one a human produces.
    expect(seal({ email: "dana" }, "")).rejects.toThrow(/SESSION_SECRET is not set/);
    expect(seal({ email: "dana" }, "x")).rejects.toThrow(/at least 32 characters/);
  });
});

describe("chunking past 4KB", () => {
  test("a value longer than the limit becomes several cookies and joins back", async () => {
    // Two JWT-shaped tokens: what a real gateway response puts in this cookie.
    const session: Session = {
      email: "alice@bank.example",
      signed_in_at: 1_760_000_000_000,
      gateway: {
        access_token: `header.${"a".repeat(2600)}.signature`,
        refresh_token: `header.${"r".repeat(2600)}.signature`,
        expires_at: 1_760_000_600_000,
        client_id: "mcp-client-1",
      },
    };

    const headers = new Headers();
    const request = new Request("https://cg-web-sa31.onrender.com/");
    await writeSession(headers, request, session, config());

    const written = headers.getSetCookie();
    // The point of the test: this did not fit in one.
    expect(written.length).toBeGreaterThan(1);
    for (const raw of written) {
      // RFC 6265's floor, which Chrome and Firefox both enforce over the whole
      // `name=value; attrs` string. A cookie over it is dropped in silence.
      expect(raw.length).toBeLessThanOrEqual(4096);
    }

    const back = await readSession(requestCarrying(headers), config());
    expect(back).toEqual(session);
  });

  test("the chunks are named in order from zero and read back in that order", () => {
    const sealed = "x".repeat(CHUNK_LIMIT * 2 + 7);
    const pieces = chunk(sealed);
    expect(pieces).toHaveLength(3);
    const jar = new Map(pieces.map((piece, index) => [chunkName(SESSION_COOKIE, index), piece]));
    expect(joinChunks(SESSION_COOKIE, jar)).toBe(sealed);
  });

  test("a missing middle chunk reads as a prefix, and a prefix does not open", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "alice@bank.example",
        signed_in_at: 1,
        gateway: {
          access_token: "t".repeat(4000),
          expires_at: 2,
          client_id: "mcp-client-1",
        },
      },
      config(),
    );
    const request = requestCarrying(headers);
    const jar = readCookies(request);
    expect(jar.size).toBeGreaterThan(1);
    jar.delete(chunkName(SESSION_COOKIE, 1));
    // Stops at the gap rather than joining across it, so what comes back is a
    // prefix — and a prefix fails the cipher's own authentication.
    expect(await openSealed(joinChunks(SESSION_COOKIE, jar), SECRET)).toBeNull();
  });

  test("a session that shrinks expires the chunks it no longer uses", async () => {
    const long = new Headers();
    await writeSession(
      long,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "alice@bank.example",
        signed_in_at: 1,
        gateway: { access_token: "t".repeat(7000), expires_at: 2, client_id: "mcp-client-1" },
      },
      config(),
    );
    const wide = requestCarrying(long);
    expect(readCookies(wide).size).toBe(3);

    const short = new Headers();
    await writeSession(short, wide, { email: "bob@bank.example", signed_in_at: 3 }, config());

    // Every chunk beyond the one now needed is expired in the same response —
    // a leftover holding a fragment of the previous session would make every
    // later read fail, on every request, with no cause on screen.
    expect(short.getSetCookie().filter((raw) => /max-age=0/i.test(raw)).length).toBe(2);
    expect(await readSession(requestCarrying(short), config())).toEqual({
      email: "bob@bank.example",
      signed_in_at: 3,
    });
  });

  test("an orphan chunk at a discontinuous index is swept too", () => {
    const jar = new Map([
      [chunkName(SESSION_COOKIE, 0), "a"],
      [chunkName(SESSION_COOKIE, 5), "stale"],
      ["unrelated", "x"],
    ]);
    expect(clearedChunks(SESSION_COOKIE, jar, 1)).toEqual([chunkName(SESSION_COOKIE, 5)]);
  });

  test("signing out expires every chunk this browser holds", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "alice@bank.example",
        signed_in_at: 1,
        gateway: { access_token: "t".repeat(7000), expires_at: 2, client_id: "mcp-client-1" },
      },
      config(),
    );
    const signedIn = requestCarrying(headers);

    const cleared = new Headers();
    clearSession(cleared, signedIn, config());
    expect(cleared.getSetCookie()).toHaveLength(3);
    expect(await readSession(requestCarrying(cleared), config())).toBeNull();
  });
});

describe("the attributes a browser is given", () => {
  test("HttpOnly and Secure at an https origin", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      { email: "alice@bank.example", signed_in_at: 1 },
      config(),
    );
    for (const raw of headers.getSetCookie()) {
      expect(raw).toContain("HttpOnly");
      expect(raw).toContain("Secure");
      // Lax, not Strict: every one of these cookies has to survive a
      // cross-site navigation back from the IdP and from Arcade.
      expect(raw).toContain("SameSite=Lax");
      expect(raw).toContain("Path=/");
    }
  });

  test("Secure is dropped for a loopback PUBLIC_URL, because a browser would drop the cookie", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("http://localhost:4400/"),
      { email: "alice@bank.example", signed_in_at: 1 },
      config({ PUBLIC_URL: "http://localhost:4400" }),
    );
    for (const raw of headers.getSetCookie()) {
      expect(raw).toContain("HttpOnly");
      expect(raw).not.toContain("Secure");
    }
  });
});

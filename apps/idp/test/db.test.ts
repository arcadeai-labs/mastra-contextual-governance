/**
 * The people database: seeding, the one-transaction rule, and the reset that
 * leaves the OAuth client alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAuth, hashClientSecret } from "../src/auth.ts";
import { ensureOAuthClient } from "../src/client.ts";
import type { PersonSeed } from "../src/db.ts";
import { countPeople, listPeople, loadPeople, openPeople, resetPeople, seed } from "../src/db.ts";

const SECRET = "test-secret-".padEnd(48, "x");
const fixture = loadPeople({});

const ONE_PERSON: PersonSeed = {
  persona: "dana",
  name: "Placeholder Person",
  email: "placeholder@bank.example",
  password: "placeholder-2026",
};

/**
 * The `clientSecret` column, which since #70 holds a hash rather than
 * ciphertext. "the credentials are unchanged" used to be checkable by reading
 * the secret back; hashed storage means the observable form of that property
 * is the stored value itself — if it is the same bytes, the secret Arcade
 * holds still verifies.
 */
function storedSecret(db: Database): string {
  return db.query<{ clientSecret: string }, []>('SELECT "clientSecret" FROM "oauthClient"').get()!
    .clientSecret;
}

const tempDirs: string[] = [];
function tempDb(): string {
  const path = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
  tempDirs.push(dirname(path));
  return path;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the fixture", () => {
  test("holds the four personas from DESIGN.md's Cast table", () => {
    expect(fixture.map((p) => p.persona).sort()).toEqual(["dana", "morgan", "riley", "sam"]);
    expect(fixture.map((p) => p.name).sort()).toEqual([
      "Alice",
      "Bob",
      "Charlie",
      "Michael",
    ]);
  });

  test("the loan-officer role variable overrides one persona's address and nothing else", () => {
    const people = loadPeople({ PERSONA_LOAN_OFFICER_EMAIL: "  alice@example.com " });

    expect(people.find((p) => p.persona === "dana")?.email).toBe("alice@example.com");
    expect(people.find((p) => p.persona === "sam")?.email).toBe(
      fixture.find((p) => p.persona === "sam")?.email,
    );
  });

  test("an empty override is ignored — .env.example ships these blank", () => {
    const people = loadPeople({ PERSONA_VP_CREDIT_EMAIL: "" });
    expect(people.find((p) => p.persona === "riley")?.email).toBe(
      fixture.find((p) => p.persona === "riley")?.email,
    );
  });

  // #58. Better Auth lowercases the address before it looks a user up, so a
  // row stored with a capital is a persona nobody can sign in as — and the
  // login page calls that a wrong password. The Arcade accounts are invited by
  // hand, so the capitalisation arrives here from a human typing it.
  test("lowercases an override, whatever case the Arcade account was invited under", () => {
    const people = loadPeople({ PERSONA_LOAN_OFFICER_EMAIL: "  Alice@Example.Test " });

    expect(people.find((p) => p.persona === "dana")?.email).toBe("alice@example.test");
  });

  test("every address it hands back is already lower case", () => {
    const people = loadPeople({ PERSONA_CREDIT_ANALYST_EMAIL: "BOB@BANK.EXAMPLE" });

    expect(people.map((p) => p.email)).toEqual(people.map((p) => p.email.toLowerCase()));
  });

  test("rejects a deprecated name variable before fixture seeding can hide it", () => {
    expect(() => loadPeople({ PERSONA_DANA_EMAIL: "dana@example.com" })).toThrow(
      /PERSONA_DANA_EMAIL.*PERSONA_LOAN_OFFICER_EMAIL/,
    );
  });
});

describe("seeding", () => {
  test("bootstraps the fixture into an empty database", async () => {
    const db = await openPeople(":memory:");

    expect(countPeople(db)).toBe(4);
    expect(listPeople(db).map((p) => p.email).sort()).toEqual(fixture.map((p) => p.email).sort());
  });

  // The half of #58 that `loadPeople`'s unit test cannot see: what actually
  // reached the table.
  test("writes lowercase rows even when the personas are configured capitalised", async () => {
    const db = await openPeople(
      ":memory:",
      loadPeople({ PERSONA_LOAN_OFFICER_EMAIL: "Alice@Bank.Example" }),
    );

    expect(listPeople(db).map((p) => p.email)).toContain("alice@bank.example");
    expect(listPeople(db).some((p) => /[A-Z]/.test(p.email))).toBe(false);
  });

  test("a seed that fails leaves no schema, so the next boot retries", async () => {
    // Two personas with the same email pass the zod schema and violate the
    // unique index. If the schema were created outside the seed transaction,
    // the tables would survive the failed inserts, `hasSchema` would report
    // the database as seeded, and every later boot would come up green with
    // nobody able to log in — permanently, on a disk that persists.
    const db = new Database(":memory:");

    await expect(seed(db, [ONE_PERSON, ONE_PERSON])).rejects.toThrow(/UNIQUE/);
    expect(() => countPeople(db)).toThrow(/no such table/);

    await seed(db, [ONE_PERSON]);
    expect(countPeople(db)).toBe(1);
  });

  test("leaves an existing database alone — later boots are not a reset", async () => {
    const path = tempDb();

    const first = await openPeople(path);
    const ids = listPeople(first).map((p) => p.id);
    first.close();

    // A different fixture on the second open changes nothing: the database
    // already has a schema, so it is left as it is.
    const second = await openPeople(path, [ONE_PERSON]);
    const again = listPeople(second).map((p) => p.id);
    second.close();

    expect(again).toEqual(ids);
  });
});

describe("resetPeople", () => {
  test("re-seeds the people and keeps the OAuth client, credentials included", async () => {
    const path = tempDb();
    const db = await openPeople(path);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const before = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    const storedBefore = storedSecret(db);
    const peopleBefore = listPeople(db).map((p) => p.id);

    await resetPeople(db);

    const after = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(before.created).toBe(true);
    expect(after.created).toBe(false);
    expect(after.clientId).toBe(before.clientId);
    // The secret is readable exactly once, at creation; what survives the
    // reset is the stored hash, which is what the token endpoint checks.
    expect(before.clientSecret).toBeTruthy();
    expect(after.clientSecret).toBeNull();
    expect(storedSecret(db)).toBe(storedBefore);
    expect(storedBefore).toBe(await hashClientSecret(before.clientSecret!));

    // The people really were replaced, not left alone.
    expect(countPeople(db)).toBe(4);
    expect(listPeople(db).map((p) => p.id)).not.toEqual(peopleBefore);
    db.close();
  });

  test("clears sessions, tokens and consents along with the people", async () => {
    const db = await openPeople(":memory:");
    const person = listPeople(db)[0]!;
    const now = new Date().toISOString();

    db.query(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ('s1', $now, 't1', $now, $now, $user)`,
    ).run({ $now: now, $user: person.id });

    await resetPeople(db);

    expect(db.query('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthAccessToken"').get()).toEqual({ n: 0 });
  });

  test("the client is unowned, so deleting every user cannot cascade into it", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    await ensureOAuthClient(auth, { redirectUris: ["http://127.0.0.1:9/callback"], secret: SECRET });

    const row = db.query<{ userId: string | null }, []>('SELECT "userId" FROM "oauthClient"').get();
    expect(row?.userId).toBeNull();

    db.exec('DELETE FROM "user"');
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });
});

describe("ensureOAuthClient never rotates", () => {
  const redirectUris = ["http://127.0.0.1:9/callback"];

  /** A client row as an earlier build wrote it: generated id, found by name. */
  function insertLegacyRow(db: Database, name: string, clientId: string): void {
    db.query(
      `INSERT INTO "oauthClient" ("id", "clientId", "clientSecret", "name", "redirectUris", "createdAt", "updatedAt")
       VALUES ($id, $clientId, 'ciphertext', $name, '["http://127.0.0.1:9/callback"]', $now, $now)`,
    ).run({ $id: crypto.randomUUID(), $clientId: clientId, $name: name, $now: new Date().toISOString() });
  }

  test("adopts a row written under a generated id instead of minting a second client", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    // Written by a real bootstrap, then re-keyed to look like the earlier build's row.
    const original = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    const storedBefore = storedSecret(db);
    db.exec(`UPDATE "oauthClient" SET "id" = '${crypto.randomUUID()}'`);

    const adopted = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(adopted.created).toBe(false);
    expect(adopted.clientId).toBe(original.clientId);
    expect(storedSecret(db)).toBe(storedBefore);
    expect(db.query('SELECT "id" FROM "oauthClient"').all()).toEqual([{ id: "arcade" }]);
  });

  test("refuses to boot when client rows exist that it cannot recognise", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Something Else", "client-arcade-may-hold");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /Refusing to create another/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });

  test("refuses when two legacy rows share the name, rather than guess", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Arcade", "first");
    insertLegacyRow(db, "Arcade", "second");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /2 named "Arcade"/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 2 });
  });
});

describe("ensureOAuthClient", () => {
  test("two bootstraps at once still leave exactly one client", async () => {
    // The service booting on a fresh disk while someone runs `oauth-client`
    // in a shell: both look, both find nothing, both insert. The row has a
    // fixed primary key, so one insert loses and takes the winner's client.
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const [a, b] = await Promise.all([
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
    ]);

    expect(a.clientId).toBe(b.clientId);
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });

    // Exactly one of the two inserted the row, and only that one may hold the
    // secret: the loser adopted the winner's client and has nothing to print.
    const winners = [a, b].filter((result) => result.created);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.clientSecret).toBeTruthy();
    expect([a, b].find((result) => !result.created)!.clientSecret).toBeNull();
    expect(storedSecret(db)).toBe(await hashClientSecret(winners[0]!.clientSecret!));
  });

  test("brings the redirect URIs in line without touching the credentials", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    const first = await ensureOAuthClient(auth, { redirectUris: ["http://a/cb"], secret: SECRET });
    const storedBefore = storedSecret(db);
    const second = await ensureOAuthClient(auth, {
      redirectUris: ["http://a/cb", "http://b/cb"],
      secret: SECRET,
    });

    expect(second.clientId).toBe(first.clientId);
    expect(second.secretState).toBe("unchanged");
    expect(storedSecret(db)).toBe(storedBefore);
    expect(second.redirectUris).toEqual(["http://a/cb", "http://b/cb"]);

    const stored = db
      .query<{ redirectUris: string }, []>('SELECT "redirectUris" FROM "oauthClient"')
      .get();
    expect(JSON.parse(stored!.redirectUris)).toEqual(["http://a/cb", "http://b/cb"]);
  });
});

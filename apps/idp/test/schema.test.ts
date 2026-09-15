/**
 * `src/schema.sql` is generated from the installed Better Auth; the seed runs
 * it verbatim. A stale file is how the seed and the library end up disagreeing
 * about a column — which surfaces, if at all, as "Invalid email or password".
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { compileSchema } from "../src/schema.ts";

const SCHEMA_SQL = join(import.meta.dir, "..", "src", "schema.sql");

test("src/schema.sql matches what the installed Better Auth generates", async () => {
  const checkedIn = await Bun.file(SCHEMA_SQL).text();
  const fresh = await compileSchema(new Database(":memory:"));

  expect(checkedIn).toBe(fresh);
});

/**
 * #58's column-level defence, asserted as behaviour rather than as a
 * substring: `loadPeople` lowercases what it seeds, but a row inserted by
 * hand on the Render disk — or by a future Better Auth migration — is not
 * its to normalise, and a case-sensitive `email` makes that row a person who
 * cannot log in.
 */
describe("the user.email column is case-insensitive", () => {
  async function seeded(email: string): Promise<Database> {
    const db = new Database(":memory:");
    db.exec(await Bun.file(SCHEMA_SQL).text());
    db.exec(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('u1', 'Alice', '${email}', 1, '2026-09-10', '2026-09-10')`,
    );
    return db;
  }

  test("a row stored capitalised is found by the lowercased address Better Auth looks up", async () => {
    const db = await seeded("Alice@Bank.Example");

    const found = db
      .query<{ id: string }, []>(`SELECT "id" FROM "user" WHERE "email" = 'alice@bank.example'`)
      .get();

    expect(found?.id).toBe("u1");
  });

  test("the unique index is case-insensitive too, so one person cannot be seeded twice", async () => {
    const db = await seeded("alice@bank.example");

    expect(() =>
      db.exec(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES ('u2', 'Alice', 'ALICE@BANK.EXAMPLE', 1, '2026-09-10', '2026-09-10')`,
      ),
    ).toThrow(/UNIQUE/);
  });
});

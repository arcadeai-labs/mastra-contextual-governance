/**
 * An `idp.db` from before the JWT plugin must still open, keep its people and
 * its OAuth client, and gain the `jwks` table — the disk persists across
 * deploys (#29), so every schema change after the first meets a database that
 * predates it.
 *
 * #69: `openPeople` decided whether to run DDL by probing for the `user`
 * table, and `seed()` was the only thing that ran it, so a table added after a
 * disk existed could never appear on that disk. #70 adds exactly such a table.
 * The same bug shipped in `apps/hooks` and was measured in production on #60:
 * `cg-hooks` came up green and crash-looped on `no such table:
 * approval_requests`, and Render's Shell will not attach to a service that
 * keeps exiting.
 *
 * The second half of this file is the other thing a pre-#70 disk carries: an
 * OAuth client secret stored **encrypted**, which hashed storage can never
 * verify. The live `cg-idp` disk holds one, and the credentials in the Arcade
 * dashboard are the ones that row was born with.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAuth, hashClientSecret } from "../src/auth.ts";
import { ensureOAuthClient, OAUTH_CLIENT_ROW_ID } from "../src/client.ts";
import {
  countPeople,
  idempotentSchema,
  loadPeople,
  openPeople,
  readSchemaVersion,
  SCHEMA_VERSION,
  SchemaTooNewError,
} from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * `src/schema.sql` as it stood before #58 made `user.email` case-insensitive,
 * checked in rather than read out of git.
 *
 * It used to be `git show 3d2dd9d^:apps/idp/src/schema.sql`, which passes on a
 * full clone and fails in CI with `fatal: invalid object name '3d2dd9d^'` —
 * `actions/checkout@v4` fetches one commit by default. A test that reads
 * repository history is a test that does not run in the gate, which is worse
 * than one that fails there. Round 2 review on PR #71.
 */
const PRE_58_SCHEMA = join(import.meta.dir, "fixtures", "schema-pre-3d2dd9d.sql");
const SECRET = "test-secret-".padEnd(48, "x");
const OTHER_SECRET = "a-different-secret-".padEnd(48, "y");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const REDIRECT_URIS = [REDIRECT_URI];

/** The client id and secret a human typed into the Arcade dashboard on #13. */
const REGISTERED_CLIENT_ID = "aaaaBBBBccccDDDDeeeeFFFFgggg1234";
const REGISTERED_CLIENT_SECRET = "sssTTTuuuVVVwwwXXXyyyZZZ000111222333444555666777";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `cg-idp-upgrade-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A database as the **pre-#70** build left it: every table that build created,
 * the four seeded people, no `jwks`, and `PRAGMA user_version` at the SQLite
 * default of 0 because nothing recorded one.
 *
 * Built by seeding for real and then removing what #70 added, rather than by
 * checking in a copy of the old `schema.sql`. The old file and the new one
 * differ by exactly one statement — measured on this branch — so this produces
 * the same bytes, and it cannot drift away from the seeding the service
 * actually does.
 */
async function legacyDb(dir: string, storageSecret = SECRET): Promise<string> {
  const path = join(dir, "idp.db");
  const db = await openPeople(path);

  db.exec('DROP TABLE "jwks"');
  db.exec("PRAGMA user_version = 0");

  // The client row as the pre-#70 `ensureOAuthClient` wrote it: the secret
  // encrypted under BETTER_AUTH_SECRET, via Better Auth's own `symmetricEncrypt`.
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO "oauthClient"
       ("id", "clientId", "clientSecret", "name", "redirectUris", "scopes",
        "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType",
        "requirePKCE", "skipConsent", "disabled", "createdAt", "updatedAt")
     VALUES ($id, $clientId, $clientSecret, 'Arcade', $redirectUris,
             '["openid","profile","email","offline_access"]',
             'client_secret_post', '["authorization_code","refresh_token"]', '["code"]', 'web',
             1, 0, 0, $now, $now)`,
  ).run({
    $id: OAUTH_CLIENT_ROW_ID,
    $clientId: REGISTERED_CLIENT_ID,
    $clientSecret: await symmetricEncrypt({ key: storageSecret, data: REGISTERED_CLIENT_SECRET }),
    $redirectUris: JSON.stringify(REDIRECT_URIS),
    $now: now,
  });

  db.close();
  return path;
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function storedSecret(db: Database): string {
  return db.query<{ clientSecret: string }, []>('SELECT "clientSecret" FROM "oauthClient"').get()!
    .clientSecret;
}

/** A port the OS says is free — several worktrees run `bun test` at once. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("Bun.serve({ port: 0 }) reported no port");
  return port;
}

interface Booted {
  child: Subprocess;
  baseUrl: string;
  log: string;
  health: Record<string, any>;
}

/** Starts the service on `path`, waits for /health, and returns both plus the log. */
async function boot(path: string, secret: string): Promise<Booted> {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = join(dirname(path), `stdout-${port}.log`);

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  const child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      ...inherited,
      PORT: String(port),
      IDP_DB_PATH: path,
      IDP_PUBLIC_URL: baseUrl,
      IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
      BETTER_AUTH_SECRET: secret,
    },
    // stderr into the same file: a rotation is loud on stderr, and "the log"
    // is what `render logs` shows, which does not separate the two.
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`idp did not come up:\n${await Bun.file(logPath).text()}`);
    }
    await Bun.sleep(50);
  }

  return {
    child,
    baseUrl,
    log: await Bun.file(logPath).text(),
    health: (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, any>,
  };
}

describe("idempotentSchema", () => {
  test("rewrites the three forms Better Auth's compiler emits", () => {
    const rewritten = idempotentSchema(
      `-- a comment\n-- and another\ncreate table "a" ("x" text);\n\n` +
        `create index "a_x_idx" on "a" ("x");\n\ncreate unique index "a_x_uidx" on "a" ("x");`,
    );

    expect(rewritten).toContain('create table if not exists "a"');
    expect(rewritten).toContain('create index if not exists "a_x_idx"');
    expect(rewritten).toContain('create unique index if not exists "a_x_uidx"');
    // The comment header is not carried into a statement.
    expect(rewritten).not.toContain("-- a comment");
  });

  test("refuses a statement it cannot make idempotent, rather than dropping it", () => {
    // The failure this guards against is the one #69 is about: a statement
    // that silently does not run looks exactly like a schema already current.
    expect(() => idempotentSchema('alter table "a" add column "y" text;')).toThrow(
      /cannot make this statement idempotent/,
    );
  });

  test("replaying it against a database that already has everything is a no-op", async () => {
    const db = await openPeople(":memory:");
    const before = tables(db);

    db.exec(idempotentSchema(await Bun.file(join(ROOT, "src", "schema.sql")).text()));

    expect(tables(db)).toEqual(before);
    expect(countPeople(db)).toBe(4);
    db.close();
  });
});

describe("a disk written before the JWT plugin", () => {
  test("gains the jwks table and the version stamp, keeping every person", async () => {
    const path = await legacyDb(tempDir());

    const stale = new Database(path);
    expect(tables(stale)).not.toContain("jwks");
    expect(readSchemaVersion(stale)).toBe(0);
    stale.close();

    const db = await openPeople(path);

    expect(tables(db)).toContain("jwks");
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(countPeople(db)).toBe(4);
    db.close();
  });

  test("without the upgrade the service is broken, which is what #69 claims", async () => {
    // Opened the way the pre-#70 bootstrap opened it: straight to
    // `new Database`, no version check, no DDL, because `hasSchema` saw the
    // `user` table and called it seeded. This is the state `cg-idp` would have
    // deployed into, and the assertion below is the crash `cg-hooks` actually
    // took on #60 — measured here rather than asserted in a comment.
    const path = await legacyDb(tempDir());
    const db = new Database(path, { create: true });
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    // The table the JWT plugin needs is simply not there, and nothing on this
    // path was ever going to create it.
    expect(() => db.query('SELECT COUNT(*) AS n FROM "jwks"').get()).toThrow(/no such table: jwks/);

    // So the key set cannot be served: a 500 with no keys in it, from a
    // service whose /health would have answered 200 a moment earlier.
    const response = await auth.handler(new Request("http://localhost:1/jwks"));
    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(500);
    db.close();

    // And with the upgrade path, the same disk serves a key set.
    const upgraded = await openPeople(path);
    const withKeys = createAuth({ db: upgraded, baseURL: "http://localhost:1", secret: SECRET });
    const ok = await withKeys.handler(new Request("http://localhost:1/jwks"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { keys: unknown[] }).keys.length).toBeGreaterThanOrEqual(1);
    upgraded.close();
  });

  test("the upgrade inserts nothing — a restart is not a reset", async () => {
    const path = await legacyDb(tempDir());

    const before = await openPeople(path);
    const ids = before.query('SELECT "id" FROM "user" ORDER BY "id"').all();
    before.close();

    const after = await openPeople(path);
    expect(after.query('SELECT "id" FROM "user" ORDER BY "id"').all()).toEqual(ids);
    // The new table arrives empty; the first signature mints the key.
    expect(after.query('SELECT COUNT(*) AS n FROM "jwks"').get()).toEqual({ n: 0 });
    after.close();
  });

  test("refuses a database stamped newer than this build, before anything else happens", async () => {
    const path = await legacyDb(tempDir());
    const stamped = new Database(path);
    stamped.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 41}`);
    stamped.close();

    await expect(openPeople(path)).rejects.toThrow(SchemaTooNewError);
    // Named the file and the way out, rather than surfacing later as a
    // SQLiteError from whatever first touched the missing piece (#60).
    await expect(openPeople(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(openPeople(path)).rejects.toThrow(/user_version 42/);
  });
});

describe("the client secret on a pre-#70 disk", () => {
  test("is re-hashed in place, so the client id and secret both survive", async () => {
    const path = await legacyDb(tempDir());
    const db = await openPeople(path);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    const client = await ensureOAuthClient(auth, { redirectUris: REDIRECT_URIS, secret: SECRET });

    expect(client.secretState).toBe("migrated");
    expect(client.clientId).toBe(REGISTERED_CLIENT_ID);
    // Nothing readable comes back — storage is hashed now — but the stored
    // value is the hash of the very secret Arcade already holds, which is
    // what makes the registration still valid.
    expect(client.clientSecret).toBeNull();
    expect(storedSecret(db)).toBe(await hashClientSecret(REGISTERED_CLIENT_SECRET));
    db.close();
  });

  test("migrating twice is not a second migration", async () => {
    const path = await legacyDb(tempDir());
    const db = await openPeople(path);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    await ensureOAuthClient(auth, { redirectUris: REDIRECT_URIS, secret: SECRET });
    const hash = storedSecret(db);
    const again = await ensureOAuthClient(auth, { redirectUris: REDIRECT_URIS, secret: SECRET });

    expect(again.secretState).toBe("unchanged");
    expect(storedSecret(db)).toBe(hash);
    db.close();
  });

  test("rotates, and says so, when BETTER_AUTH_SECRET can no longer decrypt it", async () => {
    // Written under one secret, opened under another: the plaintext is
    // unrecoverable, and leaving the value would be a client that fails at the
    // token endpoint where no hook fires and the panel stays dark.
    const path = await legacyDb(tempDir(), OTHER_SECRET);
    const db = await openPeople(path);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    const client = await ensureOAuthClient(auth, { redirectUris: REDIRECT_URIS, secret: SECRET });

    expect(client.secretState).toBe("rotated");
    // The id is half of the Arcade registration and is not spent on this.
    expect(client.clientId).toBe(REGISTERED_CLIENT_ID);
    expect(client.clientSecret).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(storedSecret(db)).toBe(await hashClientSecret(client.clientSecret!));
    expect(storedSecret(db)).not.toBe(await hashClientSecret(REGISTERED_CLIENT_SECRET));
    db.close();
  });
});

/**
 * The criterion #70 states in so many words: a database created by the
 * previous version boots on the new code, gains the new tables, and **the boot
 * log and `/health` say what happened to the client secret**. Over HTTP,
 * against the service started exactly as Render starts it, because the boot
 * log only exists when something boots.
 */
describe("a pre-#70 disk, booted the way Render boots it", () => {
  const dana = loadPeople({}).find((person) => person.persona === "dana")!;


  /** Authorize → login → consent → token, with the credentials Arcade holds. */
  async function completeFlow(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
  ): Promise<Response> {
    const cookies = new Map<string, string>();
    const go = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) {
        headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      const response = await fetch(url, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const eq = pair!.indexOf("=");
        cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
      }
      return response;
    };
    const form = (fields: Record<string, string>): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(fields).toString(),
    });
    const queryOf = (location: string): string => new URL(location, baseUrl).search.slice(1);

    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const challenge = Buffer.from(
      new Bun.CryptoHasher("sha256").update(verifier).digest(),
    ).toString("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      state: "state-upgrade",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    let location = (await go(`${baseUrl}/oauth2/authorize?${params}`)).headers.get("location")!;
    location = (
      await go(
        `${baseUrl}/login`,
        form({ email: dana.email, password: dana.password, oauth_query: queryOf(location) }),
      )
    ).headers.get("location")!;
    if (/consent\?/.test(location)) {
      location = (
        await go(`${baseUrl}/consent`, form({ decision: "allow", oauth_query: queryOf(location) }))
      ).headers.get("location")!;
    }

    // HTTP Basic, RFC 6749 §2.3.1: the fixture row is registered
    // `client_secret_post`, and the boot under test reconciles it to
    // `client_secret_basic` (#61) without touching the credentials. So this is
    // both halves of the upgrade at once — the migrated secret, sent the new
    // way, against a row that arrived registered for the old one.
    const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    return fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${half(clientId)}:${half(clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(location).searchParams.get("code")!,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  }

  test("comes up, says the secret was migrated, and the registered credentials still work", async () => {
    const path = await legacyDb(tempDir());
    const booted = await boot(path, SECRET);

    try {
      expect(booted.health.status).toBe("ok");
      expect(booted.health.people).toBe(4);
      expect(booted.health.oauth.client_id).toBe(REGISTERED_CLIENT_ID);

      // What happened, in both of the two places a human looks.
      expect(booted.health.oauth.client_secret_state).toBe("migrated");
      expect(booted.health.oauth.client_secret_note).toContain("UNCHANGED");
      expect(booted.log).toContain("re-hashed in place");
      expect(booted.log).not.toContain("ROTATED");

      // The table #70 adds is being used, not merely present.
      expect(booted.health.oauth.jwks).toBe(`${booted.baseUrl}/jwks`);
      const keys = (await (await fetch(`${booted.baseUrl}/jwks`)).json()) as { keys: unknown[] };
      expect(keys.keys.length).toBeGreaterThanOrEqual(1);

      // The proof that the Arcade registration survived: the credentials a
      // human typed into the dashboard on #13 complete a whole flow.
      // The pre-#70 row also arrives registered `client_secret_post`; #61
      // reconciles it here, on the same boot, without a rotation.
      expect(booted.health.oauth.token_endpoint_auth_method).toBe("client_secret_basic");

      const token = await completeFlow(booted.baseUrl, REGISTERED_CLIENT_ID, REGISTERED_CLIENT_SECRET);
      expect(token.status).toBe(200);
      expect(((await token.json()) as { id_token?: string }).id_token).toBeTruthy();

      // And the secret is nowhere in the log, migrated or not.
      expect(booted.log).not.toContain(REGISTERED_CLIENT_SECRET);
    } finally {
      booted.child.kill();
      await booted.child.exited;
    }
  }, 40_000);

  test("says ROTATED, on stderr, when the secret could not be carried across", async () => {
    const path = await legacyDb(tempDir(), OTHER_SECRET);
    const booted = await boot(path, SECRET);

    try {
      // Still healthy — a dead IdP helps nobody — but unmistakable about the
      // one consequence: Arcade holds credentials that no longer work.
      expect(booted.health.status).toBe("ok");
      expect(booted.health.oauth.client_id).toBe(REGISTERED_CLIENT_ID);
      expect(booted.health.oauth.client_secret_state).toBe("rotated");
      expect(booted.health.oauth.client_secret_note).toContain("MUST be re-registered");
      expect(booted.log).toContain("ROTATED");
      expect(booted.log).toContain("re-registered");

      // The old secret really is dead, so this is not a false alarm.
      const token = await completeFlow(booted.baseUrl, REGISTERED_CLIENT_ID, REGISTERED_CLIENT_SECRET);
      expect(token.status).toBeGreaterThanOrEqual(400);
    } finally {
      booted.child.kill();
      await booted.child.exited;
    }
  }, 40_000);
});

/**
 * The other thing a disk written before this slice carries: a `user.email`
 * column with SQLite's default **case-sensitive** collation.
 *
 * #58 made the column `COLLATE NOCASE` and lowercased the seed, but it did so
 * in `schema.sql`, which only a fresh seed ever runs. The deployed `cg-idp`
 * disk kept the column it was born with, so a persona seeded as
 * `Alice@…` still could not log in — and the login page still called
 * that "That email and password did not match", the same sentence it gives a
 * wrong password. That is the failure #58 spent a whole sitting on, still live
 * on the one database that matters.
 *
 * The fixture is the real pre-#58 schema, read out of git rather than
 * transcribed, so it cannot drift into agreeing with the code under test.
 */
describe("a disk written before #58 made user.email case-insensitive", () => {
  const dana = loadPeople({}).find((person) => person.persona === "dana")!;
  /** As the loan-officer role address was set on `cg-idp` during the #13 sitting. */
  const CAPITALISED = "Alice@Bank.Example";

  /**
   * SHA-256 of `git show 3d2dd9d^:apps/idp/src/schema.sql` with `--` comment
   * lines and blank lines removed, which is what `sqlPayload` produces.
   *
   * Computed by applying `sqlPayload` to the real Git object and to the
   * checked-in fixture and confirming both digests matched, so this constant
   * encodes the pre-#58 schema itself rather than whatever the fixture
   * happens to hold today.
   */
  const PRE_58_PAYLOAD_SHA256 =
    "d8d2fe389a813ec5013edbfb2247d04ce4fe59c4d5fff040a43f9b9b6e5b0f92";

  /**
   * The executable part of a schema file: every line that is not a `--`
   * comment and not blank. SQLite ignores both, so two files with the same
   * payload create the same database.
   */
  function sqlPayload(text: string): string {
    return text
      .split("\n")
      .filter((line) => !line.startsWith("--") && line.trim() !== "")
      .join("\n");
  }

  test("the fixture's SQL payload is the pre-#58 schema, unmodified", async () => {
    // The fixture is not byte-identical to the Git object: it carries an
    // explanatory header saying where it came from and that it is frozen.
    // The header is the whole reason a reader can trust the file, so the
    // provenance claim is made about the payload instead — and checked here,
    // in CI, without reading repository history, which is the thing that made
    // round 2 pass locally and fail in the gate.
    const payload = sqlPayload(readFileSync(PRE_58_SCHEMA, "utf8"));
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ).toString("hex");

    expect(digest).toBe(PRE_58_PAYLOAD_SHA256);

    // Said again in a form that survives the hash: a digest mismatch alone
    // tells you something moved, not what, and the next person to see this
    // fail should not have to reconstruct why these tables are the point.
    expect(payload).toContain('"email" text not null unique');
    expect(payload.toLowerCase()).not.toContain("collate nocase");
    expect(payload).not.toContain('create table "jwks"');
    for (const table of ["user", "session", "account", "oauthClient", "oauthConsent"]) {
      expect(payload).toContain(`create table "${table}"`);
    }
    // Nothing but SQL survived the strip.
    expect(payload).not.toContain("--");
    expect(payload.split("\n").every((line) => line.trim() !== "")).toBe(true);
  });

  /** The frozen pre-#58 schema. See `PRE_58_SCHEMA`. */
  function schemaBefore58(): string {
    const sql = readFileSync(PRE_58_SCHEMA, "utf8");

    // If these ever stop holding, the fixture is no longer the thing the test
    // claims to be and a green run would mean nothing — so they are checked
    // against the `user` statement itself rather than the file, which also
    // carries a header explaining why it is frozen.
    const user = /create table "user" \([^;]*\)/i.exec(sql)?.[0];
    expect(user).toBeTruthy();
    expect(user).toContain('"email" text not null unique');
    expect(user!.toLowerCase()).not.toContain("collate nocase");
    expect(sql).not.toContain('create table "jwks"');
    return sql;
  }

  /** That schema, with one capitalised persona who can sign in with a password. */
  async function pre58Db(dir: string): Promise<string> {
    const path = join(dir, "idp.db");
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(schemaBefore58());

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ($id, $name, $email, 1, $now, $now)`,
    ).run({ $id: id, $name: dana.name, $email: CAPITALISED, $now: now });
    db.query(
      `INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
       VALUES ($aid, 'local:credential', $id, 'credential', $id, $password, $now, $now)`,
    ).run({
      $aid: crypto.randomUUID(),
      $id: id,
      $password: await hashPassword(dana.password),
      $now: now,
    });

    // A session and a consent, so the rebuild has children to keep: dropping
    // `user` with foreign keys live would cascade both into nothing.
    db.query(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ('s1', $now, 't1', $now, $now, $id)`,
    ).run({ $now: now, $id: id });
    db.query(
      `INSERT INTO "oauthClient"
         ("id", "clientId", "clientSecret", "name", "redirectUris", "createdAt", "updatedAt")
       VALUES ('arcade', $clientId, 'x', 'Arcade', '[]', $now, $now)`,
    ).run({ $clientId: REGISTERED_CLIENT_ID, $now: now });
    db.query(
      `INSERT INTO "oauthConsent" ("id", "clientId", "userId", "scopes", "createdAt", "updatedAt")
       VALUES ('c1', $clientId, $id, 'openid', $now, $now)`,
    ).run({ $clientId: REGISTERED_CLIENT_ID, $id: id, $now: now });

    db.close();
    return path;
  }

  test("the fixture really is broken before the upgrade runs", async () => {
    // Otherwise every assertion below could pass on a database that never had
    // the problem. Better Auth lowercases the address before it looks the row
    // up, and a case-sensitive `=` finds nothing.
    const path = await pre58Db(tempDir());
    const db = new Database(path);

    const found = db
      .query('select * from (select * from "user" where "user"."email" = ?) as p')
      .get(dana.email);
    expect(found).toBeNull();
    expect(db.query('SELECT "email" AS e FROM "user"').get()).toEqual({ e: CAPITALISED });

    db.close();
  });

  test("the upgrade rebuilds the column and lowercases the row, keeping the children", async () => {
    const path = await pre58Db(tempDir());
    const db = await openPeople(path);

    // The stored value is now the join key `apps/hooks` and the loan book hold.
    expect(db.query('SELECT "email" AS e FROM "user"').get()).toEqual({ e: dana.email });
    // And the comparison itself is case-insensitive, which is what the lookup
    // relies on — asserted with the exact query Better Auth runs.
    expect(
      db.query('select * from (select * from "user" where "user"."email" = ?) as p').get(CAPITALISED),
    ).not.toBeNull();

    // The rebuild dropped a table five others reference. Nothing cascaded.
    expect(db.query('SELECT COUNT(*) AS n FROM "account"').get()).toEqual({ n: 1 });
    expect(db.query('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 1 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // Foreign keys are back on for everything after the upgrade.
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });

    // Both migrations came from the one user_version step.
    expect(tables(db)).toContain("jwks");
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("running it again changes nothing", async () => {
    const path = await pre58Db(tempDir());
    const first = await openPeople(path);
    const rows = first.query('SELECT "id", "email" FROM "user"').all();
    first.close();

    const second = await openPeople(path);
    expect(second.query('SELECT "id", "email" FROM "user"').all()).toEqual(rows);
    // The scratch table is not left lying about.
    expect(tables(second)).not.toContain("user_rebuilding_for_nocase_email");
    second.close();
  });

  test("the capitalised persona can sign in, over HTTP, on the booted branch", async () => {
    // The reviewer's check on round 1, which this branch answered 401 to:
    // build the pre-#58 schema, insert a capitalised row, boot the service the
    // way Render boots it, and post the right password.
    const path = await pre58Db(tempDir());
    const booted = await boot(path, SECRET);

    try {
      expect(booted.health.status).toBe("ok");

      const signIn = await fetch(`${booted.baseUrl}/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: booted.baseUrl },
        body: JSON.stringify({ email: dana.email, password: dana.password }),
      });

      expect(signIn.status).toBe(200);

      // And through the login page a human actually uses, which is where the
      // misleading "did not match" came from.
      const page = await fetch(`${booted.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
        body: new URLSearchParams({ email: CAPITALISED, password: dana.password }).toString(),
        redirect: "manual",
      });
      expect(page.status).toBe(303);
    } finally {
      booted.child.kill();
      await booted.child.exited;
    }
  }, 40_000);

  test("refuses, and rolls back, when two people differ only by case", async () => {
    const path = await pre58Db(tempDir());
    const seeded = new Database(path);
    const now = new Date().toISOString();
    seeded.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ($id, 'Alice', $email, 1, $now, $now)`,
    ).run({ $id: crypto.randomUUID(), $email: dana.email, $now: now });
    seeded.close();

    // Which of the two is the person is not something a boot may decide.
    await expect(openPeople(path)).rejects.toThrow(/differ only by the case of their email/);

    const after = new Database(path);
    expect(after.query('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 2 });
    expect(readSchemaVersion(after)).toBe(0);
    after.close();
  });
});

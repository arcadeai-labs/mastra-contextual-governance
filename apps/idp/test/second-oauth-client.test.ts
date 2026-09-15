/**
 * A second OAuth client, and the promise that it costs the first nothing (#79).
 *
 * The human may hold two Arcade registrations against this one IdP — a User
 * Source and a custom OAuth provider — with two generated redirect URIs, and
 * may want them not to share a secret. So `IDP_OAUTH_CLIENTS` names extra
 * clients by key and each gets its own row: its own generated `client_id`, its
 * own hashed secret, its own redirect allowlist.
 *
 * Two things are measured here, and the second matters more than the first.
 * One: a second client works — it completes a flow, `oauth-client` prints it,
 * `--rotate` moves only its secret. Two: **with the variable unset nothing
 * changes**, because a feature that quietly alters the single-client path would
 * break the live `cg-idp` registration at the authorize step, where no hook
 * fires and the panel stays dark.
 *
 * Two services, each on its own `:0` port and its own disk, booted the way
 * Render boots them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadPeople } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const SECRET = "test-secret-".padEnd(48, "x");
const ARCADE_URI = "http://127.0.0.1:9/arcade-callback";
const USER_SOURCE_URI = "http://127.0.0.1:9/user-source-callback";

const people = loadPeople({});
const dana = people.find((person) => person.persona === "dana")!;

/** See `test/flow.test.ts::freePort` — bind `:0` and read it back, never guess. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("Bun.serve({ port: 0 }) reported no port");
  return port;
}

function basicAuth(id: string, secret: string): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${half(id)}:${half(secret)}`).toString("base64")}`;
}

function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest()).toString(
    "base64url",
  );
  return { verifier, challenge };
}

interface ClientEntry {
  key: string;
  name: string;
  client_id: string;
  client_secret: string | null;
  client_secret_state: string;
  redirect_uris: string[];
}

interface Health {
  oauth: {
    client_id: string;
    client_secret_state: string;
    clients: Array<{
      key: string;
      name: string;
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      client_secret_state: string;
    }>;
  };
}

/** One booted service, on its own disk, with the env its scripts need. */
class Service {
  child: Subprocess | null = null;
  readonly dbPath: string;
  baseUrl = "";
  env: Record<string, string> = {};

  constructor(private readonly extra: Record<string, string>) {
    this.dbPath = join(tmpdir(), `cg-idp-second-${crypto.randomUUID()}`, "idp.db");
  }

  async boot(): Promise<void> {
    const port = freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;

    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
      ),
    ) as Record<string, string>;

    this.env = {
      ...inherited,
      PORT: String(port),
      IDP_DB_PATH: this.dbPath,
      IDP_PUBLIC_URL: this.baseUrl,
      IDP_OAUTH_REDIRECT_URIS: ARCADE_URI,
      BETTER_AUTH_SECRET: SECRET,
      ...this.extra,
    };

    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${this.baseUrl}/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `idp did not come up:\n${await new Response(this.child.stderr as ReadableStream).text()}`,
        );
      }
      await Bun.sleep(50);
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  destroy(): void {
    this.stop();
    rmSync(dirname(this.dbPath), { recursive: true, force: true });
  }

  async health(): Promise<Health> {
    return (await (await fetch(`${this.baseUrl}/health`)).json()) as Health;
  }

  /** `oauth-client --json …`, with the exit status asserted rather than assumed. */
  async oauthClient(...args: string[]): Promise<{ code: number; json: Record<string, unknown>; err: string }> {
    const run = Bun.spawn(["bun", join(ROOT, "scripts", "oauth-client.ts"), "--json", ...args], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    return { code, err, json: code === 0 ? (JSON.parse(out) as Record<string, unknown>) : {}, };
  }

  /** The stored secret hashes, by row id, straight out of SQLite. */
  storedSecrets(): Record<string, string> {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const rows = db
        .query<{ id: string; clientSecret: string }, []>('SELECT "id", "clientSecret" FROM "oauthClient"')
        .all();
      return Object.fromEntries(rows.map((row) => [row.id, row.clientSecret]));
    } finally {
      db.close();
    }
  }

  /** Walks Alice through a whole flow for one client and returns the access token. */
  async completeFlow(
    client: { client_id: string; client_secret: string },
    redirectUri: string,
  ): Promise<string> {
    const cookies = new Map<string, string>();
    const visit = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) {
        headers.set(
          "cookie",
          [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
        );
      }
      const response = await fetch(url, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const eq = pair!.indexOf("=");
        cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
      }
      return response;
    };
    const submit = (url: string, fields: Record<string, string>) =>
      visit(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
        body: new URLSearchParams(fields).toString(),
      });

    const { verifier, challenge } = pkce();
    const authorize = await visit(
      `${this.baseUrl}/oauth2/authorize?` +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: "openid profile email offline_access",
          state: "state-" + crypto.randomUUID(),
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
    );
    let location = authorize.headers.get("location") ?? "";
    expect(location).not.toContain("error=");

    if (/\/login(\?|$)/.test(location)) {
      const login = await submit(`${this.baseUrl}/login`, {
        email: dana.email,
        password: dana.password,
        oauth_query: new URL(location, this.baseUrl).search.slice(1),
      });
      expect(login.status).toBe(303);
      location = login.headers.get("location") ?? "";
    }
    if (/\/consent\?/.test(location)) {
      const consent = await submit(`${this.baseUrl}/consent`, {
        decision: "allow",
        oauth_query: new URL(location, this.baseUrl).search.slice(1),
      });
      expect(consent.status).toBe(303);
      location = consent.headers.get("location") ?? "";
    }

    const code = new URL(location).searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(client.client_id, client.client_secret),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const body = (await token.json()) as { access_token?: string; error?: string };
    expect(body.error).toBeUndefined();
    expect(token.status).toBe(200);
    return body.access_token!;
  }
}

/** Two clients configured, with their own redirect allowlists. */
const two = new Service({
  IDP_OAUTH_CLIENTS: "arcade,arcade-user-source",
  IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE: USER_SOURCE_URI,
});

/** The shape every deployment has today, and the one that must not move. */
const one = new Service({});

let arcade: ClientEntry;
let userSource: ClientEntry;

/** `oauth-client --client <key> --rotate` and the entry it printed. */
async function rotate(service: Service, key: string): Promise<ClientEntry> {
  const { code, err, json } = await service.oauthClient("--client", key, "--rotate");
  expect(err).toBe("");
  expect(code).toBe(0);
  const entry = (json.clients as ClientEntry[]).find((each) => each.key === key)!;
  expect(entry.client_secret).toBeTruthy();
  return entry;
}

beforeAll(async () => {
  await two.boot();
  await one.boot();

  // Both clients were created on the boot above, so both secrets are hashed
  // and gone. Rotate each once for a readable one — and rotating them one at a
  // time is itself the independence claim, checked below.
  arcade = await rotate(two, "arcade");
  userSource = await rotate(two, "arcade-user-source");
});

afterAll(() => {
  two.destroy();
  one.destroy();
});

describe("with IDP_OAUTH_CLIENTS naming a second client", () => {
  test("both clients exist, with different ids and different redirect allowlists", async () => {
    const health = await two.health();

    expect(health.oauth.clients.map((each) => each.key)).toEqual(["arcade", "arcade-user-source"]);
    expect(arcade.client_id).not.toBe(userSource.client_id);
    expect(arcade.client_secret).not.toBe(userSource.client_secret);

    const [first, second] = health.oauth.clients;
    expect(first!.redirect_uris).toEqual([ARCADE_URI]);
    expect(second!.redirect_uris).toEqual([USER_SOURCE_URI]);
    expect(second!.token_endpoint_auth_method).toBe("client_secret_basic");

    // The pre-#79 fields still describe the first client, so anything that
    // read /health before — the spike's own scripts among them — is unmoved.
    expect(health.oauth.client_id).toBe(arcade.client_id);
  });

  test("each client completes a whole flow, on its own redirect URI", async () => {
    const token = await two.completeFlow(
      { client_id: arcade.client_id, client_secret: arcade.client_secret! },
      ARCADE_URI,
    );
    const who = await fetch(`${two.baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await who.json()) as { email: string }).email).toBe(dana.email);

    const secondToken = await two.completeFlow(
      { client_id: userSource.client_id, client_secret: userSource.client_secret! },
      USER_SOURCE_URI,
    );
    expect(secondToken).toBeTruthy();
  });

  test("a client's redirect allowlist is its own — the other's URI is refused", async () => {
    const authorize = await fetch(
      `${two.baseUrl}/oauth2/authorize?` +
        new URLSearchParams({
          response_type: "code",
          client_id: userSource.client_id,
          redirect_uri: ARCADE_URI,
          scope: "openid email",
          state: "state-cross",
        }),
      { redirect: "manual" },
    );
    const location = authorize.headers.get("location") ?? "";
    expect(location).toContain("error=");
    expect(location).not.toContain("code=");
  });

  test("rotating the second client leaves the first's stored secret untouched", async () => {
    const before = two.storedSecrets();

    const rotated = await rotate(two, "arcade-user-source");
    expect(rotated.client_id).toBe(userSource.client_id);
    expect(rotated.client_secret).not.toBe(userSource.client_secret);

    const after = two.storedSecrets();
    expect(after.arcade).toBe(before.arcade!);
    expect(after["arcade-user-source"]).not.toBe(before["arcade-user-source"]!);

    // And the first client still authenticates with the secret it always had.
    const token = await two.completeFlow(
      { client_id: arcade.client_id, client_secret: arcade.client_secret! },
      ARCADE_URI,
    );
    expect(token).toBeTruthy();
    userSource = rotated;
  });

  test("--rotate without --client refuses rather than guess which registration it costs", async () => {
    const before = two.storedSecrets();

    const run = Bun.spawn(["bun", join(ROOT, "scripts", "oauth-client.ts"), "--json", "--rotate"], {
      env: two.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);

    expect(code).toBe(2);
    expect(err).toContain("--rotate needs --client");
    expect(err).toContain("arcade-user-source");
    // The exit status is asserted *and* the disk: a script that printed the
    // right complaint and rotated anyway would pass a stderr-only check.
    expect(two.storedSecrets()).toEqual(before);
  });

  test("the printed document lists every client, and prints each secret once", async () => {
    const { code, json } = await two.oauthClient();
    expect(code).toBe(0);

    const listed = json.clients as ClientEntry[];
    expect(listed.map((each) => each.key)).toEqual(["arcade", "arcade-user-source"]);
    // Hashed storage: a plain run has nothing to print for either of them.
    expect(listed.every((each) => each.client_secret === null)).toBe(true);
    expect(listed.every((each) => each.client_secret_state === "unchanged")).toBe(true);
  });
});

describe("with IDP_OAUTH_CLIENTS unset", () => {
  test("there is exactly one client, and /health says so", async () => {
    const health = await one.health();

    expect(health.oauth.clients).toHaveLength(1);
    expect(health.oauth.clients[0]!.key).toBe("arcade");
    expect(health.oauth.clients[0]!.client_id).toBe(health.oauth.client_id);
    expect(health.oauth.clients[0]!.redirect_uris).toEqual([ARCADE_URI]);
  });

  test("--rotate still needs no flag, because there is nothing to choose between", async () => {
    const { code, err, json } = await one.oauthClient("--rotate");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(json.client_secret).toBeTruthy();
    expect(json.rotated).toBe(true);

    const token = await one.completeFlow(
      { client_id: json.client_id as string, client_secret: json.client_secret as string },
      ARCADE_URI,
    );
    expect(token).toBeTruthy();
  });

  test("reset leaves both the single client and, elsewhere, both clients alone", async () => {
    const singleBefore = one.storedSecrets();
    const pairBefore = two.storedSecrets();

    for (const service of [one, two]) {
      const run = Bun.spawn(["bun", join(ROOT, "scripts", "reset.ts")], {
        env: service.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("unchanged");
    }

    expect(one.storedSecrets()).toEqual(singleBefore);
    expect(two.storedSecrets()).toEqual(pairBefore);
  });
});

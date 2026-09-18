/**
 * Drives this service's rate limiter over the wire and prints what it measures.
 *
 * The limiter is on only under `NODE_ENV=production`
 * (`enabled: options.rateLimit?.enabled ?? isProduction`), which every
 * Dockerfile here sets and no test does — that is the whole reason #166 was
 * invisible until a live rehearsal. So this boots the service the way Render
 * boots it, on an OS-assigned port, against a throwaway database, with a
 * secret generated in memory for this run and never written anywhere.
 *
 * Two modes:
 *
 *     bun scripts/rate-limit-drill.ts ceilings
 *         For each rate-limited path, sends requests until one is refused and
 *         reports how many were allowed first. Nothing is authenticated: a
 *         request that gets past the limiter answers 401/400/415, and one that
 *         does not answers 429, so the ceiling is measurable without a
 *         credential.
 *
 *     bun scripts/rate-limit-drill.ts rehearsal --minutes 16 --tokens 8
 *         Replays a rehearsal's shape in real time: `--tokens` distinct bearer
 *         tokens, each re-resolved once every 60 seconds because that is what
 *         `apps/loan-app`'s resolution cache does (`RESOLUTION_TTL_MS`), with
 *         their phases spread evenly across the minute. Every five minutes it
 *         also fires the burst a stage reset produces — four personas signing
 *         in again and re-authorizing. Reports every refusal, with the minute
 *         it happened in.
 *
 * Output is JSONL on stdout: one object per measurement, so a run can be
 * pasted into an issue as evidence rather than summarised.
 */
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** How long one `apps/loan-app` resolution is reused — `RESOLUTION_TTL_MS`. */
const RESOLUTION_TTL_MS = 60_000;

/** Personas signed in during a rehearsal. DESIGN.md names four. */
const PERSONAS = 4;

/**
 * A port the OS says is free, rather than a guess. Same reasoning as
 * `test/flow.test.ts::freePort`: several worktrees run at once here, and a
 * guessed port makes a slice fail for a reason that is not in its diff.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("Bun.serve({ port: 0 }) reported no port");
  return port;
}

function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

interface Idp {
  baseUrl: string;
  child: Subprocess;
  dir: string;
}

/**
 * Boots `src/index.ts` exactly as the Dockerfile does, with `NODE_ENV=production`
 * so the limiter is on.
 *
 * The secret is 32 random bytes made here, held in the child's environment and
 * nowhere else: no file, no `.env.local`, no argument another process could
 * read off a process listing. It signs nothing that outlives the run — the
 * database is a fresh temporary directory removed on the way out.
 */
async function bootIdp(): Promise<Idp> {
  const dir = mkdtempSync(join(tmpdir(), "cg-idp-drill-"));
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;

  const child = spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      ...inherited,
      NODE_ENV: "production",
      PORT: String(port),
      IDP_DB_PATH: join(dir, "idp.db"),
      IDP_PUBLIC_URL: baseUrl,
      IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
      BETTER_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    },
    stdout: "ignore",
    stderr: "inherit",
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
      throw new Error("idp did not come up within 20s");
    }
    await Bun.sleep(50);
  }

  return { baseUrl, child, dir };
}

function shutdown(idp: Idp): void {
  idp.child.kill();
  rmSync(idp.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------

/**
 * One unauthenticated request per rate-limited path.
 *
 * Each returns a status that proves it reached the route rather than the
 * limiter — 401 for a bearer nobody issued, 400/415 for a malformed grant —
 * so "allowed" and "refused" are distinguishable without holding a credential.
 */
const PROBES: Record<string, (baseUrl: string, nonce: string) => Promise<Response>> = {
  "/oauth2/userinfo": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/userinfo`, { headers: { authorization: `Bearer drill-${nonce}` } }),
  "/oauth2/token": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=drill-${nonce}&client_id=drill&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback`,
    }),
  "/oauth2/authorize": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/authorize?client_id=drill-${nonce}&response_type=code`, { redirect: "manual" }),
  "/oauth2/introspect": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=drill-${nonce}`,
    }),
  "/oauth2/revoke": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=drill-${nonce}`,
    }),
  "/oauth2/register": (baseUrl, nonce) =>
    fetch(`${baseUrl}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `drill-${nonce}`, redirect_uris: ["http://127.0.0.1:9/callback"] }),
    }),
  "/sign-in/email": (baseUrl, nonce) =>
    fetch(`${baseUrl}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Nobody's address: a seeded persona's row must not collect failed
      // attempts because a measurement ran.
      body: JSON.stringify({ email: `drill-${nonce}@example.invalid`, password: "not-the-password" }),
    }),
};

/** Sends requests to one path until one is refused. Returns how many were allowed. */
async function measureCeiling(baseUrl: string, path: string, cap: number): Promise<void> {
  const probe = PROBES[path]!;
  const statuses = new Set<number>();
  for (let sent = 1; sent <= cap; sent++) {
    const response = await probe(baseUrl, String(sent));
    if (response.status === 429) {
      emit({ measurement: "ceiling", path, allowedBefore429: sent - 1, allowedStatuses: [...statuses] });
      return;
    }
    statuses.add(response.status);
  }
  emit({ measurement: "ceiling", path, allowedBefore429: null, sentWithoutRefusal: cap, allowedStatuses: [...statuses] });
}

async function ceilings(): Promise<void> {
  const idp = await bootIdp();
  try {
    emit({ measurement: "boot", nodeEnv: "production", baseUrl: idp.baseUrl });
    // Buckets are keyed `<ip>|<path>`, so one path's exhaustion does not touch
    // another's and all four can be measured against one booted service.
    for (const path of Object.keys(PROBES)) await measureCeiling(idp.baseUrl, path, 4_000);
  } finally {
    shutdown(idp);
  }
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

interface Tally {
  sent: number;
  refused: number;
  firstRefusalMs: number | null;
}

/** The paths a rehearsal drives. The other three are measured, never driven. */
const REHEARSED = ["/oauth2/userinfo", "/oauth2/token", "/oauth2/authorize", "/sign-in/email"];

function tallies(): Record<string, Tally> {
  return Object.fromEntries(REHEARSED.map((path) => [path, { sent: 0, refused: 0, firstRefusalMs: null }]));
}

async function fire(
  idp: Idp,
  path: string,
  nonce: string,
  tally: Record<string, Tally>,
  startedAt: number,
): Promise<void> {
  const entry = tally[path]!;
  entry.sent += 1;
  const response = await PROBES[path]!(idp.baseUrl, nonce);
  if (response.status !== 429) return;
  entry.refused += 1;
  const at = Date.now() - startedAt;
  if (entry.firstRefusalMs === null) entry.firstRefusalMs = at;
  emit({ measurement: "refusal", path, atMs: at, atMinute: Math.floor(at / 60_000), nonce });
}

/**
 * The traffic a rehearsal makes, in real time.
 *
 * Steady state is `tokens` distinct bearers each re-resolved once per
 * {@link RESOLUTION_TTL_MS}, because that is what `apps/loan-app` does once its
 * cache is warm: the poll interval no longer matters, the number of *distinct
 * tokens* does. Phases are spread evenly across the minute, which is the worst
 * arrangement for the limiter's silence-reset — it is the one that leaves the
 * smallest quiet gap between consecutive calls.
 *
 * Every five minutes a reset burst lands on top: four personas signing in
 * again, each costing one `/sign-in/email`, two `/oauth2/authorize` (the bank's
 * own client and Arcade's), three `/oauth2/token` (one from `apps/web`, two
 * from Arcade, which exchanges the code twice — open risk 9) and two
 * `/oauth2/userinfo` (one from `apps/web`'s callback, one from Arcade reading
 * the email claim).
 */
async function rehearsal(minutes: number, tokens: number): Promise<void> {
  const idp = await bootIdp();
  const tally = tallies();
  const startedAt = Date.now();
  const endAt = startedAt + minutes * 60_000;
  try {
    emit({ measurement: "rehearsal-start", minutes, tokens, resolutionTtlMs: RESOLUTION_TTL_MS, personas: PERSONAS });

    const spacingMs = RESOLUTION_TTL_MS / tokens;
    const steady = Array.from({ length: tokens }, async (_unused, index) => {
      await Bun.sleep(index * spacingMs);
      while (Date.now() < endAt) {
        await fire(idp, "/oauth2/userinfo", `token-${index}`, tally, startedAt);
        await Bun.sleep(RESOLUTION_TTL_MS);
      }
    });

    const bursts = (async () => {
      for (let minute = 5; minute <= minutes; minute += 5) {
        const until = startedAt + minute * 60_000;
        while (Date.now() < until) await Bun.sleep(250);
        if (Date.now() >= endAt) return;
        emit({ measurement: "reset-burst", atMinute: minute, personas: PERSONAS });
        for (let persona = 0; persona < PERSONAS; persona++) {
          const who = `m${minute}-p${persona}`;
          await fire(idp, "/sign-in/email", who, tally, startedAt);
          for (let n = 0; n < 2; n++) await fire(idp, "/oauth2/authorize", `${who}-${n}`, tally, startedAt);
          for (let n = 0; n < 3; n++) await fire(idp, "/oauth2/token", `${who}-${n}`, tally, startedAt);
          for (let n = 0; n < 2; n++) await fire(idp, "/oauth2/userinfo", `${who}-${n}`, tally, startedAt);
        }
      }
    })();

    await Promise.all([...steady, bursts]);

    const refused = Object.values(tally).reduce((sum, entry) => sum + entry.refused, 0);
    emit({
      measurement: "rehearsal",
      minutes,
      tokens,
      ranForMs: Date.now() - startedAt,
      totalRefused: refused,
      byPath: tally,
    });
  } finally {
    shutdown(idp);
  }
}

// ---------------------------------------------------------------------------

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number`);
  return value;
}

const mode = process.argv[2];
if (mode === "ceilings") {
  await ceilings();
} else if (mode === "rehearsal") {
  await rehearsal(flag("minutes", 16), flag("tokens", 8));
} else {
  console.error("usage: rate-limit-drill.ts ceilings | rehearsal [--minutes N] [--tokens N]");
  process.exit(2);
}

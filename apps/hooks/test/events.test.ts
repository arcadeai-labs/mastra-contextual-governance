/**
 * `GET /events`, over HTTP, against a real server on a real socket.
 *
 * Nothing here mocks the bus, the log or the stream. Every assertion is made on
 * bytes that came out of a `fetch` against `createServer`, because the two
 * things most likely to be wrong about an SSE endpoint — the frame layout the
 * panel parses, and what a client gets back after the connection drops — are
 * invisible to a test that calls the handler directly.
 *
 * The reader (`sse-reader.ts`) is deliberately *not* `apps/web`'s decoder: this
 * package cannot import an app, and a test that shared the client's parser
 * could not catch the two of them agreeing on something wrong. It reads only
 * what the contract says is there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createEventBus, type EventBus } from "@cg/governance-core";
import { GovernanceEvent } from "@cg/policy-schema";

import { newEventId, record } from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { GOVERNANCE_EVENT_NAME, handleEvents, STREAM_BACKLOG_LIMIT } from "../src/events.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";
// The reader lives beside this file since #20 needed it for the second event
// name on the same socket. Same parser, same contract, one copy.
import { openEventStream as open, type Frame, type Reader } from "./sse-reader.ts";

const SECRET = "test-secret";
const STORE_TOKEN = "test-store-token";
const DANA = "alice@bank.example";
const SAM = "bob@bank.example";

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  approvalsStoreToken: STORE_TOKEN,
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: 250,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: "",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: Database;
let cache: PolicyCache;
let bus: EventBus;
let server: ReturnType<typeof createServer>;
let base: string;
let logs: string[];

/** Boots a server. `backlogLimit` reaches the cap without writing 25,000 rows. */
function boot(backlogLimit?: number): void {
  logs = [];
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { log: (line) => logs.push(line), pollMs: 10 });
  cache.start();
  bus = createEventBus({ onSubscriberError: (cause) => logs.push(`subscriber: ${String(cause)}`) });
  server = createServer({
    config,
    db,
    cache,
    bus,
    log: (line) => logs.push(line),
    streamKeepAliveMs: 60,
    ...(backlogLimit !== undefined && { streamBacklogLimit: backlogLimit }),
  });
  base = `http://localhost:${server.port}`;
}

beforeEach(() => boot());

afterEach(() => {
  cache.stop();
  server.stop(true);
  db.close();
});

const V = [{ version: "1.0.0" }];

/** A `/pre` that Alice is refused, which is one audit row and one event. */
const denyDana = (executionId: string) =>
  fetch(`${base}/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      execution_id: executionId,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: "LN-2291", amount: 95_000 },
      context: { authorization: [{}], user_id: DANA },
    }),
  });

interface SeedOptions {
  /** Announce the rows on the bus too, as a real decision would. */
  readonly stream?: boolean;
  /** Bytes of filler in `reason`, to make a socket's buffer fill for real. */
  readonly padding?: number;
  /** Publish one row per batch, so falling behind is what reaches the cap. */
  readonly oneAtATime?: boolean;
}

/**
 * Rows appended straight to the log.
 *
 * With `stream` unset they exist in the log having never been streamed, which
 * is exactly the state a client resuming after a drop finds. With it set they
 * arrive the way a decision does: written, committed, then published.
 */
function seed(count: number, tag: string, options: SeedOptions = {}): string[] {
  const filler = "x".repeat(options.padding ?? 0);
  const ids: string[] = [];
  const events = Array.from({ length: count }, (_, index) => {
    const id = newEventId();
    ids.push(id);
    return GovernanceEvent.parse({
      id,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      execution_id: `${tag}_${index}`,
      hook: "access",
      user_id: DANA,
      tool: "Loan.GetLoan",
      decision: "allow",
      reason: `seeded ${filler}`,
      rule_id: null,
    });
  });

  const publish = options.stream === true ? bus.publish : undefined;
  if (options.oneAtATime === true) for (const event of events) record(db, [event], publish);
  else record(db, events, publish);
  return ids;
}

const dataOf = (frame: Frame): GovernanceEvent => GovernanceEvent.parse(JSON.parse(frame.data));
const idsIn = (reader: Reader): string[] => reader.frames.map((frame) => frame.id ?? "");
const seqOrder = (): string[] =>
  db
    .query<{ id: string }, []>("SELECT id FROM audit_log ORDER BY seq ASC")
    .all()
    .map((row) => row.id);

// ---------------------------------------------------------------------------

describe("the frame layout #21's adapter reads", () => {
  test("a decision arrives as one governance frame carrying the audit row verbatim", async () => {
    const reader = await open(base);
    await reader.settle();

    await denyDana("tc_live_1");
    await reader.untilFrames(1);
    reader.abort();

    expect(reader.frames).toHaveLength(1);
    const [frame] = reader.frames;
    expect(frame!.event).toBe(GOVERNANCE_EVENT_NAME);

    const streamed = dataOf(frame!);
    // The id on the frame is the audit row id, which is what makes a resume
    // possible at all — and it is the correlation token from #6.
    expect(frame!.id).toBe(streamed.id);
    expect(streamed.id).toStartWith("evt_");

    const row = db
      .query<{ id: string; hook: string; decision: string; reason: string; rule_id: string | null }, { $id: string }>(
        "SELECT id, hook, decision, reason, rule_id FROM audit_log WHERE id = $id",
      )
      .get({ $id: streamed.id });
    expect(row).not.toBeNull();
    expect(streamed).toMatchObject({
      hook: "pre",
      execution_id: "tc_live_1",
      user_id: DANA,
      tool: "Loan.ApproveLoan",
      decision: "deny",
      rule_id: "pre.approve-within-clearance",
    });
    expect(streamed.reason).toBe(row!.reason);
  });

  test("the fields are event/id/data, one line each, in the order the client expects", async () => {
    const reader = await open(base);
    await reader.settle();
    await denyDana("tc_layout");
    await reader.untilFrames(1);
    reader.abort();

    const raw = reader.raw();
    const block = raw.slice(raw.indexOf(`event: ${GOVERNANCE_EVENT_NAME}`));
    const [first, second, third, blank] = block.split("\n");
    expect(first).toBe(`event: ${GOVERNANCE_EVENT_NAME}`);
    expect(second).toStartWith("id: evt_");
    expect(third).toStartWith("data: {");
    expect(blank).toBe("");
    // A reason with a newline in it must not be able to forge a frame boundary.
    expect(third!.slice("data: ".length)).not.toInclude("\n");
  });

  test("bytes arrive on connect, before any decision is made", async () => {
    const reader = await open(base);
    await reader.settle();
    reader.abort();
    // The panel reports itself live off the first read; on stage the first
    // decision may be a minute away and a blank panel reads as a broken one.
    expect(reader.raw()).toInclude("retry: ");
    expect(reader.frames).toHaveLength(0);
  });

  test("an idle stream is held open with keep-alive comments, not closed", async () => {
    const reader = await open(base);
    await Bun.sleep(200);
    expect(reader.closed()).toBe(false);
    expect(reader.comments).toContain("keep-alive");
    // A close would send the client into its reconnect loop and replay the
    // story on a timer, which looks like the same call being decided twice.
    expect(reader.frames).toHaveLength(0);
    reader.abort();
  });
});

describe("the seam is the audit write", () => {
  test("every access, pre and post invocation publishes, one frame per audit row", async () => {
    const reader = await open(base);
    await reader.settle();

    // /access decides for four tools in one call, so it is four rows and four
    // frames — the count is the point, not just the presence of an event.
    const access = await fetch(`${base}/access`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        user_id: SAM,
        toolkits: { Loan: { tools: { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V } } },
      }),
    });
    expect(access.status).toBe(200);

    await denyDana("tc_every_pre");

    const post = await fetch(`${base}/post`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        execution_id: "tc_every_post",
        tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
        inputs: { loan_id: "LN-2291" },
        output: { value: { loan_id: "LN-2291" } },
        context: { authorization: [{}], user_id: DANA },
      }),
    });
    expect(post.status).toBe(200);

    await reader.untilFrames(6);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toEqual(seqOrder());
    const hooks = reader.frames.map((frame) => dataOf(frame).hook);
    expect(hooks).toEqual(["access", "access", "access", "access", "pre", "post"]);
  });

  test("a fail-closed denial publishes too — the panel sees the refusal, not silence", async () => {
    const reader = await open(base);
    await reader.settle();

    // An unparseable body: the service fails closed, audits the denial, and
    // the stream carries it. A control plane that went quiet exactly when it
    // broke would be the worst thing this panel could do.
    const response = await fetch(`${base}/pre`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: "{ not json",
    });
    expect(response.status).toBe(200);

    await reader.untilFrames(1);
    reader.abort();
    const event = dataOf(reader.frames[0]!);
    expect(event.decision).toBe("deny");
    expect(event.reason).toStartWith("FAIL-CLOSED:");
    expect(event.id).toBe(seqOrder()[0]!);
  });

  test("every streamed event exists in the log, in the log's order", async () => {
    const reader = await open(base);
    await reader.settle();
    for (let index = 0; index < 5; index += 1) await denyDana(`tc_order_${index}`);
    await reader.untilFrames(5);
    reader.abort();

    expect(idsIn(reader)).toEqual(seqOrder());
  });

  test("a rolled-back audit write streams nothing", async () => {
    const reader = await open(base);
    await reader.settle();

    const good = GovernanceEvent.parse({
      id: newEventId(),
      ts: new Date().toISOString(),
      execution_id: "tc_rollback",
      hook: "pre",
      user_id: DANA,
      tool: "Loan.ApproveLoan",
      decision: "deny",
      reason: "would be rolled back",
      rule_id: null,
    });
    // Same id twice: the UNIQUE constraint aborts the transaction, so neither
    // row lands. A stream that had already announced the first would be
    // showing a decision the log does not have.
    expect(() => record(db, [good, good], bus.publish)).toThrow();
    await reader.settle();
    reader.abort();

    expect(reader.frames).toHaveLength(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n).toBe(0);
  });

  test("a subscriber that throws cannot fail a hook call", async () => {
    // The panel is a view. A broken view breaking the control plane would
    // invert the entire point of putting the controls outside the model.
    const off = bus.subscribe(() => {
      throw new Error("the panel exploded");
    });
    try {
      const response = await denyDana("tc_hostile_subscriber");
      expect(response.status).toBe(200);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n).toBe(1);
      expect(logs.join("\n")).toInclude("the panel exploded");
    } finally {
      off();
    }
  });
});

describe("reconnecting with Last-Event-ID", () => {
  test("a fresh connection replays nothing — history is the log's job, not the stream's", async () => {
    seed(3, "history");
    const reader = await open(base);
    await reader.settle();
    reader.abort();
    expect(reader.frames).toHaveLength(0);
  });

  test("a resume delivers exactly the missed rows, in order, nothing duplicated", async () => {
    const first = await open(base);
    await first.settle();
    await denyDana("tc_before_drop");
    await first.untilFrames(1);
    const anchor = first.frames[0]!.id!;
    first.abort();

    // The drop. Decisions keep being made while nobody is watching.
    const missed = seed(4, "missed");
    await denyDana("tc_after_drop");
    const missedIds = [...missed, seqOrder().at(-1)!];

    const resumed = await open(base, anchor);
    await resumed.untilFrames(missedIds.length);
    await resumed.settle();
    resumed.abort();

    expect(idsIn(resumed)).toEqual(missedIds);
    expect(idsIn(resumed)).not.toContain(anchor);
    expect(new Set(idsIn(resumed)).size).toBe(missedIds.length);
  });

  test("a resume from the newest row replays nothing and then goes live", async () => {
    seed(2, "settled");
    const anchor = seqOrder().at(-1)!;

    const reader = await open(base, anchor);
    await reader.settle();
    expect(reader.frames).toHaveLength(0);

    await denyDana("tc_after_resume");
    await reader.untilFrames(1);
    reader.abort();
    expect(idsIn(reader)).toEqual([seqOrder().at(-1)!]);
  });

  test("a replay hands over to live with no gap and no repeat", async () => {
    const anchorIds = seed(1, "anchor");
    const anchor = anchorIds[0]!;
    seed(50, "gap");

    const reader = await open(base, anchor);
    await reader.untilFrames(50);
    // Live decisions land straight after the replayed ones.
    for (let index = 0; index < 3; index += 1) await denyDana(`tc_handoff_${index}`);
    await reader.untilFrames(53);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toEqual(seqOrder().slice(1));
  });

  test("an id the log cannot place resumes live and says so", async () => {
    seed(3, "unrelated");
    const reader = await open(base, "evt_nosuchrow0");
    await reader.settle();
    await denyDana("tc_unknown_anchor");
    await reader.untilFrames(1);
    reader.abort();

    // Replaying the whole log for a stale tab would be worse than being clear
    // that this client cannot be made whole.
    expect(reader.comments.join("\n")).toInclude("evt_nosuchrow0 is not in this log");
    expect(reader.frames).toHaveLength(1);
    expect(logs.join("\n")).toInclude("unknown id evt_nosuchrow0");
  });
});

describe("replaying from the beginning (#62)", () => {
  /** The `seq` the log gave a row, which is the other name a client may use. */
  const seqOf = (id: string): number =>
    db
      .query<{ seq: number }, { $id: string }>("SELECT seq FROM audit_log WHERE id = $id")
      .get({ $id: id })!.seq;

  test("last-event-id: 0 replays the whole log, in order, then goes live", async () => {
    seed(6, "from-the-top");
    const before = seqOrder();

    const reader = await open(base, "0");
    await reader.untilFrames(before.length);

    // ...and then it is a live stream like any other.
    await denyDana("tc_after_full_replay");
    await reader.untilFrames(before.length + 1);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toEqual(seqOrder());
    expect(reader.comments.join("\n")).not.toInclude("not in this log");
  });

  test("last-event-id: 0 against an empty log replays nothing and goes live", async () => {
    const reader = await open(base, "0");
    await reader.settle();
    expect(reader.frames).toHaveLength(0);

    await denyDana("tc_empty_then_live");
    await reader.untilFrames(1);
    reader.abort();
    expect(idsIn(reader)).toEqual(seqOrder());
  });

  test("a numeric last-event-id is a seq: rows after it, nothing before", async () => {
    const ids = seed(5, "by-seq");
    const anchor = seqOf(ids[1]!);

    const reader = await open(base, String(anchor));
    await reader.untilFrames(3);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toEqual(ids.slice(2));
  });

  test("a seq past the end of the log is not a replay, and the first bytes say so", async () => {
    seed(3, "short-log");
    const past = seqOrder().length + 500;

    const reader = await open(base, String(past));
    await reader.settle();
    // Serving the newest rows for an anchor nobody asked for is the failure
    // #62 opened on: it looks like a replay and it is not one.
    expect(reader.frames).toHaveLength(0);
    const said = reader.comments.join("\n");
    expect(said).toInclude(`last-event-id ${past} is not in this log`);
    expect(said).toInclude("last-event-id: 0");

    await denyDana("tc_past_the_end");
    await reader.untilFrames(1);
    reader.abort();
    expect(idsIn(reader)).toEqual([seqOrder().at(-1)!]);
  });

  test("an unknown id names the mark it resumed from and how to ask for everything", async () => {
    seed(4, "unplaceable");
    const reader = await open(base, "evt_nosuchrow0");
    await reader.settle();
    reader.abort();

    const said = reader.comments.join("\n");
    expect(said).toInclude("resuming live from seq 4");
    expect(said).toInclude("Send last-event-id: 0 to replay from the beginning.");
  });

  test("a fresh connection still replays nothing: 0 is the way to ask", async () => {
    seed(3, "not-asked-for");
    const reader = await open(base);
    await reader.settle();
    reader.abort();
    expect(reader.frames).toHaveLength(0);
    // The mark is on the wire, so the next connection can name an anchor.
    expect(reader.comments.join("\n")).toInclude("live from seq 3");
  });

  test("replaying from 0 past the cap sends the newest rows and announces the hole", async () => {
    afterEachTeardown();
    boot(5);

    seed(20, "too-much-history");
    const order = seqOrder();

    const reader = await open(base, "0");
    await reader.untilFrames(5);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toEqual(order.slice(-5));
    expect(reader.comments.join("\n")).toInclude("replay truncated at 5 events");
  });
});

describe("a burst", () => {
  test("one decision of 2,000 rows arrives complete and in order", async () => {
    const reader = await open(base);
    await reader.settle();

    // The shape of a whole-project /access: thousands of rows in one commit,
    // published as one batch.
    const ids = seed(2000, "burst", { stream: true });
    await reader.untilFrames(2000, 20_000);
    await reader.settle();
    reader.abort();

    expect(idsIn(reader)).toHaveLength(2000);
    expect(idsIn(reader)).toEqual(ids);
  });

  test("a batch larger than a whole-project /access does not trip the default cap", async () => {
    // The cap had to sit above the largest single decision the control plane
    // could make — 10,844 rows in the bench's 1.6 MB fixture, and 8,278 across
    // one live `tools/list`'s four `/access` calls (#5 §11.3) — or one
    // legitimate call would truncate a resume. Since #107 the largest such
    // decision is a few rows; the cap is left where it is because the reason
    // it was chosen still holds and nothing is pressing on it.
    expect(STREAM_BACKLOG_LIMIT).toBeGreaterThan(10_844);
  });
});

describe("a client that stops reading", () => {
  /**
   * Driven against `handleEvents` and its own `ReadableStream` rather than over
   * a socket, on purpose: loopback absorbed 4 MB of unread frames without ever
   * applying backpressure, so over HTTP this valve is not reachable and a test
   * of it would pass by never running the code. Here the stream's own queue is
   * the only buffer, so "the writer is parked and the backlog is growing" is a
   * state the test can actually put the server in. Everything else in this
   * file goes over the wire.
   */
  test("is disconnected rather than trimmed, and its resume makes it whole", async () => {
    const response = handleEvents(new Request(`${base}/events`), {
      db,
      bus,
      log: (line) => logs.push(line),
      keepAliveMs: 60,
      backlogLimit: 5,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    const drain = async (): Promise<boolean> => {
      const chunk = await reader.read();
      if (chunk.done) return true;
      for (const match of decoder.decode(chunk.value).matchAll(/^id: (evt_\w+)$/gm)) {
        seen.push(match[1] as string);
      }
      return false;
    };

    // The preamble. After this the writer is parked with nothing to send.
    expect(await drain()).toBe(false);
    await Bun.sleep(20);

    // One decision goes into the chunk the writer was waiting to hand over.
    // Everything after it queues behind a consumer that has stopped reading.
    // A yield between them is the point: publishing twelve rows in one
    // synchronous burst would reach the parked writer as one batch, which is
    // the case the cap deliberately does *not* count against a client.
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      ids.push(...seed(1, `lagging_${index}`, { stream: true }));
      await Bun.sleep(1);
    }

    // Reading again finds not a trimmed stream but the end of one, which is
    // the signal the client's own resume logic is built on. Trimming would
    // have left the panel quietly short with nothing on it to say so.
    let ended = false;
    for (let guard = 0; guard < 50 && !ended; guard += 1) ended = await drain();
    expect(ended).toBe(true);
    expect(logs.join("\n")).toInclude("disconnecting a client");
    expect(seen.length).toBeLessThan(ids.length);
    expect(seen.length).toBeGreaterThan(0);

    // The recovery, over HTTP: resume from the last id it actually saw.
    const order = seqOrder();
    const anchor = seen.at(-1)!;
    const expected = order.slice(order.indexOf(anchor) + 1);
    expect(expected.length).toBeGreaterThan(0);

    const resumed = await open(base, anchor);
    await resumed.untilFrames(expected.length);
    await resumed.settle();
    resumed.abort();
    // Lossless: the backlog that got it disconnected is smaller than the
    // replay cap, which is why the two limits are one number. The client ends
    // up with every row it missed, in order, and none it already had.
    expect(idsIn(resumed)).toEqual(expected);
  }, 20_000);

  test("a gap past the cap replays the newest rows, contiguous with live, and announces the hole", async () => {
    afterEachTeardown();
    boot(5);

    const anchor = seed(1, "old")[0]!;
    seed(20, "gap");
    const order = seqOrder();

    const reader = await open(base, anchor);
    await reader.untilFrames(5);
    await reader.settle();
    reader.abort();

    // Capped, and the five it did send are the five most recent — so what the
    // panel shows next joins onto them with no hole in between. The hole is at
    // the old end, and the stream says where.
    expect(idsIn(reader)).toEqual(order.slice(-5));
    expect(reader.comments.join("\n")).toInclude("replay truncated at 5 events");
    expect(logs.join("\n")).toInclude("5-event cap");
  });
});

describe("the endpoint itself", () => {
  test("is unauthenticated: the panel runs in a browser holding no secret", async () => {
    const response = await fetch(`${base}/events`, { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  test("answers the CORS preflight the panel's browser sends before every resume", async () => {
    // `last-event-id` and `cache-control` are not CORS-safelisted request
    // headers, so the browser asks first. Without this the panel cannot
    // connect at all while every other test in this file still passes.
    const response = await fetch(`${base}/events`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "last-event-id",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toInclude("last-event-id");
    expect(response.headers.get("access-control-allow-headers")).toInclude("cache-control");
  });

  test("sends the headers a proxy needs in order not to buffer the acts", async () => {
    const response = await fetch(`${base}/events`, { headers: { accept: "text/event-stream" } });
    expect(response.headers.get("cache-control")).toInclude("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await response.body?.cancel();
  });

  test("refuses a verb that is not GET", async () => {
    expect((await fetch(`${base}/events`, { method: "POST" })).status).toBe(405);
  });

  test("/health counts the clients watching, so the panel is not the only witness", async () => {
    const before = (await (await fetch(`${base}/health`)).json()) as { stream_clients: number };
    expect(before.stream_clients).toBe(0);

    const reader = await open(base);
    await reader.settle();
    const during = (await (await fetch(`${base}/health`)).json()) as { stream_clients: number };
    expect(during.stream_clients).toBe(1);

    reader.abort();
    await Bun.sleep(120);
    const after = (await (await fetch(`${base}/health`)).json()) as { stream_clients: number };
    expect(after.stream_clients).toBe(0);
  });
});

/** Tears down the per-test server so a test can boot its own. */
function afterEachTeardown(): void {
  cache.stop();
  server.stop(true);
  db.close();
}

#!/usr/bin/env bun
/**
 * Runs the control panel's real stream adapter against this service's
 * `/events`, and reports whether the two agree.
 *
 * The panel (#21) shipped `subscribeToGovernanceEvents` before the server
 * existed, built to a wire contract written down on #20 rather than measured.
 * Two implementations of a format that have never been run against each other
 * agree on paper and disagree on stage, so this exists to close that: it boots
 * a real hook server on an ephemeral port, subscribes with the panel's own
 * unmodified module, and checks the four things a reviewer would otherwise have
 * to take on trust — a live event arrives and passes the client's own
 * `GovernanceEvent` guard, a burst arrives whole, a dropped connection is
 * resumed by the client on its own, and what the client ends up holding is the
 * audit log in the audit log's order with nothing repeated.
 *
 *     bun run --cwd apps/hooks interop:21
 *     bun run --cwd apps/hooks interop:21 -- path/to/lib/governance
 *
 * The argument is the directory holding `subscribe.ts`, and it defaults to
 * `apps/web/lib/governance`. Until #21 merges, point it at a checkout of
 * `slice/21-control-panel`; the script says so rather than failing obscurely.
 * A checkout outside this repo needs `@cg/policy-schema` resolvable from it —
 * see the message below for the two symlinks that do it.
 *
 * Exits non-zero on any disagreement, so it is usable as a gate.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createEventBus } from "@cg/governance-core";
import { GovernanceEvent } from "@cg/policy-schema";

import { newEventId, record } from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { createPolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const DEFAULT_CLIENT_DIR = resolve(import.meta.dir, "../../web/lib/governance");
const clientDir = resolve(process.argv[2] ?? DEFAULT_CLIENT_DIR);
const clientEntry = resolve(clientDir, "subscribe.ts");

if (!existsSync(clientEntry)) {
  console.error(
    `Cannot find the panel's stream adapter at ${clientEntry}.\n` +
      `#21 owns it. Until that merges, pass the directory from a checkout of\n` +
      `slice/21-control-panel:\n\n` +
      `  git worktree add /tmp/slice-21 origin/slice/21-control-panel\n` +
      `  mkdir -p /tmp/slice-21/node_modules/@cg\n` +
      `  ln -s "$PWD/packages/policy-schema" /tmp/slice-21/node_modules/@cg/policy-schema\n` +
      `  ln -s "$PWD/node_modules/zod" /tmp/slice-21/node_modules/zod\n` +
      `  bun run --cwd apps/hooks interop:21 -- /tmp/slice-21/apps/web/lib/governance\n`,
  );
  process.exit(2);
}

const { subscribeToGovernanceEvents } = (await import(clientEntry)) as typeof import("./types/subscribe.d.ts");

const SECRET = "interop-secret";
const DANA = "alice@bank.example";
const BURST = 3000;
const MISSED = 25;

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  approvalsStoreToken: "interop-store-token",
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: 250,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: "",
};

const db = openGovernance(":memory:", config);
const cache = createPolicyCache(db, { log: () => {}, pollMs: 20 });
cache.start();
const bus = createEventBus({ onSubscriberError: (cause) => console.error("bus:", cause) });
let server = createServer({ config, db, cache, bus, log: () => {} });
// Read before any stop(): Bun resets `port` to 0 once the server is stopped,
// and the whole point below is to bring the service back on the same one so
// that it is the client's own reconnect that finds it.
const port = server.port;
if (typeof port !== "number" || port === 0) throw new Error("the server did not bind a port");
const base = `http://localhost:${port}`;

/** A `/pre` Alice is refused: one audit row, one event, act 2's first beat. */
const denyDana = (executionId: string): Promise<Response> =>
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

/** Rows written straight to the log, standing in for one large decision. */
function append(count: number, tag: string, publish: boolean): void {
  const events = Array.from({ length: count }, (_, index) =>
    GovernanceEvent.parse({
      id: newEventId(),
      ts: new Date().toISOString(),
      execution_id: `${tag}_${index}`,
      hook: "access",
      user_id: DANA,
      tool: "Loan.GetLoan",
      decision: "allow",
      reason: tag,
      rule_id: null,
    }),
  );
  record(db, events, publish ? bus.publish : undefined);
}

const statuses: string[] = [];
const unusable: string[] = [];
const received: GovernanceEvent[] = [];
const batches: number[] = [];
const abort = new AbortController();

const subscription = subscribeToGovernanceEvents(`${base}/events`, {
  onEvents: (events: GovernanceEvent[]) => {
    batches.push(events.length);
    received.push(...events);
  },
  onStatus: (status: string) => statuses.push(status),
  onUnusableFrame: (data: string, problem: string) => unusable.push(`${problem}: ${data.slice(0, 120)}`),
  signal: abort.signal,
  retryMs: 50,
});

const until = async (predicate: () => boolean, what: string, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const problems: string[] = [];
const check = (ok: boolean, line: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${line}`);
  if (!ok) problems.push(line);
};

try {
  await until(() => statuses.includes("live"), "the client to report itself live");
  check(statuses[0] === "connecting" && statuses[1] === "live", `client status: ${statuses.slice(0, 2).join(" → ")}`);

  await denyDana("tc_interop_live");
  await until(() => received.length === 1, "the first live event");
  const first = received[0]!;
  check(
    first.hook === "pre" && first.decision === "deny" && first.rule_id === "pre.approve-within-clearance",
    `a live /pre denial arrives and passes the client's own schema guard (${first.id})`,
  );

  append(BURST, "burst", true);
  await until(() => received.length === BURST + 1, `${BURST} burst events`);
  check(true, `${BURST} events from one commit arrive whole, in ${batches.length} client batches`);

  // The drop. Decisions keep being made while nobody is watching.
  const beforeDrop = received.length;
  server.stop(true);
  append(MISSED, "missed", true);
  await until(() => statuses.at(-1) === "reconnecting", "the client to notice the drop");
  check(true, "the client noticed the drop and started reconnecting on its own");

  // Same port, so it is the client's own reconnect that finds it — nothing
  // here reaches in and restarts the subscription.
  server = createServer({ config: { ...config, port }, db, cache, bus, log: () => {} });
  await until(() => received.length === beforeDrop + MISSED, "the missed rows to be replayed");
  check(true, `${MISSED} rows written during the outage were replayed on resume`);

  abort.abort();
  await subscription;

  const logOrder = db
    .query<{ id: string }, []>("SELECT id FROM audit_log ORDER BY seq ASC")
    .all()
    .map((row) => row.id);
  const clientOrder = received.map((event) => event.id);

  check(clientOrder.length === logOrder.length, `counts match — log ${logOrder.length}, client ${clientOrder.length}`);
  check(JSON.stringify(clientOrder) === JSON.stringify(logOrder), "the client holds the audit log, in the log's order");
  check(clientOrder.length === new Set(clientOrder).size, "no event was delivered twice");
  check(unusable.length === 0, `no unusable frames${unusable.length > 0 ? `: ${unusable[0]}` : ""}`);
} finally {
  abort.abort();
  server.stop(true);
  cache.stop();
  db.close();
}

console.log(
  problems.length === 0
    ? `\nOK — ${clientEntry} and this service's /events agree.`
    : `\n${problems.length} disagreement(s).`,
);
process.exit(problems.length === 0 ? 0 : 1);

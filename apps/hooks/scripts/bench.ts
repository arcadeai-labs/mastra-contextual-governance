/**
 * Measures hook latency rather than hoping. Boots the real server on a random
 * port against an in-memory database and times, over HTTP:
 *
 *   - /access with the whole-project catalogue spike #2 measured (~1.6 MB)
 *   - /access scoped to the one governed toolkit
 *   - /pre for a denial and an allow
 *
 * Arcade's hook timeout is 5s. The number to watch is the 1.6 MB p95.
 *
 *   bun run --cwd apps/hooks bench
 */
import { createPolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const SECRET = "bench";
const SAM = "sam.reyes@bank.example";
const DANA = "dana.okafor@bank.example";
const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const db = openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} });
const cache = createPolicyCache(db);
cache.start();
const server = createServer({
  config: {
    port: 0,
    dbPath: ":memory:",
    signingSecret: SECRET,
    approvalsStoreToken: "bench-store-token",
    loanToolkit: "Loan",
    approvalsToolkit: "Approvals",
    personaEmails: {},
    deadlineMs: 2500,
    policyPollMs: 250,
    grantTtlSeconds: 900,
    injectionDetection: "armed",
    resetToken: "",
  },
  db,
  cache,
  log: () => {},
});
const base = `http://localhost:${server.port}`;

const auditRows = (): number =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n ?? 0;

function bigCatalogue(targetBytes: number) {
  const toolkits: Record<string, unknown> = { Loan: { tools: LOAN_TOOLS } };
  let bytes = 0;
  for (let t = 0; bytes < targetBytes; t++) {
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      tools[`Tool${i}WithALongerNameLikeArcadeUses`] = [
        { version: "1.0.0", requirements: { authorization: [{ provider_id: "prov", oauth2: { scopes: ["a", "b"] } }] } },
      ];
    }
    toolkits[`Toolkit${t}`] = { tools };
    bytes = JSON.stringify(toolkits).length;
  }
  return { bytes, toolkits };
}

async function time(label: string, path: string, body: unknown, runs: number) {
  const payload = JSON.stringify(body);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: payload,
    });
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status}`);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!.toFixed(1);
  console.log(
    `${label.padEnd(34)} ${(payload.length / 1024).toFixed(0).padStart(5)} KB  ` +
      `p50 ${q(0.5).padStart(7)}ms  p95 ${q(0.95).padStart(7)}ms  max ${q(1).padStart(7)}ms  (n=${runs})`,
  );
}

const { bytes, toolkits } = bigCatalogue(1_600_000);
const entries: number = Object.values(toolkits).reduce<number>(
  (n, t) => n + Object.keys((t as { tools: Record<string, unknown> }).tools).length,
  0,
);
console.log(
  `whole-project catalogue: ${Object.keys(toolkits).length} toolkits, ` +
    `${entries.toLocaleString("en-US")} tools, ${(bytes / 1024 / 1024).toFixed(2)} MB\n`,
);

const beforeCatalogue = auditRows();
const CATALOGUE_RUNS = 20;
await time("/access whole-project catalogue", "/access", { user_id: SAM, toolkits }, CATALOGUE_RUNS);
/**
 * Rows per whole-project call, measured rather than assumed (#107).
 *
 * It used to be one per catalogue entry — 10,844 in this fixture — and the
 * disk arithmetic
 * below was written against that constant. It is now one row per governed tool
 * plus one summary, and the point of measuring it here is that a change to
 * `src/access-audit.ts` moves this line rather than leaving a stale number in
 * a README.
 */
const rowsPerCatalogueCall = (auditRows() - beforeCatalogue) / CATALOGUE_RUNS;
await time("/access scoped to Loan", "/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } }, 200);
await time("/pre deny (act 2)", "/pre", {
  execution_id: "tc_bench",
  tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
  inputs: { loan_id: "LN-2291", amount: 95_000 },
  context: { authorization: [{}], user_id: DANA },
}, 200);
await time("/pre allow", "/pre", {
  execution_id: "tc_bench",
  tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
  inputs: { loan_id: "LN-2291" },
  context: { authorization: [{}], user_id: DANA },
}, 200);

console.log(
  `\naudit rows written: ${auditRows().toLocaleString("en-US")}` +
    `  (whole-project /access: ${rowsPerCatalogueCall} rows per call, ` +
    `for ${entries.toLocaleString("en-US")} tools decided)`,
);

// ---------------------------------------------------------------------------
// What the log costs on disk (#62)
// ---------------------------------------------------------------------------
//
// The rows above are real ones, written by the real handlers, so the cheapest
// honest way to price the table is to vacuum this database into a file and
// compare it with an empty one. `VACUUM INTO` writes the compacted on-disk
// form, which is what a Render volume actually holds.

const { statSync, mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const dir = mkdtempSync(join(tmpdir(), "cg-audit-bench-"));
const sizeOf = (source: typeof db, name: string): number => {
  const path = join(dir, name);
  source.exec(`VACUUM INTO '${path}'`);
  return statSync(path).size;
};

const empty = openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} });
const baseline = sizeOf(empty, "empty.db");
empty.close();

// The rows the timing section left are too few to price a table with — under
// #107's accounting a whole-project call writes five, not ten thousand — so the
// pricing pass writes its own, through the same real handlers over the same
// real socket.
//
// A **mix**, and that matters more than the count: a row's size is mostly its
// `reason`, and the four below are the four lengths this service writes. Pricing
// the table off `/access` alone would quote the cheapest row there is ("No rule
// matched.") as the average, and a `/pre` denial carrying a rendered remediation
// instruction is several times that.
const PRICING_ROWS = 50_000;
const pricingCalls: Array<[string, unknown]> = [
  // Dana: four governed tools, four allows. The demo's ordinary shape.
  ["/access", { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } }],
  // Sam: the same four, one of them hidden by a rule, with the rule's own reason.
  ["/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } }],
  // A summary row, and the reason that goes with it.
  ["/access", { user_id: DANA, toolkits: { Stock: { tools: { A: V, B: V, C: V } } } }],
  // The longest reason this service writes: act 2's rendered remediation.
  ["/pre", {
    execution_id: "tc_bench_price",
    tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
    inputs: { loan_id: "LN-2291", amount: 95_000 },
    context: { authorization: [{}], user_id: DANA },
  }],
];
for (let i = 0; auditRows() < PRICING_ROWS; i += 1) {
  const [path, body] = pricingCalls[i % pricingCalls.length]!;
  await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
}

const rows = auditRows();
const withRows = sizeOf(db, "with-rows.db");
const perRow = (withRows - baseline) / rows;
const GB = 1024 ** 3;

console.log(
  `\naudit_log on disk: ${rows.toLocaleString("en-US")} rows add ` +
    `${((withRows - baseline) / 1024 / 1024).toFixed(1)} MB over an empty governance.db ` +
    `(${(baseline / 1024).toFixed(0)} KB)\n` +
    `  ${perRow.toFixed(0)} bytes/row  →  a 1 GB disk holds ~` +
    `${Math.floor(GB / perRow).toLocaleString("en-US")} rows, ` +
    `~${Math.floor(GB / perRow / rowsPerCatalogueCall).toLocaleString("en-US")} whole-project /access calls`,
);
rmSync(dir, { recursive: true, force: true });

cache.stop();
server.stop(true);
db.close();

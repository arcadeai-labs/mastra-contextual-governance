/**
 * Act 4's scanners, measured against a corpus rather than against one note.
 *
 * #16 wired `/post` and fixed a regex that matched nothing. It proved that one
 * regex against the one poisoned record the loan book seeds, and said plainly
 * that two sentences of prose are one data point. This file is the other
 * points, and it has two halves that fail in opposite directions.
 *
 * **Injections.** One entry per phrasing family the output policy claims to
 * catch, each a whole underwriter note — real work first, payload after —
 * naming the pattern that must fire and the prose that must survive byte for
 * byte. A scanner proved against a payload with nothing around it has never
 * been asked to leave anything behind.
 *
 * **Benign prose.** Realistic underwriter notes written to trip the scanners
 * and required not to. `LN-2291`'s own note reads as real underwriting and
 * *then* carries the payload, so "does this mangle legitimate business text?"
 * is not a question to answer by inspection. A redaction layer that eats a
 * clean note will do it on a projector.
 *
 * **And the coverage check, which is the point of the file.** Every pattern in
 * `governance.db` must be exercised by at least one corpus entry, and every
 * entry must name a pattern that exists. A pattern nothing proves is a pattern
 * that may match nothing, and a rule that matches nothing is indistinguishable
 * from a rule that permits — this project's recurring failure, and the one the
 * shipped regex actually shipped with.
 *
 * Everything runs over HTTP against the real `/post`, with the rules read out
 * of the seeded database and the notes read out of a checked-in fixture. No
 * regex is retyped here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { PostHookResult, type RedactionRecord } from "@cg/policy-schema";

import type { HooksConfig } from "../src/config.ts";
import { createPolicyCache, type PolicyCache } from "../src/policy-cache.ts";
import { openGovernance, readOutputRules } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";
import corpus from "./fixtures/injection-corpus.json" with { type: "json" };

const SECRET = "test-secret";
const DANA = "alice@bank.example";
const RULE = "post.strip-injected-instructions";

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  approvalsStoreToken: "test-store-token",
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: 10,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: "",
};

interface Injection {
  id: string;
  shape: string;
  pattern: string;
  note: string;
  survives: string;
}
interface Benign {
  id: string;
  trap: string;
  note: string;
}

const INJECTIONS = corpus.injections as Injection[];
const BENIGN = corpus.benign as Benign[];

let db: Database;
let cache: PolicyCache;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(() => {
  db = openGovernance(":memory:", config);
  cache = createPolicyCache(db, { pollMs: config.policyPollMs, scanners: config.injectionDetection });
  cache.start();
  server = createServer({ config, db, cache, log: () => {} });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  cache.stop();
  server.stop(true);
  db.close();
});

let execution = 0;

/**
 * The span the corpus says a scanner takes out — the note minus what survives.
 *
 * Derived rather than written down, and it throws when `survives` is not the
 * note with exactly one contiguous piece missing. That is the guard on the
 * corpus itself: an entry whose `survives` was written independently of its
 * `note` would let a scanner that mangles the prose still look correct here.
 */
function removedSpan(entry: Injection): string {
  const { note, survives } = entry;
  let head = 0;
  while (head < survives.length && note[head] === survives[head]) head += 1;
  let tail = 0;
  while (
    tail < survives.length - head &&
    note[note.length - 1 - tail] === survives[survives.length - 1 - tail]
  ) {
    tail += 1;
  }
  if (head + tail !== survives.length) {
    throw new Error(
      `corpus entry "${entry.id}": "survives" is not "note" with one contiguous span removed`,
    );
  }
  return note.slice(head, note.length - tail);
}

/**
 * One `Loan.GetLoan` result carrying nothing but the note.
 *
 * Act 3's rule names `bank_account_number` and `tax_id`; a payload without them
 * matches nothing there, which is what isolates act 4. So every `redactions[]`
 * below is the sweep's and only the sweep's.
 */
async function sweep(note: string): Promise<{
  code: string;
  notes: string | undefined;
  records: RedactionRecord[];
}> {
  const execution_id = `tc_corpus_${++execution}`;
  const response = await fetch(`${base}/post`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      execution_id,
      tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: "LN-0000" },
      success: true,
      output: { loan_id: "LN-0000", underwriter_notes: note },
      context: { user_id: DANA },
    }),
  });
  expect(response.status).toBe(200);
  const body = PostHookResult.parse(await response.json());

  const audit = await fetch(`${base}/audit?limit=1000`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  expect(audit.status).toBe(200);
  const rows = ((await audit.json()) as { rows: Array<Record<string, unknown>> }).rows;
  const row = rows.find((candidate) => candidate.execution_id === execution_id);
  expect(row).toBeDefined();

  const output = body.override?.output as Record<string, unknown> | undefined;
  return {
    code: body.code,
    notes: output?.underwriter_notes as string | undefined,
    records: (row?.redactions as RedactionRecord[] | undefined) ?? [],
  };
}

// ---------------------------------------------------------------------------

describe("the corpus and the policy describe the same set of patterns", () => {
  test("every seeded pattern is exercised, and every corpus entry names a real one", () => {
    const seeded = readOutputRules(db)
      .find((rule) => rule.id === RULE)!
      .patterns.map((pattern) => pattern.id);
    const exercised = [...new Set(INJECTIONS.map((entry) => entry.pattern))];

    // Set equality in both directions, and the failure messages differ on
    // purpose. A seeded pattern nothing exercises is the dangerous half: it may
    // match nothing at all, and nothing here would say so.
    expect([...seeded].sort()).toEqual([...exercised].sort());
    expect(seeded.length).toBeGreaterThan(1);
  });

  test("the corpus is prose, not stubs", () => {
    // Guards against the file being gutted into something that passes trivially.
    expect(INJECTIONS.length).toBeGreaterThanOrEqual(8);
    expect(BENIGN.length).toBeGreaterThanOrEqual(8);
    for (const entry of [...INJECTIONS, ...BENIGN]) {
      expect(entry.note.length).toBeGreaterThan(80);
    }
    for (const entry of INJECTIONS) {
      // What survives has to be the note minus one contiguous span, rather than
      // an independently written string that happens to be what came back. It
      // also has to be most of the note: an entry whose payload is the whole
      // note proves the scanner fires but proves nothing about what it spares,
      // and sparing is the half that breaks a demo.
      const removed = removedSpan(entry);
      expect(removed.length).toBeGreaterThan(20);
      expect(entry.survives.length).toBeGreaterThan(40);
    }
  });
});

describe("an injected instruction is removed, and the underwriter's own work is not", () => {
  test.each(INJECTIONS.map((entry) => [entry.id, entry] as const))(
    "%s",
    async (_id, entry) => {
      const { code, notes, records } = await sweep(entry.note);

      expect(code).toBe("OK");
      // Byte equality, not "contains": a scanner that takes one word too many
      // is a scanner that will take a sentence of a real note eventually.
      expect(notes).toBe(entry.survives);

      // And the control plane says which scanner did it. One record, because
      // two scanners firing on one note would mean the shapes overlap and the
      // panel could not name a cause.
      expect(records).toEqual([
        {
          path: "$.underwriter_notes",
          rule_id: RULE,
          pattern_id: entry.pattern,
          kind: "remove",
        },
      ]);
    },
  );

  test("and nothing that was removed is anywhere in the audit log", async () => {
    const response = await fetch(`${base}/audit?limit=1000`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const everything = JSON.stringify(await response.json());
    for (const entry of INJECTIONS) {
      expect(everything).not.toContain(removedSpan(entry).trim());
    }
  });
});

describe("legitimate underwriter prose is left exactly alone", () => {
  test.each(BENIGN.map((entry) => [entry.id, entry] as const))("%s", async (_id, entry) => {
    const { code, notes, records } = await sweep(entry.note);

    expect(code).toBe("OK");
    // `override` is absent entirely when nothing was redacted, so this is the
    // strongest statement available: the hook did not rewrite the payload at
    // all, rather than rewriting it into something equal.
    expect(notes).toBeUndefined();
    expect(records).toEqual([]);
  });
});

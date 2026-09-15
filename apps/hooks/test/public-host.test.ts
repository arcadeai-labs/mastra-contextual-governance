/**
 * A cross-service address this service cannot possibly reach is a startup
 * failure.
 *
 * The measurement behind it is #59: `render.yaml` derived every cross-service
 * host with `fromService … property: host`, and Render emitted the bare service
 * name — `IDP_PUBLIC_HOST` on `cg-loan-app` was `cg-idp-or5b`, not
 * `cg-idp-or5b.onrender.com`. Consumers prepend a scheme and nothing else, so
 * the request went somewhere DNS cannot resolve and surfaced as "the dependency
 * could not be reached" against a dependency that was up.
 *
 * `LOAN_APP_PUBLIC_HOST` is this service's copy of that defect. Nothing here
 * reads it yet — #16's redaction work is the first consumer — which is exactly
 * why boot is the right place to say so: the value is wrong from the moment it
 * is set, and the alternative is finding out during the first pass that needs
 * the loan book.
 *
 * The table below is shared, verbatim, with
 * `apps/loan-app/test/public-host.test.ts` and `apps/web/test/public-host.test.ts`
 * — the three copies of the check are written out rather than imported, so each
 * one is pinned by its own suite.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { readConfig } from "../src/config.ts";
import { assertPublicHost, PublicHostError } from "../src/public-host.ts";

/**
 * The root suite runs many async test files at once, and several of them boot
 * real service subprocesses. A free-port probe followed by a child spawn is a
 * TOCTOU race under that load: another worker can claim the probed port before
 * this child does. Let the child bind `:0` atomically, read its actual port
 * from the boot line, and then poll the public `/health` endpoint. The bound is
 * deliberately generous but finite so a genuinely broken boot still fails
 * with diagnostics instead of hanging the suite.
 */
const BOOT_TIMEOUT_MS = 60_000;
const BOOT_TEST_TIMEOUT_MS = BOOT_TIMEOUT_MS + 10_000;

async function fileText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

async function waitForHealth(child: Subprocess, stdoutPath: string): Promise<number> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let stdout = "";

  for (;;) {
    stdout = await fileText(stdoutPath);
    const listening = /listening on :(\d+)\b/.exec(stdout);
    if (listening !== null) {
      const port = Number(listening[1]);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port;
      } catch {
        // The boot line is flushed just before the socket accepts requests.
      }
    }

    if (child.exitCode !== null) {
      throw new Error(
        `hooks exited ${child.exitCode} before /health became ready. ` +
          `stdout:\n${stdout || "(empty)"}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `hooks did not come up within ${BOOT_TIMEOUT_MS}ms. ` +
          `stdout:\n${stdout || "(empty)"}`,
      );
    }
    await Bun.sleep(50);
  }
}

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8082",
  "  localhost:8082  ",
  "127.0.0.1:1234",
  "127.0.0.1:4412",
  "127.0.0.53",
  "[::1]",
  "[::1]:9000",
  "[::1]:4412",
  "cg-loan-app.onrender.com",
  "cg-web-sa31.onrender.com",
  "cg-hooks.onrender.com:443",
  "example.test",
];

/**
 * Nothing here is reachable. The first five are bare service names — what
 * `fromService` produced, and what a hand-typed key produces again.
 *
 * The rest are round 1 of #67. The first cut of this check let any value
 * through once bracket-stripping left a colon in it, so `[::2]` — no dot, not
 * loopback — booted the loan API and served `/health` on it. `cg-loan-app:bad`
 * and `foo:bar` got in the same way. A dotless non-loopback host is refused
 * whatever punctuation it carries, and a port that is not a port number is
 * refused too.
 */
const REFUSED = [
  "cg-idp",
  "cg-idp-or5b",
  "cg-loan-app",
  "cg-web-sa31",
  "cg-loan-app:8080",
  "[::2]",
  "::2",
  "[fe80::1]",
  "cg-loan-app:bad",
  "foo:bar",
  "localhost:bad",
  "localhost:0",
  "localhost:65536",
  "cg-hooks.onrender.com:bad",
  "https://cg-hooks.onrender.com",
];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is on one specific page.
  try {
    assertPublicHost("LOAN_APP_PUBLIC_HOST", "cg-loan-app");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("LOAN_APP_PUBLIC_HOST=cg-loan-app");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("cg-web-sa31");
  }
});

/**
 * Through `readConfig`, which is this service's one environment read. A check
 * living anywhere else could be bypassed by the next caller that reads the
 * variable directly.
 */
test("readConfig refuses a bare service name, and passes a hostname through", () => {
  expect(() => readConfig({ LOAN_APP_PUBLIC_HOST: "cg-loan-app" })).toThrow(PublicHostError);
  expect(() => readConfig({ LOAN_APP_PUBLIC_HOST: "cg-loan-app.onrender.com" })).not.toThrow();
  expect(() => readConfig({})).not.toThrow();
});

/**
 * Through the service's real entry point, because the check is only worth
 * anything if it runs before the port opens. Exit status, not just stderr: a
 * boot that printed this and then served anyway would pass a message-only
 * assertion, and would be the #59 failure with a warning attached.
 */
test.each(["cg-loan-app", "[::2]", "cg-loan-app:bad", "foo:bar"])(
  "the control plane refuses to start on %p",
  async (host) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

    try {
      const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
        env: {
          ...process.env,
          PORT: "0",
          GOVERNANCE_DB_PATH: join(dir, "governance.db"),
          LOAN_APP_PUBLIC_HOST: host,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const status = await child.exited;
      const stderr = await new Response(child.stderr as ReadableStream).text();

      // 78 is sysexits' EX_CONFIG, the same status `apps/loan-app/scripts/dev-idp.ts` uses.
      expect(status).toBe(78);
      expect(stderr).toContain(`LOAN_APP_PUBLIC_HOST=${host}`);
      expect(stderr).toContain("Render dashboard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

/** The other side of the line: each accepted shape still boots and serves. */
test.each(["cg-loan-app.onrender.com", "localhost:8082", "127.0.0.1:1234", "[::1]:9000"])(
  "the control plane starts on %p",
  async (host) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));
    const stdoutPath = join(dir, "stdout.log");
    const stderrPath = join(dir, "stderr.log");

    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        GOVERNANCE_DB_PATH: join(dir, "governance.db"),
        LOAN_APP_PUBLIC_HOST: host,
      },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });

    try {
      const port = await waitForHealth(child, stdoutPath);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    } catch (cause) {
      const stderr = await fileText(stderrPath);
      throw new Error(`${String(cause)}\nstderr:\n${stderr || "(empty)"}`);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  BOOT_TEST_TIMEOUT_MS,
);

/**
 * The other half. Every configuration error that was fatal before this slice is
 * still fatal, and still fails the way it did — `orExitConfig` narrows on
 * `PublicHostError` and re-throws anything else.
 */
test("an unrelated configuration error still fails, and not as EX_CONFIG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

  try {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        NODE_ENV: "production",
        GOVERNANCE_DB_PATH: join(dir, "governance.db"),
        ARCADE_HOOK_SIGNING_SECRET: "",
        LOAN_APP_PUBLIC_HOST: "cg-loan-app.onrender.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const status = await child.exited;
    const stderr = await new Response(child.stderr as ReadableStream).text();

    expect(status).not.toBe(0);
    expect(status).not.toBe(78);
    expect(stderr).toContain("ARCADE_HOOK_SIGNING_SECRET is required in production");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

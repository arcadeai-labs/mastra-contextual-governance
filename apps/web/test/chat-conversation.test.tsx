/**
 * #142 — conversation turns, explicit authorization continuation, and persona
 * isolation through the real `Chat` component.
 *
 * This file launches the DOM fixture in a fresh Bun test worker. Bun's default
 * runner shares ReactDOM and Happy DOM globals between test files, so keeping
 * the real-DOM fixture in a subprocess prevents its closed window from being
 * retained by the later live-panel suites while preserving the same tests.
 */
import { test } from "bun:test";
import { join } from "node:path";

test("the real conversation fixture runs in an isolated DOM worker", async () => {
  const workerPath = join(import.meta.dir, "chat-conversation-worker.tsx");
  const worker = Bun.spawn({
    cmd: ["bun", "test", "--isolate", workerPath],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  const exitCode = await worker.exited;
  if (exitCode !== 0) {
    throw new Error(`chat conversation worker exited ${exitCode}\n${stdout}\n${stderr}`);
  }
});

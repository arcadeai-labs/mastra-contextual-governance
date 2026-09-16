/**
 * Keep the #149 DOM fixture isolated from other React tests, whose global
 * document/window would otherwise retain a closed Happy DOM instance.
 */
import { test } from "bun:test";
import { join } from "node:path";

test("the home loan authorization UI runs through a real local browser fixture", async () => {
  const worker = Bun.spawn({
    cmd: ["bun", "test", "--isolate", join(import.meta.dir, "home-loan-browser-worker.tsx")],
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
  if (exitCode !== 0) throw new Error(`home loan browser worker exited ${exitCode}\n${stdout}\n${stderr}`);
});

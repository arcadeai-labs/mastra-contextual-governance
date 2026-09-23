/**
 * `bun run dev` has to bind the `PORT` in this service's own `.env.local`.
 *
 * Every worktree owns a block of ten ports and each service reads its port
 * from its own untracked `.env.local`, written by `scripts/orca-setup.sh`.
 * Three of the four services get that for free — they are `bun <file>.ts`, and
 * Bun loads `.env.local` from the cwd into the process it runs. This one goes
 * through the Next CLI, and until #50 it bound 3000 in a worktree that owned
 * 4410: `--port ${PORT:-3000}` was expanded by the shell before anything read
 * the file. The failure was silent — the server started and announced the
 * wrong port cheerfully — which is why it is worth a test that boots the real
 * thing rather than reading the manifest and believing it.
 *
 * The first test therefore runs the *packaged* `dev` script, verbatim, in a
 * throwaway Next project whose only mention of a port is a `.env.local`, with
 * `PORT` scrubbed from the environment it inherits. If the port reaches Next
 * from anywhere but that file, nothing answers.
 */
import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(WEB_ROOT, "..", "..");

interface Manifest {
  scripts?: Record<string, string>;
}

async function manifestAt(dir: string): Promise<Manifest> {
  return (await Bun.file(join(dir, "package.json")).json()) as Manifest;
}

/**
 * A port the OS says is free, rather than a guess — the same trick as
 * `apps/loan-app/test/api.test.ts` and `tools/loan/tests/conftest.py`. Several
 * worktrees run `bun test` at once, so a random port is a birthday problem.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

let child: Subprocess | undefined;
let project: string | undefined;

afterAll(() => {
  child?.kill();
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
});

test("the packaged dev script binds the PORT in the service's own .env.local", async () => {
  const port = freePort();
  const web = await manifestAt(WEB_ROOT);
  const dev = web.scripts?.dev;
  expect(dev).toBeString();

  // Inside this package rather than under the OS temp dir (#190). Next 16's
  // `next dev` is Turbopack, which refuses a `node_modules` symlink pointing
  // out of its root — "Symlink [project]/node_modules is invalid, it points out
  // of the filesystem root" — and a root has to contain the project, so no
  // `turbopack.root` can reach back from `/tmp` to this repo. Here the root it
  // infers from the repo's `bun.lock` contains both ends of the symlink below.
  // `.test-fixtures/` is gitignored, and `afterAll` removes the project.
  const fixtures = join(WEB_ROOT, ".test-fixtures");
  mkdirSync(fixtures, { recursive: true });
  project = mkdtempSync(join(fixtures, "dev-port-"));

  // The smallest thing Next will serve, plus the real launcher and the real
  // `dev` script string. Copying the script rather than importing it keeps the
  // test honest about what `bun run dev` actually executes.
  mkdirSync(join(project, "app"), { recursive: true });
  writeFileSync(
    join(project, "app", "layout.jsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  writeFileSync(join(project, "app", "page.jsx"), "export default function Page() { return null; }\n");
  cpSync(join(WEB_ROOT, "scripts"), join(project, "scripts"), { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "cg-web-dev-port-fixture", private: true, scripts: { dev } }, null, 2)}\n`,
  );

  // The only mention of a port anywhere in the fixture.
  writeFileSync(join(project, ".env.local"), `PORT=${port}\n`);

  // Next, React and the rest, resolved the way the real service resolves them.
  symlinkSync(join(WEB_ROOT, "node_modules"), join(project, "node_modules"));

  // Left to infer it, Turbopack takes `apps/web` as this fixture's root. It
  // then cannot follow `apps/web/node_modules/next` out to the repo's Bun store
  // ("Could not find the Next.js package"), and every request answers 500.
  // `apps/web` itself has no such problem: `outputFileTracingRoot` in its
  // `next.config.ts` names the repo root. This names the same root. It is
  // legal only because the project now sits inside it.
  writeFileSync(
    join(project, "next.config.mjs"),
    `export default { turbopack: { root: ${JSON.stringify(REPO_ROOT)} } };\n`,
  );

  // Two variables are dropped rather than set.
  //
  // `PORT`, because with it in the environment the shell-expanded script
  // passed too — `.env.local` has to be the only place left for a port to
  // come from, or the test proves nothing.
  //
  // `NODE_ENV`, because `bun test` sets it to `test` and Bun skips
  // `.env.local` entirely under `NODE_ENV=test`, so a real dev server's
  // environment is the one without it. Inherited, it would make this test
  // fail for a reason that has nothing to do with the manifest. Measured on
  // #50: in `apps/web`, `NODE_ENV=test bun -e 'console.log(process.env.PORT)'`
  // prints `undefined` where an unset `NODE_ENV` prints the port.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PORT" && key !== "NODE_ENV"),
  );

  child = Bun.spawn(["bun", "run", "--cwd", project, "dev"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 60_000;
  let status: number | undefined;
  const ready = (): boolean => status !== undefined && status < 500;
  while (!ready()) {
    try {
      status = (await fetch(`http://127.0.0.1:${port}/`)).status;
    } catch {
      // Not listening yet.
    }
    if (ready()) break;
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
  }

  // The child's output is the only thing that says *why* nothing answered —
  // "bound 3000 instead" and "Next failed to start" look identical from
  // outside. Kill it first: the pipes stay open while it runs, so draining a
  // live dev server hangs until the test times out and reports nothing.
  if (!ready()) {
    child.kill();
    await child.exited;
    const [out, err] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);
    throw new Error(
      `\`${dev as string}\` did not answer on ${port}, the PORT in its .env.local.\n` +
        `stdout:\n${out}\nstderr:\n${err}`,
    );
  }

  expect(status).toBeLessThan(500);
}, 120_000);

/**
 * The bug class, not the one instance of it: any script that writes `$PORT`
 * for a shell to expand is reading the caller's environment, never the
 * service's `.env.local`, and it fails silently by falling back to a default.
 * Swept across every manifest so the next service added cannot reintroduce it
 * in a `dev:` sibling.
 */
test("no package script resolves PORT in the shell", async () => {
  const dirs = [
    REPO_ROOT,
    // `tools/` holds Python toolkits today and no manifest, and a fork is
    // invited to delete it outright — so the group is skipped when absent
    // rather than making this sweep the thing that breaks.
    ...["apps", "packages", "tools"]
      .map((group) => join(REPO_ROOT, group))
      .filter((group) => existsSync(group))
      .flatMap((group) =>
        Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: group, onlyFiles: true })).map(
          (entry) => join(group, entry, ".."),
        ),
      ),
  ];

  const offenders: string[] = [];
  for (const dir of dirs) {
    const { scripts = {} } = await manifestAt(dir);
    for (const [name, body] of Object.entries(scripts)) {
      if (/\$\{?PORT\b/.test(body)) offenders.push(`${dir.replace(REPO_ROOT, ".")}: ${name} = ${body}`);
    }
  }

  expect(offenders).toEqual([]);
});

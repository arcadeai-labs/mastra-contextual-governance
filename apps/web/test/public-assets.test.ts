/**
 * `public/` reaches the browser from the **built artifact**, not just from
 * `next dev` (#177, round 2).
 *
 * The frame's two wordmarks rendered in every check this slice shipped with —
 * `test/frame.test.ts` drives a real Chrome and waits on
 * `img.frame-mark-mastra.complete === true` — and would still have rendered as
 * two broken images on `cg-web`, because all of those checks run the source
 * tree, where `next dev` serves `public/` off disk. The deployed service runs
 * `output: "standalone"`, which carries only what file tracing carried, and
 * `public/` was not in it. Measured before the fix, on the tree
 * `bun run --cwd apps/web build` emits:
 *
 *     /                           200
 *     /arcade-wordmark-white.svg  404 text/html
 *     /mastra-wordmark.svg        404 text/html
 *
 * That is the same shape as #92 — correct under `next start`, wrong in the
 * artifact — and the same reason: nothing local ran the artifact.
 *
 * ## What this file runs
 *
 * It builds, then boots `.next/standalone/apps/web/server.js` on a socket with
 * `NODE_ENV=production`, and asks for the files over HTTP. Nothing is copied
 * into the tree first: whatever `next build` did not emit is missing here
 * exactly as it is missing in the image, which is the whole point. The runner
 * stage of `apps/web/Dockerfile` copies this tree and adds `.next/static`, so
 * the artifact under test is the deployed one minus a directory that has
 * nothing to do with `public/`.
 *
 * Reading the `COPY` lines out of the Dockerfile would have been cheaper and
 * would have proved nothing: it passes the day someone edits the path, which
 * is the failure it would exist to catch.
 *
 * ## Why it is not two file names
 *
 * Both halves are derived, so the next asset cannot slip through:
 *
 * - **The directory.** Every file under `public/` must come back 200, with the
 *   source bytes and a content type that is not the 404 page.
 * - **The source.** Every root-relative asset path the app *references* — read
 *   out of `app/`, `components/` and `lib/`, not typed here — must be one of
 *   them. A reference to a file nobody shipped fails on this side; a file
 *   shipped but not served fails on the other.
 *
 * The scans asserting they found something are load-bearing. A regex that
 * stops matching is a control that permits everything, which is this repo's
 * recurring way of being wrong.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";

import { freePort, stopProcess, waitForHttp } from "./cdp.ts";

const WEB = join(import.meta.dir, "..");
const PUBLIC = join(WEB, "public");
const STANDALONE = join(WEB, ".next", "standalone");

/** A cold `next build` plus a standalone boot. */
const BUILD_TIMEOUT_MS = 300_000;

/**
 * What a browser must get back, by extension.
 *
 * Present so "200 with a body" cannot be satisfied by Next's 404 page, which
 * is `text/html` and seven kilobytes of it — a length check alone passes on
 * that. Matched as a prefix, because `.ico` has several right answers and a
 * text type may carry a charset.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/",
  ".json": "application/json",
  ".txt": "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Source trees that may reference an asset by its served path. */
const SOURCE_DIRS = ["app", "components", "lib"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".css"];

/**
 * A quoted — or `url(`-wrapped — root-relative path ending in a static-asset
 * extension.
 *
 * Extension-gated rather than "any `/…`" so route paths (`/api/chat`,
 * `/panel`) are not swept in: those are served by the router, not out of
 * `public/`, and demanding they be files would be noise.
 */
const ASSET_REFERENCE = new RegExp(
  `["'\`(](/[A-Za-z0-9._/-]+(?:${Object.keys(CONTENT_TYPES)
    .map((extension) => extension.replace(".", "\\."))
    .join("|")}))["'\`)]`,
  "g",
);

function filesUnder(root: string, extensions?: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const absolute = join(root, entry);
    if (!statSync(absolute).isFile()) continue;
    if (extensions && !extensions.some((extension) => absolute.endsWith(extension))) continue;
    found.push(absolute);
  }
  return found;
}

/** Every file in `public/`, as the path a browser asks for. */
function servedPaths(): string[] {
  return filesUnder(PUBLIC)
    .map((absolute) => `/${relative(PUBLIC, absolute).split(/[\\/]/).join("/")}`)
    .sort();
}

/** Every root-relative asset path the app's own source asks for. */
function referencedPaths(): Array<{ path: string; source: string }> {
  const references: Array<{ path: string; source: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of filesUnder(join(WEB, dir), SOURCE_EXTENSIONS)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(ASSET_REFERENCE)) {
        references.push({ path: match[1] as string, source: relative(WEB, file) });
      }
    }
  }
  return references.sort((left, right) => `${left.source}${left.path}`.localeCompare(`${right.source}${right.path}`));
}

/** The content type prefix this path must be served with. */
function expectedType(path: string): string {
  const dot = path.lastIndexOf(".");
  const expected = dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()];
  if (expected === undefined) {
    throw new Error(
      `public${path} has an extension this test has no expected content type for; add it to CONTENT_TYPES`,
    );
  }
  return expected;
}

/** What is wrong with how the artifact served this path, or nothing. */
async function faultsServing(origin: string, path: string): Promise<string[]> {
  const response = await fetch(`${origin}${path}`);
  const body = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "(none)";
  const source = Buffer.from(readFileSync(join(PUBLIC, path.slice(1))));
  const faults: string[] = [];
  if (response.status !== 200) faults.push(`${path}: ${String(response.status)}, expected 200`);
  if (!type.startsWith(expectedType(path))) {
    faults.push(`${path}: content-type ${type}, expected ${expectedType(path)}…`);
  }
  if (body.byteLength === 0) faults.push(`${path}: empty body`);
  else if (!body.equals(source)) {
    faults.push(
      `${path}: served ${String(body.byteLength)} bytes, which are not public${path}'s ${String(source.byteLength)}`,
    );
  }
  return faults;
}

interface Artifact {
  origin: string;
  server: Subprocess;
}

let pending: Promise<Artifact> | undefined;

/** Build the standalone tree and serve it, once, for whichever test asks first. */
function artifact(): Promise<Artifact> {
  pending ??= (async (): Promise<Artifact> => {
    const build = Bun.spawn({
      cmd: ["bun", "run", "build"],
      cwd: WEB,
      env: { ...(process.env as Record<string, string>), NEXT_TELEMETRY_DISABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, status] = await Promise.all([
      new Response(build.stdout as ReadableStream).text(),
      new Response(build.stderr as ReadableStream).text(),
      build.exited,
    ]);
    if (status !== 0) throw new Error(`\`bun run build\` exited ${String(status)}\n${out}\n${err}`);

    const port = freePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = Bun.spawn({
      // The artifact's own entrypoint, run the way `apps/web/Dockerfile`'s
      // `CMD` runs it: Node, from the root of the standalone tree.
      cmd: ["node", join("apps", "web", "server.js")],
      cwd: STANDALONE,
      env: {
        ...(process.env as Record<string, string>),
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    void new Response(server.stdout as ReadableStream).text();
    void new Response(server.stderr as ReadableStream).text();
    await waitForHttp(`${origin}/`);
    return { origin, server };
  })();
  return pending;
}

afterAll(async () => {
  if (pending === undefined) return;
  await stopProcess(await pending.then((built) => built.server).catch(() => undefined));
});

describe("the built standalone artifact", () => {
  test(
    "answers, and still 404s what it does not have",
    async () => {
      // The control for the two below. Without it a dead server reads as "the
      // assets are missing", and a server answering 200 to everything passes
      // them.
      const { origin } = await artifact();
      const home = await fetch(`${origin}/`);
      const absent = await fetch(`${origin}/not-a-file-anyone-shipped.svg`);
      expect([`/ ${String(home.status)}`, `absent ${String(absent.status)}`]).toEqual([
        "/ 200",
        "absent 404",
      ]);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "serves every file in public/, with that file's own bytes",
    async () => {
      const { origin } = await artifact();
      const paths = servedPaths();
      // An empty directory would make the assertion below vacuously true.
      expect(`${String(paths.length)} file(s) in public/`).not.toBe("0 file(s) in public/");

      const faults: string[] = [];
      for (const path of paths) faults.push(...(await faultsServing(origin, path)));
      expect(faults).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "serves every asset the app's own source references",
    async () => {
      const { origin } = await artifact();
      const references = referencedPaths();
      // `app/Frame.tsx`'s two wordmarks are today's answer, but the assertion
      // is that the scan found the app's references at all: a regex that
      // matched nothing would turn this test green against a build with no
      // `public/` in it whatsoever.
      expect(`${String(references.length)} reference(s) found`).not.toBe("0 reference(s) found");

      const shipped = new Set(servedPaths());
      const faults: string[] = [];
      for (const { path, source } of references) {
        if (!shipped.has(path)) {
          faults.push(`${source} references ${path}, which is not a file in public/`);
          continue;
        }
        faults.push(...(await faultsServing(origin, path)).map((fault) => `${source}: ${fault}`));
      }
      expect(faults).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );
});

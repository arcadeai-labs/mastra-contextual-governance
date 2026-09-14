import type { NextConfig } from "next";

const config: NextConfig = {
  // Render runs this service from a Dockerfile; standalone keeps the runtime
  // image to the server plus only the dependencies it actually traced.
  output: "standalone",
  // The monorepo root, so tracing picks up files linked from packages/.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  // `ws` by hand, because tracing cannot find it on its own (#92).
  //
  // `@mastra/core` opens `ws` at module scope, and in the Alpine builder
  // webpack leaves it as a bare `require("ws")` external in
  // `.next/server/app/api/chat/route.js` rather than bundling it. (On macOS the
  // same build inlines it, which is the first reason this was invisible
  // locally.) Next's file tracing does not follow that emitted specifier, so
  // the standalone tree shipped without `ws` and every `POST /api/chat`
  // answered `Cannot find module 'ws'` — measured against the image, not
  // guessed. `next start` on a full `node_modules` resolves it, which is the
  // second reason three reviewers and the tracer bullet all passed.
  //
  // The glob is `./node_modules/ws`, inside this package, and that is the
  // load-bearing part: Node resolves `require("ws")` from the route by walking
  // up to `apps/web/node_modules`, so a copy anywhere else — the Bun store, the
  // repo root — would be present and still unreachable. The path exists only
  // because `ws` is a declared dependency of this package; see the `//ws` note
  // in package.json. Both halves are needed and neither works alone.
  //
  // `scripts/verify-standalone.ts` is what holds this honest. It drives the
  // built image, and `--image <a pre-fix tag>` makes it go red.
  outputFileTracingIncludes: { "/api/chat": ["./node_modules/ws/**/*"] },
};

export default config;

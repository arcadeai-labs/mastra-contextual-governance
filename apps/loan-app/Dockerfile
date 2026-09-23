# Render does not detect Bun, so every service declares its runtime explicitly.
# Build context is the repo root — Bun workspaces need the root manifest and
# lockfile to link `packages/*`.
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
COPY package.json bun.lock ./
COPY apps/hooks/package.json ./apps/hooks/
COPY apps/idp/package.json ./apps/idp/
COPY apps/loan-app/package.json ./apps/loan-app/
COPY apps/web/package.json ./apps/web/
COPY packages/governance-core/package.json ./packages/governance-core/
COPY packages/policy-schema/package.json ./packages/policy-schema/

# --filter keeps `apps/web`'s Next.js toolchain out of this image.
RUN bun install --frozen-lockfile --production --filter '@cg/loan-app'

COPY tsconfig.base.json ./
COPY packages ./packages
# `src` only. `test/` has no business in the image, and `scripts/dev-idp.ts`
# is a laptop-only identity stand-in that must not ship anywhere it could be
# mistaken for the real provider.
COPY apps/loan-app/src ./apps/loan-app/src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "apps/loan-app/src/index.ts"]

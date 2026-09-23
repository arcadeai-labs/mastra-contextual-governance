# Render does not detect Bun, so every service declares its runtime explicitly.
# Build context is the repo root, like the other services. Since #187 apps/idp
# is a workspace member and installs against the root lockfile, so the image
# copies the root manifest and every member's manifest (--frozen-lockfile
# resolves the whole workspace) and then filters the install to this service.
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

# --filter keeps every other workspace's dependencies out of this image.
RUN bun install --frozen-lockfile --production --filter 'idp'

COPY apps/idp/src ./apps/idp/src
COPY apps/idp/scripts ./apps/idp/scripts
# The persona email contract is shared with cg-hooks and cg-web. apps/idp
# declares no dependency on anything under packages/, but the public
# configuration contract still has one source of truth.
COPY packages/policy-schema/contract ./packages/policy-schema/contract

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "apps/idp/src/index.ts"]

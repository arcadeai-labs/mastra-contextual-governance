# Render does not detect Bun, so every service declares its runtime explicitly.
# Build context is the repo root, like the other services, but this one copies
# only its own directory: apps/idp is not a workspace member and carries its
# own lockfile (see apps/idp/package.json for why).
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Manifest and lockfile first, so a source-only change reuses the install layer.
COPY apps/idp/package.json apps/idp/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY apps/idp/src ./apps/idp/src
COPY apps/idp/scripts ./apps/idp/scripts
# The persona email contract is shared with cg-hooks and cg-web. apps/idp is
# intentionally not a workspace member, but the public configuration contract
# still has one source of truth.
COPY packages/policy-schema/contract ./packages/policy-schema/contract

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "apps/idp/src/index.ts"]

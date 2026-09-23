#!/usr/bin/env bash
# Orca repo setup hook — runs once per worktree, before any worker starts.
#
# Two jobs:
#   1. Claim a block of ports no other live worktree holds, and write them to
#      an untracked .env.local.
#   2. Install dependencies. One `bun install` at the root covers every
#      workspace, apps/idp included since #187.
#
# Wire it up in the Orca app: Repo settings -> hooks -> setup script:
#   bash scripts/orca-setup.sh
# Set the repo's setup policy to wait-for-setup, not start-immediately: an
# agent that begins before the install finishes runs `bun test` against a
# half-installed tree, gets "Cannot find module 'better-auth'", reads it as a
# broken repo, and starts fixing what is not wrong.
#
# Idempotent: re-running keeps the block this worktree already holds.
#
# Why a block and not a port. This project runs four services — web, hooks,
# loan-app, idp — and they all read the same `PORT` variable, so a worktree
# needs four distinct values plus the cross-service host strings derived from
# them. Range 4400-4559 in blocks of 10 gives 16 blocks against a steady-state
# need of 8: four implementer worktrees, which persist through review, plus one
# reviewer worktree each. It deliberately clears outreach-library's hook, which
# owns 4321-4380 on this machine.
set -euo pipefail

WORKTREE="$(pwd -P)"
CLAIMS="${XDG_CACHE_HOME:-$HOME/.cache}/mastra-contextual-governance/portblocks"
ENVFILE="$WORKTREE/.env.local"
BLOCK=10
BASE_MIN=4400
BASE_MAX=4550

mkdir -p "$CLAIMS"

listening() {  # is anything bound to this port right now?
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

block_free() {  # every port in the block unbound by anyone, Orca or not
  local base="$1" i
  for ((i = 0; i < BLOCK; i++)); do
    listening "$((base + i))" && return 1
  done
  return 0
}

claim_owner() { [ -f "$CLAIMS/$1" ] && cat "$CLAIMS/$1" || true; }

# A claim whose worktree directory is gone is stale. Orca removes worktrees on
# `worktree rm`, so this is how blocks come back into circulation when the
# archive hook did not get to run.
reap_stale() {
  local owner
  owner="$(claim_owner "$1")"
  if [ -n "$owner" ] && [ ! -d "$owner" ]; then
    rm -f "$CLAIMS/$1"
  fi
}

# Already hold a block? Keep it, so re-running setup is a no-op.
if [ -f "$ENVFILE" ]; then
  existing="$(sed -n 's/^CG_PORT_BASE=\([0-9]\{1,\}\)$/\1/p' "$ENVFILE" | head -1)"
  if [ -n "$existing" ] && [ "$(claim_owner "$existing")" = "$WORKTREE" ]; then
    echo "orca-setup: keeping CG_PORT_BASE=$existing"
    BASE="$existing"
  fi
fi

if [ -z "${BASE:-}" ]; then
  for b in $(seq "$BASE_MIN" "$BLOCK" "$BASE_MAX"); do
    reap_stale "$b"
    [ -e "$CLAIMS/$b" ] && continue
    block_free "$b" || continue
    # noclobber makes this create-or-fail, which is the atomic bit: two workers
    # starting at the same instant cannot both win the same block.
    if (set -o noclobber; printf '%s\n' "$WORKTREE" > "$CLAIMS/$b") 2>/dev/null; then
      BASE="$b"
      echo "orca-setup: claimed CG_PORT_BASE=$BASE"
      break
    fi
  done
fi

if [ -z "${BASE:-}" ]; then
  echo "orca-setup: no free block in $BASE_MIN-$((BASE_MAX + BLOCK - 1))." >&2
  echo "orca-setup: stale claims live in $CLAIMS — remove any whose worktree is gone." >&2
  exit 1
fi

WEB=$((BASE + 0)); HOOKS=$((BASE + 1)); LOAN=$((BASE + 2)); IDP=$((BASE + 3))

# All four services read the same `PORT` variable, so one shared file cannot
# carry all four values — the first service to load it would take the port
# meant for another. Bun loads `.env.local` from the *current working
# directory*, and `bun run --cwd apps/<svc> dev` sets that to the service's own
# directory, so each service gets its own file with its own PORT. Verified:
# `PORT` in `apps/hooks/.env.local` is what the hooks service binds.
#
# A shell-level `PORT="${CG_PORT_HOOKS:-8081}" bun run ...` does NOT work and
# was tried first: Bun injects .env into the script's process, not into the
# shell that expands `${...}`, so the default always won.
#
# All of these are untracked — .gitignore's `.env.local` matches at any depth.
shared() {
  cat <<ENVEOF
# Host-form, matching .env.example: consumers add the scheme.
WEB_PUBLIC_HOST=localhost:$WEB
HOOKS_PUBLIC_HOST=localhost:$HOOKS
LOAN_APP_PUBLIC_HOST=localhost:$LOAN
IDP_PUBLIC_HOST=localhost:$IDP
IDP_PUBLIC_URL=http://localhost:$IDP
ENVEOF
}

write_service_env() {  # $1 = app dir, $2 = its port
  local dir="$WORKTREE/apps/$1"
  [ -d "$dir" ] || return 0
  {
    echo "# Written by scripts/orca-setup.sh. Do not edit; setup rewrites it."
    echo "PORT=$2"
    echo
    shared
  } > "$dir/.env.local"
}

write_service_env web "$WEB"
write_service_env hooks "$HOOKS"
write_service_env loan-app "$LOAN"
write_service_env idp "$IDP"

# The root file carries no bare PORT — anything run from the repo root would
# inherit it. It documents the block and gives root-level `bun test` the
# cross-service hosts.
{
  echo "# Written by scripts/orca-setup.sh. Do not edit; setup rewrites it."
  echo "# This worktree owns ports $BASE-$((BASE + BLOCK - 1))."
  echo "CG_PORT_BASE=$BASE"
  echo "CG_PORT_WEB=$WEB"
  echo "CG_PORT_HOOKS=$HOOKS"
  echo "CG_PORT_LOAN_APP=$LOAN"
  echo "CG_PORT_IDP=$IDP"
  echo
  shared
} > "$ENVFILE"

if command -v bun >/dev/null 2>&1; then
  echo "orca-setup: bun install"
  bun install
fi

echo "orca-setup: ready — ports $BASE-$((BASE + BLOCK - 1)) (web $WEB, hooks $HOOKS, loan-app $LOAN, idp $IDP)"

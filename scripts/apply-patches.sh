#!/bin/sh
# Apply Domo's vendored dependency patches, idempotently.
#
# Why a script and not pnpm `patchedDependencies`: pnpm 11.0.9 here will
# not reconcile a newly-added patch (`pnpm install` keeps reporting
# "Already up to date" and never applies it), and the release
# agents-server image installs with **npm**, not pnpm, so pnpm's patch
# system would not run there anyway. One explicit, transparent apply step
# (plain `patch`, no extra dependency) covers both: dev host node_modules
# (via `postinstall`) and the release image (the Dockerfile invokes the
# same patch). Idempotent — safe to run on every install; a no-op if the
# patch is already applied or the package is absent.
#
# THE PATCH: @electric-ax/agents-server@0.4.2 does not re-link persisted
# entities' pull-wake subscriptions on its own boot (they are in-memory
# only), so after an agents-server crash / reboot / upgrade every
# pre-existing session's wake delivery is dead. The patch adds the
# boot-time re-link agents-server is missing. Upstream PR target:
# electric-sql/electric (packages/agents-server). See CLAUDE.md
# "restart-resume" + initial-design.md Decided #23.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATCH="$ROOT/release/agents-server-0.4.2-boot-relink.patch"
PKG="${1:-$ROOT/node_modules/@electric-ax/agents-server}"
MARKER='domo patch] Re-link persisted'
TARGET="$PKG/dist/entrypoint.js"

[ -f "$PATCH" ] || { echo "apply-patches: $PATCH missing — nothing to do"; exit 0; }
[ -f "$TARGET" ] || { echo "apply-patches: $TARGET absent — skip (agents-server not installed here)"; exit 0; }

if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "apply-patches: agents-server boot re-link already applied"
  exit 0
fi

# git-diff format with a/ b/ prefixes → -p1 from the package root.
if (cd "$PKG" && patch -p1 --forward --silent <"$PATCH"); then
  grep -q "$MARKER" "$TARGET" || {
    echo "apply-patches: ERROR — patch ran but marker absent" >&2
    exit 1
  }
  echo "apply-patches: agents-server boot re-link applied"
else
  echo "apply-patches: ERROR — failed to apply $PATCH" >&2
  exit 1
fi

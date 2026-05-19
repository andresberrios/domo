#!/usr/bin/env bash
# Local prod update — the `domo update` flow WITHOUT the GitHub/CI round
# trip. Builds the current source into a release tarball, installs it
# over the local prod install via the *same* bundled installer (atomic
# `current` symlink flip + PATH shim), then restarts infra + app so the
# running prod instance serves the freshly built code.
#
#   pnpm run update:local                  # → $DOMO_HOME (default ~/.domo)
#   DOMO_HOME=/path pnpm run update:local
#
# vs `scripts/build-release.sh` + a CI release:
#   - no GitHub Actions, no upload/download, no checksum dance
#   - reuses the bundled Node from the existing install instead of
#     re-downloading v22 from nodejs.org each time (bin/domo falls back
#     to system `node` if it's absent anyway).
#
# Session secret: `pnpm build` loads the repo `.env`, so its
# NUXT_SESSION_PASSWORD gets baked as runtimeConfig's build-time default
# and `server/plugins/00.session-secret.ts` then defers (its check is
# `if (rc.session.password) return`) — i.e. a local-update install seals
# cookies with the repo `.env` secret, NOT `$DOMO_HOME/session-secret`.
# That's intentionally accepted here: the `.env` secret is stable
# (nuxt-auth-utils writes it once), so it's identical across every
# `update:local` and prod sessions survive. The only catch: a real CI
# `domo update` (no `.env`, uses `$DOMO_HOME/session-secret`) would flip
# the secret once → a single forced re-login. Don't re-add an `.env`
# shuffle to "fix" this — it's a deliberate trade for a simpler script.
#
# Touches the LIVE prod install (restarts its services — brief infra
# blip). It never touches prod DATA: install.sh only `rm -rf`s the app
# code dir ($DOMO_HOME/app/<ver>), and `domo down` keeps Postgres/streams
# (bind-mounted under $DOMO_HOME/data).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# --- resolve $DOMO_HOME (must match bin/domo / server/lib/paths.ts) ------
if [ -n "${DOMO_HOME:-}" ]; then HOME_DIR="$DOMO_HOME";
elif [ -n "${XDG_DATA_HOME:-}" ]; then HOME_DIR="$XDG_DATA_HOME/domo";
else HOME_DIR="$HOME/.domo"; fi

# --- platform token (must match build-release.sh / install.sh) ----------
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "local-update: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "local-update: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"
VER="$(node -p 'require("./package.json").version')"; VER="${VER#v}"
STAGE="dist/stage/domo-${VER}"
TARBALL="$REPO_ROOT/dist/domo-${PLATFORM}.tar.gz"

echo "==> local-update: domo ${VER} (${PLATFORM}) → ${HOME_DIR}"

echo "==> pnpm build"
pnpm build

# --- assemble the tarball (mirrors build-release.sh, sans Node fetch) ---
echo "==> assembling ${TARBALL##*/}"
rm -rf dist
mkdir -p "$STAGE/bin" "$STAGE/release" "$STAGE/runtime/bin"
cp -r .output "$STAGE/.output"
cp bin/domo "$STAGE/bin/domo"; chmod +x "$STAGE/bin/domo"
cp release/docker-compose.yml release/Dockerfile.agents-server \
   release/agents-server-0.4.2-boot-relink.patch "$STAGE/release/"
printf '%s\n' "$VER" >"$STAGE/VERSION"
cat >"$STAGE/manifest.json" <<JSON
{ "version": "${VER}", "platform": "${PLATFORM}", "build": "local-update" }
JSON

# Carry the bundled Node forward from the existing install if present;
# otherwise omit it (bin/domo: NODE=runtime/bin/node, else system node).
PREV_NODE="$HOME_DIR/app/current/runtime/bin/node"
if [ -x "$PREV_NODE" ]; then
  cp "$PREV_NODE" "$STAGE/runtime/bin/node"; chmod +x "$STAGE/runtime/bin/node"
  echo "    reused bundled Node from $HOME_DIR/app/current"
else
  rmdir "$STAGE/runtime/bin" "$STAGE/runtime" 2>/dev/null || true
  echo "    no prior bundled Node — bin/domo will use system 'node'"
fi

tar -czf "$TARBALL" -C dist/stage "domo-${VER}"
rm -rf dist/stage

# --- install from the local tarball + restart the prod instance --------
echo "==> installing into ${HOME_DIR} (atomic 'current' flip)"
DOMO_HOME="$HOME_DIR" DOMO_LOCAL_TARBALL="$TARBALL" sh scripts/install.sh

DOMO_BIN="$HOME_DIR/app/current/bin/domo"
echo "==> restarting prod instance (app only; infra + live sessions kept)"
DOMO_HOME="$HOME_DIR" "$DOMO_BIN" restart

echo "==> done — domo $("$DOMO_BIN" version) live at http://localhost:${PORT:-7575}"

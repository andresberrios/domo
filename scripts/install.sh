#!/bin/sh
# Domo installer — host install of the app + the `domo` CLI.
# (Infra runs in Docker, managed by `domo up`.) initial-design.md #19.
#
#   curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
#
# Env:
#   DOMO_VERSION=0.1.1        install a specific release (default: latest)
#   DOMO_LOCAL_TARBALL=/path  install from a local tarball (offline / CI test)
#   DOMO_HOME=/path           data + app dir (default: ~/.domo, XDG-aware)
set -eu

REPO="andresberrios/domo"

err() { echo "install: $*" >&2; }
die() { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- platform + prerequisites -------------------------------------------
# Prebuilt for linux/darwin × x64/arm64. WSL is just Linux. Anything else
# → build from source (see docs/site/getting-started.md).
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "no prebuilt release for $(uname -s) — build from source." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "no prebuilt release for $(uname -m) — build from source." ;;
esac
PLATFORM="${OS}-${ARCH}"
if [ "$OS" = linux ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  err "WSL detected — ensure Docker Desktop's WSL integration is enabled for this distro."
fi
[ "$OS" = darwin ] && ! have docker && \
  err "macOS: install Docker Desktop (https://docs.docker.com/desktop/) before 'domo up'."
have tar  || die "tar is required."
have curl || die "curl is required."
# Node is bundled in the release (no system Node needed).
have docker || err "warning: Docker not found — needed by 'domo up' (not by install)."
have git    || err "warning: git not found — Domo shells host git for worktrees."
have coast  || err "warning: 'coast' not found — projects/envs need the Coast daemon."
have claude || err "warning: 'claude' not found — log in once with the Claude Code CLI."

# --- resolve data/app dir (must match server/lib/paths.ts) --------------
if [ -n "${DOMO_HOME:-}" ]; then HOME_DIR="$DOMO_HOME";
elif [ -n "${XDG_DATA_HOME:-}" ]; then HOME_DIR="$XDG_DATA_HOME/domo";
else HOME_DIR="$HOME/.domo"; fi
APPS="$HOME_DIR/app"
mkdir -p "$APPS"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/domo-${PLATFORM}.tar.gz"

# --- fetch + verify ------------------------------------------------------
if [ -n "${DOMO_LOCAL_TARBALL:-}" ]; then
  err "using local tarball ${DOMO_LOCAL_TARBALL}"
  cp "$DOMO_LOCAL_TARBALL" "$TARBALL"
else
  if [ -n "${DOMO_VERSION:-}" ]; then
    BASE="https://github.com/${REPO}/releases/download/v${DOMO_VERSION#v}"
  else
    BASE="https://github.com/${REPO}/releases/latest/download"
  fi
  err "downloading ${BASE}/domo-${PLATFORM}.tar.gz"
  curl -fsSL "$BASE/domo-${PLATFORM}.tar.gz" -o "$TARBALL"
  if curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
    EXPECT=$(awk '/domo-'"$PLATFORM"'\.tar\.gz/{print $1}' "$TMP/SHA256SUMS")
    ACTUAL=$(sha256sum "$TARBALL" | awk '{print $1}')
    [ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ] || die "checksum mismatch — refusing to install."
    err "checksum OK"
  else
    err "warning: no SHA256SUMS published — skipping verification."
  fi
fi

# --- extract + atomically point 'current' -------------------------------
tar -xzf "$TARBALL" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -type d -name 'domo-*' | head -1)
[ -n "$SRC" ] || die "unexpected tarball layout."
VER=$(cat "$SRC/VERSION")
DEST="$APPS/$VER"
rm -rf "$DEST"
mv "$SRC" "$DEST"
ln -sfn "$DEST" "$APPS/current"
chmod +x "$DEST/bin/domo"
err "installed $VER → $DEST"

# --- PATH shim (no sudo) -------------------------------------------------
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/domo" <<EOF
#!/bin/sh
exec "$APPS/current/bin/domo" "\$@"
EOF
chmod +x "$BIN_DIR/domo"

echo
echo "Domo $VER installed."
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Next:  domo up   →  http://localhost:7575" ;;
  *) echo "Add to PATH:  export PATH=\"$BIN_DIR:\$PATH\""
     echo "Then:  domo up   →  http://localhost:7575" ;;
esac
echo "Docs:  https://github.com/${REPO}/blob/main/docs/site/getting-started.md"

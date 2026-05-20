#!/bin/sh
# Domo installer — host install of the app + the `domo` CLI.
# (No engine infra — the in-process engine + SQLite replaces it.) See
# initial-design.md "Distribution" (Decided #14).
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
have tar  || die "tar is required."
have curl || die "curl is required."
# Node is bundled in the release (no system Node needed).
have docker || err "warning: Docker not found — needed at runtime for devcontainer-backed envs."
have git    || err "warning: git not found — Domo shells host git for worktrees."
have claude || err "warning: 'claude' not found — log in once with the Claude Code CLI."

# --- rootless-DinD prereq probe (Linux only, advisory) -------------------
# Domo runs the user's `docker compose` inside each env container — that
# needs a way to run Docker-in-Docker safely. Three viable runtimes,
# preferred order: sysbox-runc → rootless-dind → privileged (warned).
# Selected per-host at runtime by `server/lib/devcontainer/runtime.ts`;
# these checks just surface what the host supports so the operator
# knows what to expect.
if [ "$OS" = linux ] && have docker; then
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q 'sysbox-runc'; then
    err "sysbox-runc detected — env containers will use it (cleanest nested-Docker UX)."
  else
    # No sysbox → we'll try rootless-dind images. The kernel features
    # below are what those images need. Warn (don't fail) if missing —
    # the actual error surfaces clearly at `devcontainer up` time.
    if [ -r /proc/sys/kernel/unprivileged_userns_clone ] && \
       [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" != 1 ]; then
      err "warning: unprivileged_userns_clone is 0 — rootless-dind needs it enabled (echo 1 | sudo tee /proc/sys/kernel/unprivileged_userns_clone)."
    fi
    if [ -d /sys/fs/cgroup ] && [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
      err "warning: host appears to use cgroup v1; rootless-dind works best on cgroup v2 with delegation."
    fi
    if ! have fuse-overlayfs; then
      err "warning: fuse-overlayfs not found — rootless-dind uses it as the storage driver (apt install fuse-overlayfs)."
    fi
    if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
      err "warning: no subuid mapping for $(id -un) in /etc/subuid — rootless-dind needs one."
    fi
  fi
fi
if [ "$OS" = darwin ] && have docker; then
  err "macOS Docker Desktop path is supported; the rootless-DinD baseline is automatic via the VM."
fi

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

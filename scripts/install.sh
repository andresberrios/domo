#!/bin/sh
# Install Domo into DOMO_HOME (default ~/.domo) as a login service.
#
#   curl -fsSL https://raw.githubusercontent.com/andresberrios/domo/release/scripts/install.sh | sh
#
# Needs git and Docker on the machine. Everything else — Node, pnpm, Caddy, uv
# and Domo itself — is downloaded under DOMO_HOME. The second half of the
# install (building, the service, the certificate) is `bin/domo.mjs install`.
#
# Overrides: DOMO_HOME, DOMO_REPO (a URL or a local path), DOMO_CHANNEL (the
# branch to follow, default `release`), DOMO_INSTALL_ARGS (passed to
# `domo install`, e.g. `--skip-trust --no-open`).
set -eu

DOMO_HOME="${DOMO_HOME:-$HOME/.domo}"
DOMO_REPO="${DOMO_REPO:-https://github.com/andresberrios/domo.git}"
DOMO_CHANNEL="${DOMO_CHANNEL:-release}"
PNPM_VERSION="${PNPM_VERSION:-12.8.1}"
CADDY_VERSION="${CADDY_VERSION:-2.11.4}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'domo install: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required (macOS: xcode-select --install; Debian: apt install git)"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running; start it and run this again"

os=$(uname -s)
cpu=$(uname -m)
case "$os" in
  Darwin) node_os=darwin; caddy_os=mac; pnpm_os=darwin ;;
  Linux) node_os=linux; caddy_os=linux; pnpm_os=linux ;;
  *) die "$os is not supported" ;;
esac
case "$cpu" in
  arm64|aarch64) node_cpu=arm64; caddy_cpu=arm64; pnpm_cpu=arm64 ;;
  x86_64|amd64) node_cpu=x64; caddy_cpu=amd64; pnpm_cpu=x64 ;;
  *) die "$cpu is not supported" ;;
esac

mkdir -p "$DOMO_HOME/bin" "$DOMO_HOME/releases" "$DOMO_HOME/data" "$DOMO_HOME/logs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -d "$DOMO_HOME/app/.git" ]; then
  say "Fetching Domo ($DOMO_CHANNEL)"
  git -C "$DOMO_HOME/app" fetch --quiet origin "+refs/heads/$DOMO_CHANNEL:refs/remotes/origin/$DOMO_CHANNEL"
else
  say "Cloning Domo into $DOMO_HOME/app"
  rm -rf "$DOMO_HOME/app"
  # Shallow: the launcher fetches a window of history behind the channel's tip
  # and counts against that; nobody needs the whole history to run Domo.
  git clone --quiet --depth 1 --branch "$DOMO_CHANNEL" "$DOMO_REPO" "$DOMO_HOME/app"
fi
git -C "$DOMO_HOME/app" checkout --quiet --detach "origin/$DOMO_CHANNEL"

NODE_VERSION=$(tr -d 'v[:space:]' < "$DOMO_HOME/app/.node-version")
if [ ! -x "$DOMO_HOME/node/bin/node" ] || [ "$("$DOMO_HOME/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Downloading Node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$node_os-$node_cpu.tar.gz" -o "$tmp/node.tgz"
  rm -rf "$DOMO_HOME/node.new"
  mkdir -p "$DOMO_HOME/node.new"
  tar -xzf "$tmp/node.tgz" -C "$DOMO_HOME/node.new" --strip-components=1
  rm -rf "$DOMO_HOME/node"
  mv "$DOMO_HOME/node.new" "$DOMO_HOME/node"
fi

if [ ! -x "$DOMO_HOME/bin/pnpm" ] || [ "$("$DOMO_HOME/bin/pnpm" -v 2>/dev/null)" != "$PNPM_VERSION" ]; then
  say "Downloading pnpm $PNPM_VERSION"
  curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/pnpm-$pnpm_os-$pnpm_cpu.tar.gz" -o "$tmp/pnpm.tgz"
  mkdir -p "$tmp/pnpm"
  tar -xzf "$tmp/pnpm.tgz" -C "$tmp/pnpm"
  mv "$(find "$tmp/pnpm" -type f -name 'pnpm*' | head -n 1)" "$DOMO_HOME/bin/pnpm"
  chmod +x "$DOMO_HOME/bin/pnpm"
fi

if [ ! -x "$DOMO_HOME/bin/caddy" ] || ! "$DOMO_HOME/bin/caddy" version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  say "Downloading Caddy $CADDY_VERSION"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_${caddy_os}_${caddy_cpu}.tar.gz" -o "$tmp/caddy.tgz"
  tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
  mv "$tmp/caddy" "$DOMO_HOME/bin/caddy"
  chmod +x "$DOMO_HOME/bin/caddy"
fi

if [ ! -x "$DOMO_HOME/bin/uv" ]; then
  say "Downloading uv (for the Pocket TTS voice; optional)"
  curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$DOMO_HOME/bin" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 \
    || echo "    uv could not be installed; Pocket TTS will say so if you pick it"
fi

cp "$DOMO_HOME/app/bin/domo.mjs" "$DOMO_HOME/bin/domo.mjs"
cat > "$DOMO_HOME/bin/domo" <<EOF
#!/bin/sh
export DOMO_HOME="$DOMO_HOME"
exec "$DOMO_HOME/node/bin/node" "$DOMO_HOME/bin/domo.mjs" "\$@"
EOF
chmod +x "$DOMO_HOME/bin/domo"

say "Building Domo (a few minutes the first time)"
# shellcheck disable=SC2086
DOMO_HOME="$DOMO_HOME" exec "$DOMO_HOME/node/bin/node" "$DOMO_HOME/bin/domo.mjs" install --channel "$DOMO_CHANNEL" ${DOMO_INSTALL_ARGS:-}

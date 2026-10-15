#!/bin/sh
# Install Domo into DOMO_HOME (default ~/.domo) as a login service.
#
#   curl -fsSL https://github.com/andresberrios/domo-releases/releases/latest/download/install.sh | sh
#
# Needs Docker on the machine. Everything else — Node, Caddy, uv and Domo
# itself, already built — is downloaded under DOMO_HOME. This script reads the
# newest release's manifest and brings the Node it names and the launcher
# (`domo.mjs`), checked against the manifest; the launcher downloads the
# release for this platform and does the rest (`domo install`). Run over an
# existing install, including one that was built from git, it moves it onto
# the newest release and keeps its data and settings.
#
# git comes from the machine: Domo's projects are git checkouts, and the coding
# agents run it. When it has none that runs, the script installs it: on macOS
# the Xcode Command Line Tools (Apple's dialog, then it waits), on Linux the
# distribution's package.
#
# Overrides: DOMO_HOME, DOMO_FEED (where releases are published, e.g. a local
# server for a test), DOMO_INSTALL_ARGS (passed to `domo install`, e.g.
# `--skip-trust --no-open`).
set -eu

DOMO_HOME="${DOMO_HOME:-$HOME/.domo}"
DOMO_FEED="${DOMO_FEED:-https://github.com/andresberrios/domo-releases/releases}"
DOMO_FEED="${DOMO_FEED%/}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'domo install: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running; start it and run this again"

os=$(uname -s)
cpu=$(uname -m)
case "$os" in
  Darwin) node_os=darwin ;;
  Linux) node_os=linux ;;
  *) die "$os is not supported" ;;
esac
case "$cpu" in
  arm64|aarch64) node_cpu=arm64 ;;
  x86_64|amd64) node_cpu=x64 ;;
  *) die "$cpu is not supported" ;;
esac
# Releases are built against glibc; Alpine and other musl systems cannot run them.
if [ "$os" = Linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then die "musl-based Linux (such as Alpine) is not supported"; fi

mkdir -p "$DOMO_HOME/bin" "$DOMO_HOME/releases" "$DOMO_HOME/data" "$DOMO_HOME/logs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# A git that runs. On macOS /usr/bin/git always exists, but without the
# Command Line Tools it is a stub that opens their installer and fails, so it
# counts only when xcode-select names a developer directory that has git.
machine_git() {
  g=$(command -v git 2>/dev/null) || return 1
  if [ "$os" = Darwin ] && [ "$g" = /usr/bin/git ]; then
    dev=$(xcode-select -p 2>/dev/null) && [ -x "$dev/usr/bin/git" ] || return 1
  fi
  "$g" --version >/dev/null 2>&1
}

# The Command Line Tools, through Apple's own dialog, which needs the user's
# click and an admin's approval, downloads about a gigabyte and takes several
# minutes. The script waits for `xcode-select -p` to name the tools; the
# dialog's process going away first means it was cancelled or failed. A
# dialog never seen is not taken as cancelled: the hour runs out instead.
clt_git() {
  say "git comes with Apple's Command Line Tools, which are not installed."
  say "A macOS dialog is asking to install them: click Install. It takes several minutes; this waits."
  out=$(xcode-select --install 2>&1) || die "xcode-select --install failed: $out"
  seen= waited=0
  until machine_git; do
    if pgrep -f "Install Command Line Developer Tools" >/dev/null 2>&1; then
      seen=1
    elif [ -n "$seen" ]; then
      die "the Command Line Tools were not installed (the dialog was cancelled or failed). Run \`xcode-select --install\`, finish it, then run this again."
    fi
    [ "$waited" -ge 3600 ] && die "gave up after an hour waiting for the Command Line Tools. Finish \`xcode-select --install\`, then run this again."
    sleep 5
    waited=$((waited + 5))
  done
  say "Command Line Tools installed"
}

# The distribution's git, with sudo when not root. Piped into sh, sudo can
# still ask for the password: it reads the terminal, not stdin.
package_git() {
  if [ "$(id -u)" = 0 ]; then sudo=; elif command -v sudo >/dev/null 2>&1; then sudo=sudo; else sudo=none; fi
  refresh=
  if command -v apt-get >/dev/null 2>&1; then refresh="apt-get update -qq" install="apt-get install -y -qq git"
  elif command -v dnf >/dev/null 2>&1; then install="dnf install -y -q git"
  elif command -v yum >/dev/null 2>&1; then install="yum install -y -q git"
  elif command -v zypper >/dev/null 2>&1; then install="zypper --non-interactive install git"
  elif command -v pacman >/dev/null 2>&1; then install="pacman -S --noconfirm --needed git"
  elif command -v apk >/dev/null 2>&1; then install="apk add git"
  else die "git is required; install it with your package manager and run this again"
  fi
  [ "$sudo" = none ] && die "git is required: run $install as root, then this again"
  say "Installing git: ${sudo:+sudo }$install${sudo:+ (sudo may ask for your password)}"
  # shellcheck disable=SC2086
  { [ -z "$refresh" ] || $sudo $refresh >/dev/null; } && $sudo $install >/dev/null \
    || die "could not install git; run ${sudo:+sudo }$install, then this again"
}

if ! machine_git; then
  if [ "$os" = Darwin ]; then clt_git; else package_git; fi
fi
git --version >/dev/null 2>&1 || die "git does not run: $(git --version 2>&1 | head -n 1)"

say "Reading the newest release"
curl -fsSL "$DOMO_FEED/latest/download/manifest.json" -o "$tmp/manifest.json" || die "could not read $DOMO_FEED/latest/download/manifest.json"
# The manifest keeps these three on lines of their own for this.
field() { sed -n "s/^  \"$1\": \"\([^\"]*\)\",\{0,1\}\$/\1/p" "$tmp/manifest.json" | head -n 1; }
VERSION=$(field version)
NODE_VERSION=$(field node)
LAUNCHER_SHA=$(field launcherSha256)
[ -n "$VERSION" ] && [ -n "$NODE_VERSION" ] && [ -n "$LAUNCHER_SHA" ] || die "the release manifest is not one this script can read"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1; }

if [ ! -x "$DOMO_HOME/node/bin/node" ] || [ "$("$DOMO_HOME/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Downloading Node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$node_os-$node_cpu.tar.gz" -o "$tmp/node.tgz"
  rm -rf "$DOMO_HOME/node.new"
  mkdir -p "$DOMO_HOME/node.new"
  tar -xzf "$tmp/node.tgz" -C "$DOMO_HOME/node.new" --strip-components=1
  rm -rf "$DOMO_HOME/node"
  mv "$DOMO_HOME/node.new" "$DOMO_HOME/node"
fi

curl -fsSL "$DOMO_FEED/download/v$VERSION/domo.mjs" -o "$tmp/domo.mjs" || die "could not download the launcher of $VERSION"
[ "$(sha256 "$tmp/domo.mjs")" = "$LAUNCHER_SHA" ] || die "the launcher of $VERSION does not match its checksum; not installing it"
mv "$tmp/domo.mjs" "$DOMO_HOME/bin/domo.mjs"
cat > "$DOMO_HOME/bin/domo" <<EOF
#!/bin/sh
export DOMO_HOME="$DOMO_HOME"
exec "$DOMO_HOME/node/bin/node" "$DOMO_HOME/bin/domo.mjs" "\$@"
EOF
chmod +x "$DOMO_HOME/bin/domo"

say "Installing Domo $VERSION"
# shellcheck disable=SC2086
DOMO_HOME="$DOMO_HOME" DOMO_FEED="$DOMO_FEED" exec "$DOMO_HOME/node/bin/node" "$DOMO_HOME/bin/domo.mjs" install ${DOMO_INSTALL_ARGS:-}

#!/bin/sh
# Install Domo into DOMO_HOME (default ~/.domo) as a login service.
#
#   curl -fsSL https://raw.githubusercontent.com/andresberrios/domo/release/scripts/install.sh | sh
#
# Needs Docker on the machine. Everything else — Node, pnpm, Caddy, uv and
# Domo itself — is downloaded under DOMO_HOME, at the versions the checkout's
# `.tool-versions` names. This script brings Node, which the launcher runs on;
# the launcher brings the rest, here and on every update. The second half of
# the install (building, the service, the certificate) is
# `bin/domo.mjs install`.
#
# git comes from the machine when it has one that runs. When it does not, on
# macOS Domo downloads its own (see GIT_RELEASE below) instead of the Xcode
# Command Line Tools, and on Linux it installs the distribution's package.
#
# Overrides: DOMO_HOME, DOMO_REPO (a URL or a local path), DOMO_CHANNEL (the
# branch to follow, default `release`), DOMO_INSTALL_ARGS (passed to
# `domo install`, e.g. `--skip-trust --no-open`), DOMO_BUNDLE_GIT=1 (Domo's
# own git even where the machine has one).
set -eu

DOMO_HOME="${DOMO_HOME:-$HOME/.domo}"
DOMO_REPO="${DOMO_REPO:-https://github.com/andresberrios/domo.git}"
DOMO_CHANNEL="${DOMO_CHANNEL:-release}"

# GitHub Desktop's relocatable git build (dugite-native, MIT; git is GPLv2),
# signed and linked only against system libraries on macOS. Keep in step with
# BUNDLED_GIT in bin/domo.mjs, which keeps an existing one at this version.
GIT_RELEASE=v2.53.0-4
GIT_BUILD=4098283

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

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# Domo's own git in DOMO_HOME/git, run through a wrapper in DOMO_HOME/bin,
# which is first on the PATH of the launcher, the server and every agent it
# starts. The build finds its helpers and templates from these variables, not
# from where it is, and the server hands agents an allow-list of variables, so
# the wrapper sets them. Git Credential Manager and its .NET runtime (115 of
# the 150 MB on macOS) are removed: nothing turns it on.
bundle_git() {
  case "$os-$node_cpu" in
    Darwin-arm64) asset=macOS-arm64 sum=f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe ;;
    Darwin-x64) asset=macOS-x64 sum=ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680 ;;
    # Needs glibc 2.34, and the system's libcurl for HTTPS: only on request.
    Linux-arm64) asset=ubuntu-arm64 sum=a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af ;;
    Linux-x64) asset=ubuntu-x64 sum=cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901 ;;
  esac
  if [ "$(cat "$DOMO_HOME/git/VERSION" 2>/dev/null)" != "$GIT_RELEASE" ]; then
    say "Downloading git (${GIT_RELEASE#v})"
    curl -fsSL "https://github.com/desktop/dugite-native/releases/download/$GIT_RELEASE/dugite-native-$GIT_RELEASE-$GIT_BUILD-$asset.tar.gz" -o "$tmp/git.tgz"
    [ "$(sha256 "$tmp/git.tgz")" = "$sum" ] || die "the git download does not match its checksum"
    rm -rf "$DOMO_HOME/git.new"
    mkdir -p "$DOMO_HOME/git.new"
    tar -xzf "$tmp/git.tgz" -C "$DOMO_HOME/git.new"
    core="$DOMO_HOME/git.new/libexec/git-core"
    find "$core" -maxdepth 1 -type f \( -name '*.dll' -o -name '*.dylib' -o -name '*.json' -o -name 'git-credential-manager*' -o -name createdump -o -name uninstall.sh \) -exec rm -f {} +
    find "$core" -mindepth 1 -maxdepth 1 -type d ! -name mergetools -exec rm -rf {} +
    printf '%s\n' "$GIT_RELEASE" > "$DOMO_HOME/git.new/VERSION"
    rm -rf "$DOMO_HOME/git"
    mv "$DOMO_HOME/git.new" "$DOMO_HOME/git"
  fi
  write_git_wrapper
}

write_git_wrapper() {
  cat > "$DOMO_HOME/bin/git" <<WRAPPER
#!/bin/sh
# Domo's own git ($DOMO_HOME/git), because this machine had none that runs.
GIT_EXEC_PATH="$DOMO_HOME/git/libexec/git-core"
GIT_TEMPLATE_DIR="$DOMO_HOME/git/share/git-core/templates"
export GIT_EXEC_PATH GIT_TEMPLATE_DIR
if [ -z "\${GIT_SSL_CAINFO:-}" ] && [ -f "$DOMO_HOME/git/ssl/cacert.pem" ]; then
  GIT_SSL_CAINFO="$DOMO_HOME/git/ssl/cacert.pem"
  export GIT_SSL_CAINFO
fi
exec "$DOMO_HOME/git/bin/git" "\$@"
WRAPPER
  chmod +x "$DOMO_HOME/bin/git"
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

# Once Domo has its own git it keeps it, at the version pinned above.
if [ -n "${DOMO_BUNDLE_GIT:-}" ] || [ -d "$DOMO_HOME/git" ]; then
  bundle_git
elif ! machine_git; then
  if [ "$os" = Darwin ]; then bundle_git; else package_git; fi
fi
if [ -x "$DOMO_HOME/bin/git" ]; then PATH="$DOMO_HOME/bin:$PATH"; export PATH; fi
git --version >/dev/null 2>&1 || die "git does not run: $(git --version 2>&1 | head -n 1)"

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

NODE_VERSION=$(awk '$1 == "nodejs" { print $2 }' "$DOMO_HOME/app/.tool-versions")
[ -n "$NODE_VERSION" ] || die "no nodejs version in $DOMO_HOME/app/.tool-versions"
if [ ! -x "$DOMO_HOME/node/bin/node" ] || [ "$("$DOMO_HOME/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Downloading Node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$node_os-$node_cpu.tar.gz" -o "$tmp/node.tgz"
  rm -rf "$DOMO_HOME/node.new"
  mkdir -p "$DOMO_HOME/node.new"
  tar -xzf "$tmp/node.tgz" -C "$DOMO_HOME/node.new" --strip-components=1
  rm -rf "$DOMO_HOME/node"
  mv "$DOMO_HOME/node.new" "$DOMO_HOME/node"
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

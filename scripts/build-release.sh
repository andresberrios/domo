#!/usr/bin/env bash
# Build a Domo release: the host app tarball + installer + checksums.
# Run locally or from CI (.github/workflows/release.yml).
#
#   scripts/build-release.sh [version]   # default: package.json version
#
# Output (dist/):
#   domo-<os>-<arch>.tar.gz  self-contained: .output/ + bin/domo +
#                            release/ + runtime/bin/node (bundled Node) +
#                            manifest.json + VERSION (extracts to domo-<ver>/)
#   install.sh               the curl|sh installer (verbatim copy)
#   SHA256SUMS               checksums for the two above
#
# Native better-sqlite3 (bundled into .output) + the bundled Node binary
# make the tarball os/arch-specific — build on a matching runner.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-$(node -p 'require("./package.json").version')}"
VER="${VER#v}"

# Platform = the box this runs on (native better-sqlite3 gets bundled
# into .output, so the tarball is host-os/arch-specific). CI builds one
# per target on a matching runner; locally you get your own platform.
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"          # also Node's dist token (node-vX-<os>-<arch>)
STAGE="dist/stage/domo-${VER}"

# Portable sha256 (Linux: sha256sum, macOS: shasum -a 256).
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$@"; }
else
  sha256() { shasum -a 256 "$@"; }
fi

echo "==> building Domo ${VER} (${PLATFORM})"
rm -rf dist
mkdir -p "$STAGE"

echo "==> pnpm build"
pnpm build

# Bundle an official Node so the user needs no system Node (only Docker
# Compose + Coast + git + the claude CLI). Resolve the latest v22 LTS,
# download + checksum-verify, keep just the `node` binary.
echo "==> bundling Node (v22 LTS, ${PLATFORM})"
NODE_VER=$(curl -fsSL https://nodejs.org/dist/index.json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const v=JSON.parse(s).find(r=>r.version.startsWith("v22.")&&r.lts);
    if(!v){console.error("no v22 LTS in index.json");process.exit(1)}
    process.stdout.write(v.version)})')
NTMP=$(mktemp -d)
NTAR="node-${NODE_VER}-${PLATFORM}.tar.gz"
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${NTAR}" -o "$NTMP/$NTAR"
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt" -o "$NTMP/SHASUMS256.txt"
EXPECT=$(awk -v f="$NTAR" '$2==f{print $1}' "$NTMP/SHASUMS256.txt")
ACTUAL=$(sha256 "$NTMP/$NTAR" | awk '{print $1}')
[ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ] || { echo "Node checksum mismatch" >&2; exit 1; }
tar -xzf "$NTMP/$NTAR" -C "$NTMP"
mkdir -p "$STAGE/runtime/bin"
cp "$NTMP/node-${NODE_VER}-${PLATFORM}/bin/node" "$STAGE/runtime/bin/node"
chmod +x "$STAGE/runtime/bin/node"
rm -rf "$NTMP"
echo "    bundled Node ${NODE_VER}"

echo "==> assembling tarball"
cp -r .output "$STAGE/.output"
mkdir -p "$STAGE/bin" "$STAGE/release"
cp bin/domo "$STAGE/bin/domo"; chmod +x "$STAGE/bin/domo"
cp release/docker-compose.yml release/Dockerfile.agents-server \
   release/agents-server-0.4.2-boot-relink.patch "$STAGE/release/"
printf '%s\n' "$VER" >"$STAGE/VERSION"

cat >"$STAGE/manifest.json" <<JSON
{
  "version": "${VER}",
  "platform": "${PLATFORM}",
  "bundledNode": "${NODE_VER}",
  "app": "runtime/bin/node .output/server/index.mjs (PORT=7575)",
  "infra": {
    "postgresImage": "postgres:16-alpine",
    "agentsServer": "@electric-ax/agents-server@0.4.2",
    "durableStreamsBuild": "pkg.pr.new build 350"
  }
}
JSON

tar -czf "dist/domo-${PLATFORM}.tar.gz" -C dist/stage "domo-${VER}"
cp scripts/install.sh dist/install.sh
( cd dist && sha256 "domo-${PLATFORM}.tar.gz" install.sh >SHA256SUMS )
rm -rf dist/stage

echo "==> done:"
ls -lh dist
echo "==> SHA256SUMS:"; cat dist/SHA256SUMS

#!/usr/bin/env bash
# Build a Domo release: the host app tarball + installer + checksums.
# Run locally or from CI (.github/workflows/release.yml).
#
#   scripts/build-release.sh [version]   # default: package.json version
#
# Output (dist/):
#   domo-linux-x64.tar.gz   self-contained: .output/ + bin/domo + release/
#                           + manifest.json + VERSION  (extracts to domo-<ver>/)
#   install.sh              the curl|sh installer (verbatim copy)
#   SHA256SUMS              checksums for the two above
#
# Native modules (better-sqlite3 in .output, lmdb in the agents-server
# image) make the tarball linux-x64 / node22-specific — build on/for that.
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
PLATFORM="${OS}-${ARCH}"
STAGE="dist/stage/domo-${VER}"

echo "==> building Domo ${VER} (${PLATFORM})"
rm -rf dist
mkdir -p "$STAGE"

echo "==> pnpm build"
pnpm build

echo "==> assembling tarball"
cp -r .output "$STAGE/.output"
mkdir -p "$STAGE/bin" "$STAGE/release"
cp bin/domo "$STAGE/bin/domo"; chmod +x "$STAGE/bin/domo"
cp release/docker-compose.yml release/Dockerfile.agents-server "$STAGE/release/"
printf '%s\n' "$VER" >"$STAGE/VERSION"

cat >"$STAGE/manifest.json" <<JSON
{
  "version": "${VER}",
  "platform": "${PLATFORM}",
  "node": ">=22 <23",
  "app": "node .output/server/index.mjs (PORT=7575)",
  "infra": {
    "postgresImage": "postgres:16-alpine",
    "agentsServer": "@electric-ax/agents-server@0.4.2",
    "durableStreamsBuild": "pkg.pr.new build 350"
  }
}
JSON

tar -czf "dist/domo-${PLATFORM}.tar.gz" -C dist/stage "domo-${VER}"
cp scripts/install.sh dist/install.sh
( cd dist && sha256sum "domo-${PLATFORM}.tar.gz" install.sh >SHA256SUMS )
rm -rf dist/stage

echo "==> done:"
ls -lh dist
echo "==> SHA256SUMS:"; cat dist/SHA256SUMS

# Releasing (maintainers)

Releases are git-tag driven; CI builds and attaches everything.

## Cut a release

1. Bump `version` in `package.json` (semver).
2. If `@electric-ax/agents-server` or `@durable-streams/*` pins changed in `package.json`, mirror them in `release/Dockerfile.agents-server` (they must stay in sync).
3. Commit, then tag and push:

   ```sh
   git tag -a vX.Y.Z -m "Domo vX.Y.Z" && git push origin main vX.Y.Z
   ```

4. `.github/workflows/release.yml` fires on the `v*` tag: a **matrix** builds one tarball per platform (`{linux,darwin}-{x64,arm64}`) on a matching runner — each runs `scripts/build-release.sh`, which `pnpm build`s the app, bundles a checksum-verified Node 22 LTS, and packs `domo-<os>-<arch>.tar.gz`. The release job collects them, writes a combined `SHA256SUMS`, and creates/uploads the GitHub release (`--generate-notes`).

## Verify

- `gh run watch <id>` (or `gh run list --workflow=release.yml`) — all matrix jobs green.
- The release has `domo-*.tar.gz` (one per platform) + `install.sh` + `SHA256SUMS`.
- Smoke: `curl -fsSL …/releases/latest/download/install.sh | sh` then `domo up` on a clean host (or sandbox: `DOMO_HOME=$(mktemp -d) DOMO_LOCAL_TARBALL=… sh install.sh`).

## Notes

- Tarballs are os/arch-specific (native `better-sqlite3` + bundled Node) — must build on a matching runner; only `linux-x64` is locally reproducible without CI.
- Local build for testing: `bash scripts/build-release.sh [version]` → `dist/`.
- The agents-server image is **built on the user's host at first `domo up`** (not published) — nothing to push to a registry.
- **`darwin-x64` runs on `macos-15-intel`.** `macos-13` (the prior Intel runner) was retired 2025-12-04; jobs on a dead runner label hang in `queued` forever (silently wedging the whole release, since `release` is `needs: build`). `macos-15-intel` is the free x86_64 replacement **only until 2027-08** — after that GitHub has no x86_64 macOS runner and `darwin-x64` must be dropped or cross-built from an arm64 mac. Watch [actions/runner-images](https://github.com/actions/runner-images) for the next deprecation.
- A `v*` tag runs the workflow **as it existed at the tagged commit** — a CI fix on `main` does not salvage an already-pushed tag; cut a fresh tag.
- History: v0.1.0–v0.1.3 were unpublished/removed (v0.1.2–v0.1.3 release runs hung on the retired `macos-13` runner). **v0.1.4 is the first release with a green CI matrix** and the only published release.

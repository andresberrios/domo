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
- v0.1.0 was a source milestone; v0.1.1 first installable; v0.1.2 multi-platform; v0.1.3 bundled Node + host-UID infra.

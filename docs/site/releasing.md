# Releasing (maintainers)

Releases are git-tag driven; CI builds and attaches everything.

## Cut a release

1. Bump `version` in `package.json` (semver).
2. If the `claude` CLI version pinned in the scaffolded `devcontainer.json` (`postCreateCommand: "npm install -g @anthropic-ai/claude-code"`) or the `CLAUDE_AGENT_SDK_VERSION` env-var literal in `server/lib/sessionEngine/claude.ts` needs updating to match a fresh capture of the VS Code 2.1.142 (or newer) extension, do that in the same commit. The two need to stay close: the env-var literal is what Domo advertises against Anthropic's billing classifier, and the scaffolded install brings the actual CLI inside the user's containers.
3. Commit, then tag and push:

   ```sh
   git tag -a vX.Y.Z -m "Domo vX.Y.Z" && git push origin main vX.Y.Z
   ```

4. `.github/workflows/release.yml` fires on the `v*` tag: a **matrix** builds one tarball per platform (`{linux,darwin}-{x64,arm64}`) on a matching runner — each runs `scripts/build-release.sh`, which `pnpm build`s the app, bundles a checksum-verified Node 22 LTS, and packs `domo-<os>-<arch>.tar.gz`. The release job collects them, writes a combined `SHA256SUMS`, and creates/uploads the GitHub release (`--generate-notes`).

## Verify

- `gh run watch <id>` (or `gh run list --workflow=release.yml`) — all matrix jobs green.
- The release has `domo-*.tar.gz` (one per platform) + `install.sh` + `SHA256SUMS`.
- Smoke: `curl -fsSL …/releases/latest/download/install.sh | sh` then `domo up` on a clean host (or sandbox: `DOMO_HOME=$(mktemp -d) DOMO_LOCAL_TARBALL=… sh install.sh`).
- **Billing live-verify** (deadline-critical — see `docs/initial-design.md` Decided #3 + the `project-agent-sdk-billing` memory). Once: on a fresh `DOMO_HOME`, create a project + env, open the terminal and `claude /login`, run a session prompt. Confirm the spawned `claude` process inside the env container shows `apiKeySource: "none"` in its first `system` event and the outbound `x-anthropic-billing-header` carries `cc_entrypoint=claude-vscode`. Must pass on the cut tarball before promoting the release.

## Notes

- Tarballs are os/arch-specific (native `better-sqlite3` + bundled Node) — must build on a matching runner; only `linux-x64` is locally reproducible without CI.
- Local build for testing: `bash scripts/build-release.sh [version]` → `dist/`.
- Domo's distribution has **no engine infrastructure** — no Docker image to push to a registry, no compose stack to bundle. The release is just the host-side app tarball + the install script + checksums. Per-env devcontainers are created on the user's host by `@devcontainers/cli` at runtime.
- The Domo-owned **claude devcontainer Feature** image (`ghcr.io/<org>/devcontainer-features/claude`) is a separate release artifact: a small JSON + install script that pins a `claude` CLI version. Until it's published, the scaffolder's `postCreateCommand` installs the latest `@anthropic-ai/claude-code` from npm — see the TODO in `server/lib/devcontainer/scaffold.ts`. Publish the Feature when you want version-pinned reproducibility across rebuilds; bump its tag whenever you bump the CLI version in step 2 above.
- **`darwin-x64` runs on `macos-15-intel`.** `macos-13` (the prior Intel runner) was retired 2025-12-04; jobs on a dead runner label hang in `queued` forever (silently wedging the whole release, since `release` is `needs: build`). `macos-15-intel` is the free x86_64 replacement **only until 2027-08** — after that GitHub has no x86_64 macOS runner and `darwin-x64` must be dropped or cross-built from an arm64 mac. Watch [actions/runner-images](https://github.com/actions/runner-images) for the next deprecation.
- A `v*` tag runs the workflow **as it existed at the tagged commit** — a CI fix on `main` does not salvage an already-pushed tag; cut a fresh tag.
- History: v0.1.0–v0.1.3 were unpublished/removed (v0.1.2–v0.1.3 release runs hung on the retired `macos-13` runner). v0.1.4 was the first green release. v0.3.0 was the last release on the pre-pivot (Electric/Coast) stack; v0.4.0+ ships the in-process engine + devcontainer environments.

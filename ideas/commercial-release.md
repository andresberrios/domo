# Domo as a closed-source, paid product

An idea, not a plan in motion. Written 2026-10-03 from a conversation about
what would have to change in how Domo is built, released, installed and
updated to sell it as a subscription, with a desktop app for basic users and
a server install for technical ones. Nothing here is built.

## The shape

- **Two installs, one UI.** A *server install* (what `scripts/install.sh`
  makes today) runs on a Mac mini, a VM, or the user's own machine. A
  *desktop app* is a thin native shell around the same web UI: it either
  installs and supervises a local server, or connects to a remote one by
  URL. A phone browser, or a later mobile app, connects the same way.
- **One account, paid on the website.** A subscription is tied to an
  account. Every install is logged into one — from the CLI (`domo login`),
  the desktop app, or the web UI the server serves — through a browser flow
  to the website, where sign-up and payment happen. The *server install*
  holds the account token and the entitlement; the desktop app only ever
  talks to a server, so it needs no licence logic of its own beyond "which
  account am I".

## What changes, in the order to do it

### 1. A release becomes an artifact, not a branch

Today a release is a git branch the user's machine clones and builds
(`docs/install-and-updates.md`). Closed source means the repo goes private
and nobody builds from source.

- CI (GitHub Actions on a tag) runs the suite and builds the server bundle
  per platform: `.output` plus pruned `node_modules`, one tarball each for
  macOS arm64/x64 and Linux x64/arm64, because of the native modules
  (`onnxruntime-node`, `sharp`, `node:sqlite`).
- Each channel (`release`, `beta`) has a signed `manifest.json` naming the
  current version, its tarballs, their digests and the changelog. Published
  to a public feed: a `domo-releases` GitHub repository's Releases (where
  the Pocket TTS weights mirror already lives) or an object-storage bucket.
  Promoting `beta` to `release` moves a pointer; nothing is rebuilt.
- The launcher keeps almost everything. Only "obtain a release" changes:
  `domo update` reads the manifest, downloads the platform tarball,
  verifies the signature, extracts into `releases/<version>`, smoke-tests
  and swaps `current`/`previous`, instead of `git fetch` + `pnpm install` +
  `pnpm build`. Supervisor, rollback, quiet-moment restart, the compose
  stack, `.tool-versions`, the install id and the trust flow all stay.
- `scripts/install.sh` downloads the launcher, Node and the current
  artifact instead of cloning.

This step works while the repository is still public, and is low risk.

### 2. Accounts and entitlement, in the server

- Login is a device/browser flow: the CLI, the desktop app or the web UI
  opens the website; the user signs in (and pays) there; the website hands
  back a token the server stores in the `settings` table like the other
  secrets (never synced to the browser).
- The server refreshes a signed, short-lived entitlement (plan, seats,
  expiry) from the account API, checks it at boot and periodically, with an
  offline grace period so a machine with a flaky connection keeps working.
- Entitlement gates updates: manifest or download URLs signed per account,
  so a lapsed subscription keeps the version it has and gets no new ones.
  Whether it also stops running is a product decision.

### 3. Authentication and hardening for a remote server

The largest piece, and product work rather than release plumbing. Today
Domo trusts whoever reaches it: no users, no auth, loopback-only Electric,
and a Docker proxy that is explicitly not a security boundary
(`docs/dev-environments.md`). A server reachable from anywhere needs:

- real authentication (the account login, sessions per device, tokens for
  the desktop app) and authorization on every API route and shape request;
- Caddy with real certificates: automatic Let's Encrypt when the host has a
  DNS name, a tunnel otherwise;
- a hard look at what an agent in an environment can reach, since an
  environment can take the host;
- multi-user, which `AGENTS.md` already anticipates.

### 4. The desktop app

Electron or Tauri window loading `https://<server>`, plus what a browser
cannot do: tray or menu-bar item, notifications, microphone permission, and
managing a local server (start, stop, update, status are already launcher
commands and files, so the app drives `domo` or embeds its logic). Two
modes at first run: "on this computer" or "connect to a server". Thin once
steps 1-3 exist, which is why it goes last.

The prerequisite that does not go away is Docker, for Postgres, Electric
and the development environments. For basic users that is the real
obstacle. Options: detect Docker Desktop and walk the user through
installing it (start here), or embed Postgres and Electric for a
Docker-less local mode without environments (Electric ships only as a
Docker image today).

### 5. CI/CD and signing

On tag: tests, per-platform server bundles, the macOS app signed and
notarized, Windows and Linux app packages, everything uploaded with the
manifest. Desktop self-update through the framework's updater reading the
same signed manifests; server updates through the launcher. The model
mirror stays a release asset.

## Licences, measured 2026-10-03

- **Domo itself is FSL-1.1-ALv2** (`LICENSE.md`): source-available, not
  open source; commercial use by the author is already permitted, and each
  version becomes Apache-2.0 two years after release. Versions already
  published stay FSL for whoever has them; everything from the first
  closed build onward can be under the product's own terms (sole copyright
  holder).
- **Every dependency permits closed-source commercial use, with
  attribution.** npm production tree: 706 MIT, 38 Apache-2.0, 38 ISC, BSD,
  BlueOak, CC0; `lightningcss` MPL-2.0 (file-level copyleft, fine
  unmodified); `node-forge` "BSD-3 OR GPL-2" (take BSD); `caniuse-lite`
  CC-BY-4.0; `vaul-vue` MIT upstream (no licence field). No GPL, AGPL, SSPL
  or BUSL. Obligation: ship a third-party notices file.
- Models: Whisper MIT, Moonshine MIT, Kokoro Apache-2.0, Smart Turn BSD-2,
  Pocket TTS weights CC-BY-4.0 with Kyutai's prohibited-use terms (on the
  mirror's release page); the `pocket-tts` package MIT.
- Services and tools: Postgres (PostgreSQL licence), ElectricSQL
  Apache-2.0, Caddy Apache-2.0, Node MIT, pnpm MIT, uv Apache/MIT.
- **The one non-licence:** `@anthropic-ai/claude-agent-sdk` is proprietary
  ("© Anthropic PBC. All rights reserved. Use is subject to the Legal
  Agreements at code.claude.com/docs/en/legal-and-compliance"), reached
  through the Apache-2.0 ACP adapter. And Domo runs Claude Code on the
  user's Claude subscription via `claude setup-token`. Whether a commercial
  third-party product may drive subscription-billed Claude Code sessions is
  a question for Anthropic's terms and a lawyer, not the dependency tree.
  Codex (Apache-2.0 code, OpenAI's service terms) and OpenCode (MIT) are
  the same question in milder form.

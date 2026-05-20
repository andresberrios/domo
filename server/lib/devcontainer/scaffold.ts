/**
 * Starter `devcontainer.json` writer used by `projects.add` when a
 * project has no existing devcontainer config. v1 is intentionally
 * minimal: a sensible base image + Docker-in-Docker (so the user's
 * inner `docker compose` works) + a placeholder for the Domo
 * claude Feature.
 *
 * Compose-aware scaffolds (mounting an existing `docker-compose.yml`
 * via `dockerComposeFile`) are deferred — the v1 template uses an
 * image + DinD feature, which covers most repos. Users with compose
 * needs can rewrite the scaffolded file by hand for now.
 *
 * The Domo claude Feature reference is a placeholder string the
 * scaffold publishes verbatim — it points at a Feature image we
 * haven't yet published. Step 3b lands the Feature; until then the
 * scaffolded devcontainer expects `claude` to be on the base image's
 * PATH or installed by `postCreateCommand`. Users who scaffold
 * before step 3b ships will see the Feature key as a comment.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { findDevcontainer } from './parser'

export interface ScaffoldOptions {
  workspaceFolder: string
  name: string
  /** Whether the repo already has a docker-compose.yml; informational
   * only in v1 (we still scaffold the image+DinD template). */
  composeDetected: boolean
}

/** Render the starter content. Exposed for tests / future tweaks. */
export function renderStarter(opts: ScaffoldOptions): string {
  const note = opts.composeDetected
    ? '\n  // NOTE: a docker-compose.yml was detected in this repo. You can\n  // switch this scaffold to a compose-based devcontainer by replacing\n  // `image` with `dockerComposeFile` + `service` (see\n  // https://containers.dev/implementors/json_reference/).'
    : ''
  return `// devcontainer.json — scaffolded by Domo on project add.
// Spec reference: https://containers.dev/implementors/json_reference/
{
  "name": "${escapeJson(opts.name)}",${note}
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "remoteUser": "vscode",

  // Inner Docker-in-Docker so the user's own \`docker compose\` runs
  // isolated per env. The host-side runtime choice (sysbox-runc vs
  // rootless-dind vs privileged) is detected by Domo at \`up\` time.
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {
      "version": "latest",
      "moby": false
    }
    // TODO: when the Domo claude Feature is published, replace the
    // \`postCreateCommand\` claude install below with a Feature
    // reference here for version-pinning + caching:
    //   "ghcr.io/andresberrios/domo-features/claude:0": {}
  },

  // First-build hook — installs the Claude Code CLI inside the
  // container using Anthropic's official installer (auto-detects
  // platform; no Node dependency on the base image). Domo runs
  // \`claude\` here (not on the host) so hooks / CLAUDE.md / MCP
  // servers see the container's tooling.
  //
  // \`bubblewrap\` is a hard requirement for Claude Code's subprocess
  // env scrubbing / sandbox path (\`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1\`
  // — Domo's billing pin requires it). It's not in the Microsoft base
  // image, so we install it here in the same step as the CLI.
  "postCreateCommand": "sudo apt-get update -y && sudo apt-get install -y bubblewrap && curl -fsSL https://claude.ai/install.sh | bash",

  // Ports Domo should publish to the host (random loopback ports).
  // Add entries like 3000 / "5432/tcp" once your services need them;
  // label them in \`portsAttributes\` so they show up named in the UI.
  "forwardPorts": [],
  "portsAttributes": {}

  // Shared OAuth + slash commands + MCP across envs — Domo bind-mounts
  // <DOMO_HOME>/claude-home to /home/<remoteUser>/.claude automatically;
  // you don't need to declare a mount for that. Run \`claude /login\`
  // once from any env's terminal and the credentials propagate to every
  // env across the install.
}
`
}

function escapeJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export interface ScaffoldResult {
  path: string
  written: boolean
  /** True iff a devcontainer.json already existed and we didn't touch it. */
  preexisting: boolean
}

/**
 * Write `.devcontainer/devcontainer.json` if absent; no-op if either
 * standard location already has one. Returns the resolved path either
 * way. Throws if writing fails.
 */
export async function scaffoldDevcontainer(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const existing = await findDevcontainer(opts.workspaceFolder)
  if (existing) {
    return { path: existing, written: false, preexisting: true }
  }
  const target = join(opts.workspaceFolder, '.devcontainer', 'devcontainer.json')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, renderStarter(opts), 'utf8')
  return { path: target, written: true, preexisting: false }
}

/**
 * Domo's built-in devcontainer config — used whenever a project has no
 * `devcontainer.json` of its own. Step 8 makes the config file optional
 * (decided 2026-05-21, supersedes BUGS.md #18). Users get a working env
 * out of the box; they can add a `devcontainer.json` later to customize,
 * and drift detection prompts them to rebuild when they do.
 *
 * The config is intentionally **in-memory only** — `client.ts:up()`
 * splices this into its `--override-config` overlay just like it would
 * a parsed project devcontainer. No file is written to the repo.
 *
 * Shape matches `scaffold.ts:renderStarter()` so users who later opt
 * into customization (via the deferred "Customize devcontainer" button)
 * get a starter file that mirrors what they were already running.
 *
 * `workspaceFolder` is **deliberately omitted** here. `client.ts:up()`
 * pins `/workspaces/<envName>` into the merged config unconditionally
 * so the engine's path translation (`toHostPath()` and friends) stays
 * stable regardless of host basename — see step 8 decision #8.
 */
import { createHash } from 'node:crypto'

import type { DevcontainerConfig } from './types'
import { DevcontainerNotFoundError, loadDevcontainer } from './parser'

/**
 * Render the Domo default config for an env. `name` is informational
 * (devcontainer.json's `name` field surfaces in `docker ps` labels +
 * the operator's `docker inspect`).
 */
export function domoDefaultConfig(name: string): DevcontainerConfig {
  return {
    name,
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu-22.04',
    remoteUser: 'vscode',
    features: {
      // Inner Docker-in-Docker so the user's `docker compose` works
      // per-env. Host-side runtime selection (sysbox-runc / rootless-
      // dind / privileged) happens in `runtime.ts` at `up` time.
      'ghcr.io/devcontainers/features/docker-in-docker:2': {
        version: 'latest',
        moby: false,
      },
    },
    // `bubblewrap` is a hard requirement for Claude Code's subprocess
    // env scrubbing (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, pinned by
    // billing — BUGS.md #11). Installed here in the same step as the
    // CLI so first-spawn doesn't fail with "bubblewrap is required".
    postCreateCommand:
      'sudo apt-get update -y && sudo apt-get install -y bubblewrap && curl -fsSL https://claude.ai/install.sh | bash',
    forwardPorts: [],
    portsAttributes: {},
  } as DevcontainerConfig
}

export interface ResolvedDevcontainer {
  config: DevcontainerConfig
  /** Path to the project's `devcontainer.json`, or null when the
   * Domo default is in use. UI surfaces "(default config)" in the
   * env overview when null. */
  path: string | null
  /** True iff `config` came from `domoDefaultConfig()`. */
  isDefault: boolean
}

/**
 * Resolve the effective devcontainer config for an env: project's
 * `devcontainer.json` if present, Domo default otherwise. Malformed
 * config still throws (don't silently downgrade — masks user config
 * bugs; design decision in step 8).
 *
 * `envName` becomes the `name` field on the default config; ignored
 * when a project devcontainer exists.
 */
export async function resolveDevcontainerConfig(
  rootPath: string,
  envName: string,
): Promise<ResolvedDevcontainer> {
  try {
    const r = await loadDevcontainer(rootPath)
    return { config: r.config, path: r.path, isDefault: false }
  } catch (e) {
    if (e instanceof DevcontainerNotFoundError) {
      return { config: domoDefaultConfig(envName), path: null, isDefault: true }
    }
    throw e
  }
}

/**
 * sha256 of the resolved devcontainer config — the "user intent" hash
 * that drift detection (step 8 decision #6) tracks per env. Hashes the
 * canonicalized config object (not the file bytes) so insignificant
 * formatting changes — whitespace, trailing commas, comment edits —
 * don't trigger spurious rebuild prompts. Hashes only the user's (or
 * default) config, NOT the Domo-side overlay (labels, runArgs, mounts,
 * env) — those are deterministic per env and shouldn't show up as
 * drift.
 *
 * When the resolved config is the Domo default and that default later
 * changes shape (a Domo release bumps the base image, swaps the
 * postCreateCommand, etc.), the hash naturally changes too — drift
 * detection will prompt rebuild on the affected envs.
 */
export function hashResolvedConfig(config: DevcontainerConfig): string {
  // JSON.stringify preserves the `domoDefaultConfig()` key order
  // exactly; for parsed user configs we run a canonicalized JSON pass
  // (sorted keys) so a key-reordering edit doesn't trigger drift.
  return createHash('sha256').update(canonicalJson(config)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
  return `{${parts.join(',')}}`
}

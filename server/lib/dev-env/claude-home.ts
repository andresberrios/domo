import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { copyIntoContainer, run } from './docker'
import { RUNTIME_ROOT } from './runtime-volume'

/**
 * The only things Domo copies out of the host's `~/.claude` into an environment.
 *
 * An allow-list, not a deny-list, and it is the whole security boundary: the
 * host directory holds `.credentials.json` (a refresh chain that must never be
 * forked — see `claude-credentials.ts`), plus `projects/`, `todos/`, `history`
 * and `sessions`, which are transcripts of every other thing the developer has
 * ever asked Claude Code. None of that belongs to an agent working in a
 * container. What is here is the config a user would reasonably expect to
 * follow them: their global instructions, settings, and anything they wrote.
 */
export const CLAUDE_HOME_ALLOWLIST = ['CLAUDE.md', 'settings.json', 'skills', 'commands', 'agents']

/** The host directory the allow-list is read from, if it exists. */
export async function claudeConfigSource(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.NUXT_CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : null)
  if (!configured) return null
  return access(configured).then(() => configured, () => null)
}

/** Which of the allow-listed entries this host actually has. */
export async function presentEntries(source: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of CLAUDE_HOME_ALLOWLIST) {
    if (await access(join(source, entry)).then(() => true, () => false)) found.push(entry)
  }
  return found
}

/**
 * The version of the Claude Code CLI the runtime volume actually carries.
 *
 * `claude-agent-acp` spawns it as a native binary out of an optional dependency
 * of `@anthropic-ai/claude-agent-sdk`, whose own package version is a different
 * number entirely (0.3.270 ships CLI 2.1.270), so it is asked rather than
 * derived. A glob, because the package name carries the architecture.
 */
export async function claudeCliVersion(containerId: string, user: string): Promise<string | null> {
  const { stdout } = await run('docker', [
    'exec', '--user', user, containerId,
    'sh', '-c', `exec ${RUNTIME_ROOT}/adapters/node_modules/@anthropic-ai/claude-agent-sdk-*/claude --version`
  ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
  // "2.1.270 (Claude Code)"
  return stdout.trim().split(/\s+/)[0] || null
}

/**
 * Give the environment the parts of the host's Claude Code config that are safe
 * to share, and an onboarding state so the CLI does not treat it as a first run.
 *
 * A **copy taken at creation**, not a mount. Mounting the host directory would
 * put `.credentials.json` in the container, and a second Claude Code refreshing
 * that chain logs the developer's own machine out; it would also have the agent
 * writing its session history into the user's real config. The cost is that the
 * copy is a snapshot: a change to the host's `CLAUDE.md` after creation does not
 * reach an existing environment.
 */
export async function seedClaudeHome(input: {
  containerId: string
  user: string
  home: string
}): Promise<void> {
  const claudeHome = `${input.home}/.claude`
  await run('docker', [
    'exec', '--user', input.user, input.containerId, 'mkdir', '-p', claudeHome
  ], { allowFailure: true }).catch(() => {})

  const source = await claudeConfigSource()
  const entries = source ? await presentEntries(source) : []
  if (source && entries.length > 0) {
    await copyIntoContainer({
      source,
      entries,
      containerId: input.containerId,
      user: input.user,
      target: claudeHome
    }).catch((error) => {
      // A config copy is a convenience; an environment without it still works.
      console.warn(`[dev-env] could not copy Claude config into the environment: ${error}`)
    })
  }

  await seedClaudeOnboarding(input)
}

/**
 * Write `$HOME/.claude.json` if the CLI has not written one, so a headless run
 * is never treated as a first launch.
 *
 * Note the path: it is in `$HOME`, *beside* `~/.claude` and not inside it, which
 * is why copying the directory does not carry it.
 */
export async function seedClaudeOnboarding(input: {
  containerId: string
  user: string
  home: string
}): Promise<void> {
  const version = await claudeCliVersion(input.containerId, input.user)
  const seed = JSON.stringify({
    hasCompletedOnboarding: true,
    ...(version ? { lastOnboardingVersion: version } : {})
  })
  await run('docker', [
    'exec', '--interactive', '--user', input.user, input.containerId,
    // Only if absent: once the CLI has its own, it is the CLI's to manage.
    'sh', '-c', 'test -f "$1" || cat > "$1"', 'sh', `${input.home}/.claude.json`
  ], { input: seed, allowFailure: true }).catch(() => {})
}

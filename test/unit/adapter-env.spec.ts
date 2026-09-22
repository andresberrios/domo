import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adapterEnv, adapterLaunch, opencodeConfigContent } from '../../server/lib/acp/adapter-process'

/** `gh` must never be spawned from a test, so the lookup is always injected. */
const noGh = async () => null

/**
 * What the adapter process is allowed to inherit.
 *
 * Two separate concerns live here: not letting a parent Claude Code session's
 * identity leak into a nested one (the allow-list), and not describing the
 * *host* to a process running in a container (the host-only exclusions).
 */

const saved = { ...process.env }
const systemTmp = tmpdir()

beforeEach(() => {
  // A token, so the Claude branch never reaches the Keychain — reading it would
  // open a GUI prompt in the middle of `pnpm test`.
  process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test'
  process.env.TMPDIR = '/var/folders/zm/abc/T/'
  process.env.PATH = '/opt/homebrew/bin:/usr/bin'
  process.env.LANG = 'en_US.UTF-8'
  process.env.HTTPS_PROXY = 'http://proxy:8080'
  process.env.CLAUDECODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.8Kq/Listeners'
  // Whatever shell the suite was started from may have a real one, and these
  // tests are about the precedence, not about this machine.
  delete process.env.GH_TOKEN
  delete process.env.NUXT_GH_TOKEN
})

afterEach(() => {
  process.env = { ...saved }
})

describe('adapterEnv on the host', () => {
  it('passes the host\'s own paths through', async () => {
    const env = await adapterEnv('claude-code', false, noGh)

    expect(env.TMPDIR).toBe('/var/folders/zm/abc/T/')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    // The host's own agent, so a session on this machine can push too.
    expect(env.SSH_AUTH_SOCK).toBe('/private/tmp/com.apple.launchd.8Kq/Listeners')
  })

  it('never passes a parent Claude Code session\'s identity', async () => {
    const env = await adapterEnv('claude-code', false, noGh)

    // The symptom was `session/new` failing with a bare "Internal error".
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })
})

describe('adapterEnv in a container', () => {
  it('drops the host paths that mean something else in there', async () => {
    const env = await adapterEnv('claude-code', true, noGh)

    // `TMPDIR` is the one that bites: Claude Code exits 1 with
    // `EACCES: mkdir '/var/folders'`, reported as a bare "Internal error".
    expect(env.TMPDIR).toBeUndefined()
    // The image's own PATH is right, and `docker exec` supplies it.
    expect(env.PATH).toBeUndefined()
    expect(env.HOME).toBeUndefined()
    expect(env.SHELL).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.SSL_CERT_FILE).toBeUndefined()
    // The environment has its own, put on the container by `docker run` and
    // inherited by `docker exec`; the host's path is not a path in there.
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
  })

  it('keeps what still describes the session rather than the machine', async () => {
    const env = await adapterEnv('claude-code', true, noGh)

    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
  })
})

describe('the Claude credential precedence', () => {
  it('prefers the OAuth token and then passes no API key at all', async () => {
    process.env.NUXT_ANTHROPIC_API_KEY = 'sk-ant-api-test'

    const env = await adapterEnv('claude-code', true, noGh)

    // An API key outranks OAuth *inside* Claude Code and, non-interactively, is
    // used with no prompt — passing both would silently bill the API.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('falls back to the API key in a container, where there is no host login', async () => {
    delete process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN
    process.env.NUXT_ANTHROPIC_API_KEY = 'sk-ant-api-test'

    const env = await adapterEnv('claude-code', true, noGh)

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api-test')
  })
})

describe('adapterEnv for codex', () => {
  it('asks for api-key auth only when it has a key to use', async () => {
    process.env.NUXT_CODEX_API_KEY = 'codex-test'

    const withKey = await adapterEnv('codex', false, noGh)
    expect(withKey.CODEX_API_KEY).toBe('codex-test')
    expect(JSON.parse(withKey.DEFAULT_AUTH_REQUEST!)).toEqual({ methodId: 'api-key' })

    delete process.env.NUXT_CODEX_API_KEY
    const withoutKey = await adapterEnv('codex', false, noGh)
    // No key means `codex login` is the credential, and forcing api-key would
    // stop it being used.
    expect(withoutKey.DEFAULT_AUTH_REQUEST).toBeUndefined()
  })
})

describe('OpenCode', () => {
  it('launches the native CLI through its ACP subcommand', () => {
    process.env.NUXT_OPENCODE_ACP_ENTRY = '/opt/opencode/bin/opencode'
    expect(adapterLaunch('opencode')).toEqual({ command: '/opt/opencode/bin/opencode', args: ['acp'] })
    delete process.env.NUXT_OPENCODE_ACP_ENTRY
  })

  it('passes an explicit auth snapshot and common provider keys', async () => {
    process.env.NUXT_OPENCODE_AUTH_CONTENT = '{"opencode-go":{"type":"api","key":"secret"}}'
    process.env.NUXT_OPENAI_API_KEY = 'openai-test'
    const env = await adapterEnv('opencode', true, noGh)

    expect(env.OPENCODE_AUTH_CONTENT).toContain('opencode-go')
    expect(env.OPENAI_API_KEY).toBe('openai-test')
  })

  it('finds the global config that managed environments receive as a snapshot', async () => {
    const home = await mkdtemp(join(systemTmp, 'domo-opencode-'))
    try {
      const directory = join(home, '.config', 'opencode')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'opencode.jsonc'), '{ // global\n "agent": {}\n }')

      await expect(opencodeConfigContent({ HOME: home })).resolves.toContain('"agent"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

/**
 * On macOS `gh` keeps its token in the Keychain, so the mounted `~/.config/gh`
 * names the account and carries no `oauth_token` at all. Without `GH_TOKEN` the
 * environment's `gh` is half logged in and the `gh auth git-credential` helper
 * in its git config answers nothing.
 */
describe('the GitHub token for an environment', () => {
  it('prefers a configured one over asking the host\'s gh', async () => {
    process.env.NUXT_GH_TOKEN = 'gho-configured'
    const lookup = vi.fn(async () => 'gho-from-gh')

    const env = await adapterEnv('claude-code', true, lookup)

    expect(env.GH_TOKEN).toBe('gho-configured')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('falls back to the host\'s own gh login', async () => {
    const env = await adapterEnv('claude-code', true, async () => 'gho-from-gh')

    expect(env.GH_TOKEN).toBe('gho-from-gh')
  })

  it('passes none when there is none — no gh, no login, a hung call', async () => {
    const env = await adapterEnv('claude-code', true, noGh)

    expect(env.GH_TOKEN).toBeUndefined()
  })

  it('never asks on the host, where gh reads its own login', async () => {
    const lookup = vi.fn(async () => 'gho-from-gh')

    const env = await adapterEnv('claude-code', false, lookup)

    expect(lookup).not.toHaveBeenCalled()
    expect(env.GH_TOKEN).toBeUndefined()
  })

  it('does it for Codex sessions too — pushing is not adapter-specific', async () => {
    const env = await adapterEnv('codex', true, async () => 'gho-from-gh')

    expect(env.GH_TOKEN).toBe('gho-from-gh')
  })
})

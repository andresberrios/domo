import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { adapterEnv } from '../../server/lib/acp/adapter-process'

/**
 * What the adapter process is allowed to inherit.
 *
 * Two separate concerns live here: not letting a parent Claude Code session's
 * identity leak into a nested one (the allow-list), and not describing the
 * *host* to a process running in a container (the host-only exclusions).
 */

const saved = { ...process.env }

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
})

afterEach(() => {
  process.env = { ...saved }
})

describe('adapterEnv on the host', () => {
  it('passes the host\'s own paths through', async () => {
    const env = await adapterEnv('claude-code', false)

    expect(env.TMPDIR).toBe('/var/folders/zm/abc/T/')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('never passes a parent Claude Code session\'s identity', async () => {
    const env = await adapterEnv('claude-code', false)

    // The symptom was `session/new` failing with a bare "Internal error".
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })
})

describe('adapterEnv in a container', () => {
  it('drops the host paths that mean something else in there', async () => {
    const env = await adapterEnv('claude-code', true)

    // `TMPDIR` is the one that bites: Claude Code exits 1 with
    // `EACCES: mkdir '/var/folders'`, reported as a bare "Internal error".
    expect(env.TMPDIR).toBeUndefined()
    // The image's own PATH is right, and `docker exec` supplies it.
    expect(env.PATH).toBeUndefined()
    expect(env.HOME).toBeUndefined()
    expect(env.SHELL).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.SSL_CERT_FILE).toBeUndefined()
  })

  it('keeps what still describes the session rather than the machine', async () => {
    const env = await adapterEnv('claude-code', true)

    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
  })
})

describe('the Claude credential precedence', () => {
  it('prefers the OAuth token and then passes no API key at all', async () => {
    process.env.NUXT_ANTHROPIC_API_KEY = 'sk-ant-api-test'

    const env = await adapterEnv('claude-code', true)

    // An API key outranks OAuth *inside* Claude Code and, non-interactively, is
    // used with no prompt — passing both would silently bill the API.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('falls back to the API key in a container, where there is no host login', async () => {
    delete process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN
    process.env.NUXT_ANTHROPIC_API_KEY = 'sk-ant-api-test'

    const env = await adapterEnv('claude-code', true)

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api-test')
  })
})

describe('adapterEnv for codex', () => {
  it('asks for api-key auth only when it has a key to use', async () => {
    process.env.NUXT_CODEX_API_KEY = 'codex-test'

    const withKey = await adapterEnv('codex', false)
    expect(withKey.CODEX_API_KEY).toBe('codex-test')
    expect(JSON.parse(withKey.DEFAULT_AUTH_REQUEST!)).toEqual({ methodId: 'api-key' })

    delete process.env.NUXT_CODEX_API_KEY
    const withoutKey = await adapterEnv('codex', false)
    // No key means `codex login` is the credential, and forcing api-key would
    // stop it being used.
    expect(withoutKey.DEFAULT_AUTH_REQUEST).toBeUndefined()
  })
})

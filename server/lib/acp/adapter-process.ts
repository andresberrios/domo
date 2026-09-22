import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { claudeOauthToken, hasClaudeSubscriptionLogin } from '../claude-credentials'
import type { AgentAdapter } from '../../../shared/types'

export const ADAPTERS: Record<AgentAdapter, { packageName: string, entryOverride: string }> = {
  'claude-code': {
    packageName: '@agentclientprotocol/claude-agent-acp',
    entryOverride: 'NUXT_CLAUDE_ACP_ENTRY'
  },
  codex: {
    packageName: '@agentclientprotocol/codex-acp',
    entryOverride: 'NUXT_CODEX_ACP_ENTRY'
  },
  opencode: {
    packageName: 'opencode-ai',
    entryOverride: 'NUXT_OPENCODE_ACP_ENTRY'
  }
}

/**
 * Resolve an ACP adapter entry point.
 *
 * The production bundle runs from a virtual module path, so `import.meta.url`
 * resolution fails there; resolving from the working directory finds the real
 * `node_modules` in both dev and a built server.
 */
export function adapterEntry(adapter: AgentAdapter): string {
  const definition = ADAPTERS[adapter]
  const override = process.env[definition.entryOverride]
  if (override) return override

  const resolvers = [
    () => createRequire(pathToFileURL(join(process.cwd(), 'package.json')).href)
      .resolve(`${definition.packageName}/package.json`),
    () => createRequire(import.meta.url).resolve(`${definition.packageName}/package.json`)
  ]

  for (const resolvePkg of resolvers) {
    try {
      const pkgPath = resolvePkg()
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: Record<string, string> | string }
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0]
      return join(dirname(pkgPath), bin ?? 'dist/index.js')
    } catch {
      /* try the next strategy */
    }
  }

  throw new Error(
    `Could not find ${definition.packageName}. Run \`pnpm install\` in the Domo directory, `
    + `or point ${definition.entryOverride} at the adapter entry file.`
  )
}

/**
 * The actual process invocation for an adapter.
 *
 * Claude and Codex ship JavaScript ACP adapters, while OpenCode is a native
 * executable whose `acp` subcommand is the adapter. Keeping that distinction
 * here prevents every caller from growing its own special case.
 */
export function adapterLaunch(adapter: AgentAdapter): { command: string, args: string[] } {
  const entry = adapterEntry(adapter)
  if (adapter === 'opencode' && /\.[cm]?js$/.test(entry)) {
    return { command: process.execPath, args: [entry, 'acp'] }
  }
  return adapter === 'opencode'
    ? { command: entry, args: ['acp'] }
    : { command: process.execPath, args: [entry] }
}

/**
 * Environment variables the adapter needs. Everything else is dropped on
 * purpose: when Domo itself is launched from a Claude Code session, inheriting
 * that session's `CLAUDE_*` / `CLAUDECODE` variables makes the nested CLI adopt
 * the parent's identity and flags, which fails in confusing ways.
 */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  // The host's SSH agent, so a host session can push. A container session gets
  // the forwarded one from the container's own environment instead.
  'SSH_AUTH_SOCK',
  // Windows needs these to spawn anything at all.
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
  'ProgramData',
  'COMSPEC',
  'PATHEXT'
]

/** The allow-list itself, so a test can assert nothing else got through. */
export const PASSTHROUGH_ENV_FOR_TEST: readonly string[] = PASSTHROUGH_ENV

/**
 * Variables that describe *this machine* and mean something else inside a
 * container, so they are dropped for an environment-backed session.
 *
 * `TMPDIR` is the one that bites: on macOS it is a per-user
 * `/var/folders/…/T/` path that does not exist in the container, and Claude
 * Code exits 1 with `EACCES: permission denied, mkdir '/var/folders'` — which
 * the adapter reports as a bare "Internal error". `PATH` is equally wrong (the
 * image's own is better, and `docker exec` supplies it), and the rest name host
 * files or a host user.
 */
const HOST_ONLY_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // The environment has its own, set on the container by `docker run` and
  // inherited by every `docker exec`. The host's path is not a path in there.
  'SSH_AUTH_SOCK',
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
  'ProgramData',
  'COMSPEC',
  'PATHEXT'
])

/** How long a `gh auth token` answer is reused before asking again. */
const GH_TOKEN_TTL_MS = 5 * 60_000
const GH_TOKEN_TIMEOUT_MS = 5_000

let ghTokenCache: { value: string | null, expires: number } | null = null
let warnedNoGhToken = false

export type GhTokenLookup = () => Promise<string | null>

/** The auth store written by `opencode auth login`, when this host has one. */
export async function opencodeAuthContent(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.NUXT_OPENCODE_AUTH_CONTENT || env.OPENCODE_AUTH_CONTENT
  if (explicit) return explicit
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : null)
  if (!dataHome) return null
  return readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8').catch(() => null)
}

/**
 * The global OpenCode config to carry into a managed environment.
 *
 * Project-local `opencode.json` files are already in the checkout. This covers
 * global providers and agents without mounting the whole config directory.
 * OpenCode accepts JSONC in `OPENCODE_CONFIG_CONTENT`, so preserve it verbatim.
 */
export async function opencodeConfigContent(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.NUXT_OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_CONTENT
  if (explicit) return explicit
  if (env.OPENCODE_CONFIG) return readFile(env.OPENCODE_CONFIG, 'utf8').catch(() => null)
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : null)
  if (!configHome) return null
  const base = join(configHome, 'opencode')
  return readFile(join(base, 'opencode.json'), 'utf8')
    .catch(() => readFile(join(base, 'opencode.jsonc'), 'utf8'))
    .catch(() => null)
}

/**
 * The GitHub token the host's `gh` is logged in with.
 *
 * On macOS `gh` keeps it in the Keychain, so the mounted `~/.config/gh` carries
 * the account but no `oauth_token` at all: inside an environment `gh` would be
 * half logged in and `gh auth git-credential` — which the generated git config
 * names as the credential helper — would answer nothing. Asking the host's own
 * `gh` is the one place the token is reachable whatever it is stored in.
 *
 * Cached, because it is asked on every session boot and `gh` is not fast, and
 * best-effort: no `gh`, no login, or a hung call all mean "no token".
 */
export async function hostGhToken(): Promise<string | null> {
  if (ghTokenCache && ghTokenCache.expires > Date.now()) return ghTokenCache.value
  const value = await promisify(execFile)('gh', ['auth', 'token'], { timeout: GH_TOKEN_TIMEOUT_MS })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
  ghTokenCache = { value, expires: Date.now() + GH_TOKEN_TTL_MS }
  if (!value && !warnedNoGhToken) {
    warnedNoGhToken = true
    console.warn(
      '[acp] no GitHub token for development environments: `gh auth token` answered nothing. '
      + 'Run `gh auth login` on this machine, or set NUXT_GH_TOKEN, if agents need to push.'
    )
  }
  return value
}

/**
 * Environment for the adapter process.
 *
 * The Claude branch is a precedence, not a union: `ANTHROPIC_API_KEY` outranks
 * every OAuth path *inside* Claude Code and, in non-interactive mode, is used
 * with no approval prompt — so passing it alongside a subscription login
 * silently moves the work onto API billing. A `claude setup-token` token first,
 * then the host's own login, and only then the key.
 *
 * Inside an environment only the token can apply: nothing copies a login into a
 * container, so there is no Keychain and no credentials file to ask about.
 */
export async function adapterEnv(
  adapter: AgentAdapter,
  inContainer: boolean,
  /** Injected by the unit layer: `gh` must never be spawned from a test. */
  ghToken: GhTokenLookup = hostGhToken
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV) {
    if (inContainer && HOST_ONLY_ENV.has(key)) continue
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (inContainer) {
    // `GH_TOKEN` is what makes both `gh` and the `gh auth git-credential`
    // helper in the environment's git config work. On the host neither needs
    // it: `gh` there reads its own login.
    const token = process.env.NUXT_GH_TOKEN || process.env.GH_TOKEN || await ghToken()
    if (token) env.GH_TOKEN = token
  }
  if (adapter === 'claude-code') {
    const oauthToken = claudeOauthToken()
    const apiKey = process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
    else if (apiKey && (inContainer || !await hasClaudeSubscriptionLogin())) env.ANTHROPIC_API_KEY = apiKey
  } else if (adapter === 'codex') {
    const codexKey = process.env.NUXT_CODEX_API_KEY || process.env.CODEX_API_KEY
    const openAiKey = process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY
    if (codexKey) env.CODEX_API_KEY = codexKey
    if (openAiKey) env.OPENAI_API_KEY = openAiKey
    if (codexKey || openAiKey) {
      env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: 'api-key' })
    }
  } else {
    // OpenCode can use dozens of providers from its own `opencode auth login`
    // store. These explicit values cover headless installs without turning the
    // adapter allow-list into "every secret whose name happens to end in KEY".
    const anthropicKey = process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
    const openAiKey = process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY
    const authContent = await opencodeAuthContent()
    const configContent = inContainer
      ? await opencodeConfigContent()
      : process.env.NUXT_OPENCODE_CONFIG_CONTENT || process.env.OPENCODE_CONFIG_CONTENT
    if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey
    if (openAiKey) env.OPENAI_API_KEY = openAiKey
    if (authContent) env.OPENCODE_AUTH_CONTENT = authContent
    if (configContent) env.OPENCODE_CONFIG_CONTENT = configContent
    if (!inContainer) {
      if (process.env.OPENCODE_CONFIG) env.OPENCODE_CONFIG = process.env.OPENCODE_CONFIG
      if (process.env.OPENCODE_CONFIG_DIR) env.OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR
    }
  }
  return env
}

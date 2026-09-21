import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { hasClaudeSubscriptionLogin } from '../claude-credentials'
import type { AgentAdapter } from '../../../shared/types'

export const ADAPTERS: Record<AgentAdapter, { packageName: string, entryOverride: string }> = {
  'claude-code': {
    packageName: '@agentclientprotocol/claude-agent-acp',
    entryOverride: 'NUXT_CLAUDE_ACP_ENTRY'
  },
  codex: {
    packageName: '@agentclientprotocol/codex-acp',
    entryOverride: 'NUXT_CODEX_ACP_ENTRY'
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
export async function adapterEnv(adapter: AgentAdapter, inContainer: boolean): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (adapter === 'claude-code') {
    const oauthToken = process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
    else if (apiKey && (inContainer || !await hasClaudeSubscriptionLogin())) env.ANTHROPIC_API_KEY = apiKey
  } else {
    const codexKey = process.env.NUXT_CODEX_API_KEY || process.env.CODEX_API_KEY
    const openAiKey = process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY
    if (codexKey) env.CODEX_API_KEY = codexKey
    if (openAiKey) env.OPENAI_API_KEY = openAiKey
    if (codexKey || openAiKey) {
      env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: 'api-key' })
    }
  }
  return env
}

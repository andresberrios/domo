import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEnv, adapterLaunch, hostGhToken } from './adapter-process'
import {
  COPILOT_AUTO_MODEL,
  copilotGithubToken,
  fetchCopilotAccount,
  fetchCopilotModels,
  type CopilotModel
} from '../copilot-credentials'

/**
 * The token Domo reads Copilot's models and plan limits with: the one saved
 * in Settings, else the `gh` token an environment session would sign in with.
 * A host session may be on its own `copilot login` instead, which Domo cannot
 * read; on one machine that is normally the same GitHub account.
 */
export async function copilotApiToken(): Promise<string | null> {
  return copilotGithubToken() || process.env.NUXT_GH_TOKEN || process.env.GH_TOKEN || await hostGhToken()
}

/** The list moves only when the account changes plan, and the CLI is not asked for it. */
const MODELS_TTL_MS = 60 * 60_000
let modelsCache: { token: string | null, at: number, value: CopilotModel[] } | null = null

/** The models a Copilot session can be put on, for the token that would run it. */
export async function copilotModels(token?: string | null): Promise<CopilotModel[]> {
  const wanted = token === undefined ? await copilotApiToken() : token
  if (modelsCache && modelsCache.token === wanted && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value
  const account = wanted ? await fetchCopilotAccount(wanted).catch(() => null) : null
  const value = await fetchCopilotModels(wanted, account?.body?.endpoints?.api ?? null)
  modelsCache = { token: wanted, at: Date.now(), value }
  return value
}

/** Test seam. */
export function clearCopilotModelCache(): void {
  modelsCache = null
}

/** The `configOptions` select Copilot does not publish, built the way the others publish theirs. */
export function copilotModelOption(models: CopilotModel[], current: string): any {
  const options = models.some(model => model.id === current)
    ? models
    : [...models, { id: current, name: current }]
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: current,
    options: options.map(model => ({ value: model.id, name: model.name }))
  }
}

/**
 * Give a Copilot connection the model option every other adapter has, so
 * nothing past this point needs a Copilot branch.
 *
 * Every response that carries `configOptions` gets a `model` select, and a
 * `session/set_config_option` for it is sent as `session/set_model`, which
 * Copilot 1.0.98 takes (unstable ACP; it answers `{}`). Its answer is the
 * session's last options with the model moved. Copilot names no current model
 * either, so a new or loaded session reads as Auto until Domo sets one, which
 * `applyRequestedModel` does on every attach when the row names another.
 */
export function withCopilotModels<T extends { agent: { request: (...args: any[]) => Promise<any> } }>(
  connection: T,
  models: () => Promise<CopilotModel[]>
): T {
  const original = connection.agent.request.bind(connection.agent)
  const current = new Map<string, string>()
  const lastOptions = new Map<string, any[]>()
  /** Sessions whose Copilot publishes a model option of its own. */
  const native = new Set<string>()

  const decorate = async (sessionId: string, response: any) => {
    if (!response || typeof response !== 'object' || native.has(sessionId)) return response
    // An answer with no options leaves the last ones standing.
    const reported: any[] = Array.isArray(response.configOptions) ? response.configOptions : (lastOptions.get(sessionId) ?? [])
    const own = reported.filter((option: any) => option?.category !== 'model' && option?.id !== 'model')
    // A Copilot that publishes its own model option one day is believed, and
    // this steps aside.
    if (own.length !== reported.length) {
      native.add(sessionId)
      return response
    }
    lastOptions.set(sessionId, own)
    const option = copilotModelOption(await models(), current.get(sessionId) ?? COPILOT_AUTO_MODEL.id)
    return { ...response, configOptions: [...own, option] }
  }

  connection.agent.request = (async (method: string, params: any, ...rest: any[]) => {
    if (method === acp.methods.agent.session.setConfigOption && params?.configId === 'model' && !native.has(params.sessionId)) {
      await original('session/set_model', { sessionId: params.sessionId, modelId: params.value }, ...rest)
      current.set(params.sessionId, String(params.value))
      return decorate(params.sessionId, { configOptions: lastOptions.get(params.sessionId) ?? [] })
    }
    const response = await original(method, params, ...rest)
    if (method === acp.methods.agent.session.new) return decorate(response?.sessionId, response)
    if (method === acp.methods.agent.session.load || method === acp.methods.agent.session.setConfigOption) {
      return decorate(params?.sessionId, response)
    }
    return response
  }) as T['agent']['request']
  return connection
}

const LOGIN_TTL_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 20_000
let loginCache: { at: number, value: boolean } | null = null

/**
 * Whether Copilot on this computer is signed in by itself, through
 * `copilot login`: asked, because the login is in the system credential store
 * and Domo reads no one else's secrets. A `session/new` with no token in the
 * environment answers "Authentication required" when there is none. It costs
 * no request against the plan, and the empty session is closed again.
 */
export async function copilotHostLogin(): Promise<boolean> {
  if (loginCache && Date.now() - loginCache.at < LOGIN_TTL_MS) return loginCache.value
  const value = await askHostLogin().catch(() => false)
  loginCache = { at: Date.now(), value }
  return value
}

async function askHostLogin(): Promise<boolean> {
  const cwd = await mkdtemp(join(tmpdir(), 'domo-copilot-'))
  const { COPILOT_GITHUB_TOKEN: _token, ...env } = await adapterEnv('copilot', false)
  const launch = adapterLaunch('copilot')
  const proc = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const connection = acp.client({ name: 'domo' }).connect(acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    ))
    const asking = (async () => {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
      } as any)
      try {
        const created = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] } as any) as any
        await connection.agent.request('session/close', { sessionId: created.sessionId } as any).catch(() => {})
        return true
      } catch (error: any) {
        if (/auth/i.test(String(error?.message ?? error))) return false
        throw error
      }
    })()
    const gone = new Promise<never>((_, reject) => {
      proc.once('exit', code => reject(new Error(`copilot exited (code ${code})`)))
      timer = setTimeout(() => reject(new Error('copilot did not answer')), LOGIN_TIMEOUT_MS)
    })
    return await Promise.race([asking, gone])
  } finally {
    if (timer) clearTimeout(timer)
    proc.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Copilot refuses a stdio MCP server handed over ACP (1.0.98 logs "Rejecting
 * non-http/sse MCP server … from client" and the session goes on without it),
 * so those are given at launch instead, through `--additional-mcp-config`.
 * A file rather than the JSON itself, because a server's environment can hold
 * a secret and an argument is visible to every process on the machine.
 */
export function copilotMcpConfig(servers: Array<{ name: string, command: string, args?: string[], env?: Array<{ name: string, value: string }> }>): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(servers.map(server => [server.name, {
      type: 'local',
      command: server.command,
      args: server.args ?? [],
      env: Object.fromEntries((server.env ?? []).map(entry => [entry.name, entry.value])),
      tools: ['*']
    }]))
  })
}

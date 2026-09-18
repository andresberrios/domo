import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { bus } from '../bus'
import {
  containerExecArgs,
  ensureEnvironmentAdapter,
  ensureEnvironmentRunning,
  readEnvironmentFile,
  writeEnvironmentFile
} from '../dev-environments'
import { getSettings } from '../settings'
import {
  appendAgentEvent,
  createAgentSession,
  createPermission,
  getAgentSession,
  listAgentSessions,
  listMcpServers,
  resolvePermissionRow,
  updateAgentSession
} from '../repo'
import type { AgentAdapter, AgentSession, DevEnvironment, PendingPermission } from '../../../shared/types'

const ADAPTERS: Record<AgentAdapter, { packageName: string, command: string, entryOverride: string }> = {
  'claude-code': {
    packageName: '@agentclientprotocol/claude-agent-acp',
    command: 'claude-agent-acp',
    entryOverride: 'NUXT_CLAUDE_ACP_ENTRY'
  },
  codex: {
    packageName: '@agentclientprotocol/codex-acp',
    command: 'codex-acp',
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
function adapterEntry(adapter: AgentAdapter): string {
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

function adapterEnv(adapter: AgentAdapter): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (adapter === 'claude-code') {
    const apiKey = process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey
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

interface PendingPermissionWaiter {
  permission: PendingPermission
  resolve: (optionId: string | null) => void
}

class AgentRuntime {
  readonly agentSessionId: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientConnection | null = null
  private acpSessionId: string | null = null
  private booting: Promise<void> | null = null
  private waiters = new Map<string, PendingPermissionWaiter>()
  private turn: { cancel: () => void } | null = null
  private containerName: string | null = null
  private containerPidFile: string | null = null
  /** Buffer of the current streaming assistant message, flushed into events. */
  private textBuffer = ''

  constructor(agentSessionId: string) {
    this.agentSessionId = agentSessionId
  }

  get sessionId() {
    return this.acpSessionId
  }

  get alive() {
    return !!this.proc && !this.proc.killed
  }

  async ensureStarted(): Promise<void> {
    if (this.connection && this.acpSessionId && this.alive) return
    if (!this.booting) {
      this.booting = this.boot().catch(async (error) => {
        this.booting = null
        const message = error instanceof Error ? error.message : String(error)
        await updateAgentSession(this.agentSessionId, { status: 'error', lastError: message })
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        throw error
      })
    }
    return this.booting
  }

  private async boot(): Promise<void> {
    const session = await getAgentSession(this.agentSessionId)
    if (!session) throw new Error(`Agent session ${this.agentSessionId} not found`)

    await updateAgentSession(this.agentSessionId, { status: 'starting', lastError: null })

    let environment: DevEnvironment | null = null
    const definition = ADAPTERS[session.adapter]
    const env = adapterEnv(session.adapter)
    let proc: ChildProcessWithoutNullStreams
    if (session.devEnvironmentId) {
      environment = await ensureEnvironmentRunning(session.devEnvironmentId)
      await ensureEnvironmentAdapter(environment, session.adapter)
      this.containerName = environment.containerName
      this.containerPidFile = `/tmp/domo-agent-${this.agentSessionId}.pid`
      env.USER = environment.remoteUser ?? 'root'
      env.HOME = env.USER === 'root' ? '/root' : `/home/${env.USER}`
      env.LOGNAME = env.USER
      proc = spawn('docker', [
        ...containerExecArgs(environment, env),
        'sh', '-c', 'echo $$ > "$1"; exec "$2"', 'sh', this.containerPidFile, definition.command
      ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    } else {
      await mkdir(session.cwd, { recursive: true }).catch(() => {})
      proc = spawn(process.execPath, [adapterEntry(session.adapter)], {
        cwd: session.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
    }
    this.proc = proc

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.error(`[acp:${this.agentSessionId}] ${text}`)
    })
    proc.on('exit', (code, signal) => {
      this.connection = null
      this.acpSessionId = null
      this.booting = null
      this.proc = null
      this.containerName = null
      this.containerPidFile = null
      for (const waiter of this.waiters.values()) waiter.resolve(null)
      this.waiters.clear()
      void appendAgentEvent(this.agentSessionId, 'adapter-exit', { code, signal })
      void updateAgentSession(this.agentSessionId, { status: 'stopped' })
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    )

    const connection = acp
      .client({ name: 'domo' })
      .onNotification(acp.methods.client.session.update, ctx => this.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, ctx => this.onPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const { path, line, limit } = ctx.params
        const content = environment
          ? await readEnvironmentFile(environment, path)
          : await readFile(path, 'utf8')
        if (line == null && limit == null) return { content }
        const lines = content.split('\n')
        const start = Math.max(0, (line ?? 1) - 1)
        const end = limit == null ? lines.length : start + limit
        return { content: lines.slice(start, end).join('\n') }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        if (environment) {
          await writeEnvironmentFile(environment, ctx.params.path, ctx.params.content)
        } else {
          await mkdir(dirname(ctx.params.path), { recursive: true })
          await writeFile(ctx.params.path, ctx.params.content, 'utf8')
        }
        return {}
      })
      .connect(stream)
    this.connection = connection

    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true }
      },
      clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
    } as any)

    const mcpServers = await this.mcpServersForSession(environment)
    const settings = await getSettings()

    if (session.acpSessionId) {
      try {
        await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: session.acpSessionId,
          cwd: session.cwd,
          mcpServers
        } as any)
        this.acpSessionId = session.acpSessionId
      } catch (error) {
        console.error(`[acp:${this.agentSessionId}] load failed, starting fresh`, error)
      }
    }

    if (!this.acpSessionId) {
      const created = (await connection.agent.request(acp.methods.agent.session.new, {
        cwd: session.cwd,
        mcpServers
      } as any)) as any
      this.acpSessionId = created.sessionId
      const modes = created.modes
        ? {
            current: created.modes.currentModeId,
            available: (created.modes.availableModes ?? []).map((m: any) => ({
              id: m.id,
              name: m.name,
              description: m.description ?? null
            }))
          }
        : null
      await updateAgentSession(this.agentSessionId, {
        acpSessionId: created.sessionId,
        modes: modes?.available ?? null,
        modeId: modes?.current ?? session.modeId ?? settings.defaultAgentMode
      })
      const desiredMode = session.modeId || settings.defaultAgentMode
      if (desiredMode && modes?.current && desiredMode !== modes.current) {
        await this.setMode(desiredMode).catch(() => {})
      }
    }

    await updateAgentSession(this.agentSessionId, { status: 'idle', touch: true })
  }

  private async mcpServersForSession(environment: DevEnvironment | null) {
    const servers = await listMcpServers()
    const out: any[] = []
    for (const server of servers) {
      if (!server.enabled) continue
      if (server.scope !== 'coding' && server.scope !== 'both') continue
      if (server.transport === 'stdio' && server.command) {
        out.push({
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
        })
      } else if (server.url) {
        out.push({
          name: server.name,
          type: server.transport,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
        })
      }
    }
    // The agent-mesh server lets coding agents talk to each other and spawn peers.
    out.push({
      name: 'domo',
      command: environment ? '/usr/bin/node' : process.execPath,
      args: [environment ? '/opt/domo/agent-mesh.mjs' : meshServerEntry()],
      env: [
        { name: 'DOMO_INTERNAL_URL', value: internalBaseUrl(!!environment) },
        { name: 'DOMO_AGENT_SESSION_ID', value: this.agentSessionId }
      ]
    })
    return out
  }

  /* ---------------- session updates ---------------- */

  private async onUpdate(params: any) {
    const update = params?.update
    if (!update) return
    const kind: string = update.sessionUpdate

    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      this.textBuffer += update.content.text
    }

    await appendAgentEvent(this.agentSessionId, kind, update)

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') {
      await updateAgentSession(this.agentSessionId, { status: 'thinking', touch: true })
    }
  }

  private async onPermission(params: any): Promise<any> {
    const settings = await getSettings()
    const options = (params.options ?? []).map((option: any) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind
    }))
    const title: string = params.toolCall?.title || params.toolCall?.rawInput?.description || 'Tool call'

    const permission = await createPermission({
      agentSessionId: this.agentSessionId,
      toolCallId: params.toolCall?.toolCallId ?? null,
      title,
      options,
      toolCall: params.toolCall ?? null
    })
    await appendAgentEvent(this.agentSessionId, 'permission_request', { permissionId: permission.id, ...params })
    await updateAgentSession(this.agentSessionId, { status: 'awaiting-permission', touch: true })

    if (settings.autoApprovePermissions) {
      const auto =
        options.find((o: any) => o.kind === 'allow_once') ?? options.find((o: any) => o.kind === 'allow_always')
      if (auto) {
        await resolvePermissionRow(permission.id, auto.optionId, 'auto')
        await updateAgentSession(this.agentSessionId, { status: 'thinking' })
        return { outcome: { outcome: 'selected', optionId: auto.optionId } }
      }
    }

    const optionId = await new Promise<string | null>((resolvePromise) => {
      this.waiters.set(permission.id, { permission, resolve: resolvePromise })
    })
    this.waiters.delete(permission.id)

    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    await updateAgentSession(this.agentSessionId, { status: 'thinking' })
    return { outcome: { outcome: 'selected', optionId } }
  }

  answerPermission(permissionId: string, optionId: string | null): boolean {
    const waiter = this.waiters.get(permissionId)
    if (!waiter) return false
    waiter.resolve(optionId)
    return true
  }

  hasPermission(permissionId: string) {
    return this.waiters.has(permissionId)
  }

  /* ---------------- turns ---------------- */

  async prompt(content: any[]): Promise<{ stopReason: string }> {
    await this.ensureStarted()
    if (!this.connection || !this.acpSessionId) throw new Error('agent not started')

    this.textBuffer = ''
    await appendAgentEvent(this.agentSessionId, 'user_message', { content })
    await updateAgentSession(this.agentSessionId, { status: 'thinking', touch: true })

    const controller = new AbortController()
    this.turn = { cancel: () => controller.abort() }

    try {
      const response = (await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.acpSessionId, prompt: content } as any,
        { signal: controller.signal } as any
      )) as any
      await appendAgentEvent(this.agentSessionId, 'turn_end', { stopReason: response?.stopReason, usage: response?.usage })
      await updateAgentSession(this.agentSessionId, {
        status: 'idle',
        touch: true,
        summary: this.textBuffer.trim().slice(-1200) || undefined
      })
      return { stopReason: response?.stopReason ?? 'end_turn' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendAgentEvent(this.agentSessionId, 'error', { message })
      await updateAgentSession(this.agentSessionId, { status: 'error', lastError: message, touch: true })
      throw error
    } finally {
      this.turn = null
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.acpSessionId) return
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.acpSessionId
    } as any)
    for (const waiter of this.waiters.values()) waiter.resolve(null)
    this.waiters.clear()
    this.turn?.cancel()
    await appendAgentEvent(this.agentSessionId, 'cancelled', {})
    await updateAgentSession(this.agentSessionId, { status: 'idle', touch: true })
  }

  async setMode(modeId: string): Promise<void> {
    await this.ensureStarted()
    if (!this.connection || !this.acpSessionId) return
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.acpSessionId,
      modeId
    } as any)
    await updateAgentSession(this.agentSessionId, { modeId })
    await appendAgentEvent(this.agentSessionId, 'mode_changed', { modeId })
  }

  stop(): void {
    for (const waiter of this.waiters.values()) waiter.resolve(null)
    this.waiters.clear()
    this.connection?.close()
    this.connection = null
    if (this.containerName && this.containerPidFile) {
      const killer = spawn('docker', [
        'exec', this.containerName,
        'sh', '-c', 'test ! -f "$1" || kill "$(cat "$1")"; rm -f "$1"',
        'sh', this.containerPidFile
      ], { stdio: 'ignore' })
      killer.unref()
    }
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.acpSessionId = null
    this.booting = null
    this.containerName = null
    this.containerPidFile = null
  }
}

/* ------------------------------------------------------------------ */
/* manager                                                             */
/* ------------------------------------------------------------------ */

function meshServerEntry(): string {
  return process.env.NUXT_DOMO_MCP_ENTRY || resolve(process.cwd(), 'server/mcp/agent-mesh.mjs')
}

function internalBaseUrl(fromContainer = false): string {
  if (process.env.NUXT_INTERNAL_URL) return process.env.NUXT_INTERNAL_URL
  const host = fromContainer ? 'host.docker.internal' : '127.0.0.1'
  return `http://${host}:${process.env.PORT || process.env.NITRO_PORT || 3000}`
}

class AcpManager {
  private runtimes = new Map<string, AgentRuntime>()

  private runtime(agentSessionId: string): AgentRuntime {
    let runtime = this.runtimes.get(agentSessionId)
    if (!runtime) {
      runtime = new AgentRuntime(agentSessionId)
      this.runtimes.set(agentSessionId, runtime)
    }
    return runtime
  }

  async create(input: {
    adapter?: AgentAdapter
    title?: string
    cwd?: string
    voiceSessionId?: string | null
    modeId?: string | null
    devEnvironmentId?: string | null
    initialPrompt?: string
  }): Promise<AgentSession> {
    const settings = await getSettings()
    const environment = input.devEnvironmentId
      ? await ensureEnvironmentRunning(input.devEnvironmentId)
      : null
    const cwd = environment?.workspacePath ?? normalizeCwd(input.cwd || settings.defaultCwd)
    const title = (input.title || input.initialPrompt || 'Coding session').trim().split('\n')[0]!.slice(0, 80)
    const session = await createAgentSession({
      adapter: input.adapter ?? 'claude-code',
      title,
      cwd,
      voiceSessionId: input.voiceSessionId ?? null,
      modeId: input.modeId ?? settings.defaultAgentMode,
      devEnvironmentId: environment?.id ?? null
    })
    // A failed boot is recorded on the session row (status + lastError) so the
    // UI can show it and offer a retry instead of blowing up the request.
    const started = await this.runtime(session.id)
      .ensureStarted()
      .then(() => true)
      .catch(() => false)

    if (started && input.initialPrompt) {
      void this.promptInBackground(session.id, [{ type: 'text', text: input.initialPrompt }])
    }
    return (await getAgentSession(session.id))!
  }

  async start(agentSessionId: string): Promise<void> {
    await this.runtime(agentSessionId).ensureStarted()
  }

  /** Fire-and-forget turn: the UI and the voice agent follow it through events. */
  async promptInBackground(agentSessionId: string, content: any[]): Promise<void> {
    const runtime = this.runtime(agentSessionId)
    try {
      await runtime.prompt(content)
    } catch (error) {
      console.error(`[acp:${agentSessionId}] turn failed`, error)
    }
  }

  async prompt(agentSessionId: string, content: any[]) {
    return this.runtime(agentSessionId).prompt(content)
  }

  async cancel(agentSessionId: string) {
    await this.runtime(agentSessionId).cancel()
  }

  async setMode(agentSessionId: string, modeId: string) {
    await this.runtime(agentSessionId).setMode(modeId)
  }

  async answerPermission(
    agentSessionId: string,
    permissionId: string,
    optionId: string | null,
    by: PendingPermission['resolvedBy']
  ): Promise<boolean> {
    const runtime = this.runtimes.get(agentSessionId)
    const answered = runtime?.answerPermission(permissionId, optionId) ?? false
    await resolvePermissionRow(permissionId, optionId, by)
    return answered
  }

  stop(agentSessionId: string) {
    this.runtimes.get(agentSessionId)?.stop()
    this.runtimes.delete(agentSessionId)
  }

  isRunning(agentSessionId: string) {
    return this.runtimes.get(agentSessionId)?.alive ?? false
  }

  async shutdown() {
    for (const id of [...this.runtimes.keys()]) this.stop(id)
    const sessions = await listAgentSessions()
    for (const session of sessions) {
      if (session.status !== 'stopped') {
        await updateAgentSession(session.id, { status: 'stopped' }).catch(() => {})
      }
    }
  }
}

export function normalizeCwd(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return process.cwd()
  const expanded = trimmed.startsWith('~')
    ? join(process.env.HOME || process.cwd(), trimmed.slice(1))
    : trimmed
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

const globalKey = '__domo_acp_manager__'
const g = globalThis as any
export const acpManager: AcpManager = g[globalKey] ?? (g[globalKey] = new AcpManager())

// Keep the UI honest about stale statuses after a dev-server reload.
bus.setMaxListeners(0)

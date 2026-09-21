import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { bus } from '../bus'
import { adapterCommandPath } from '../dev-env/runtime-volume'
import {
  containerExecArgs,
  ensureEnvironmentRunning,
  readEnvironmentFile,
  writeEnvironmentFile
} from '../dev-environments'
import { internalBaseUrl } from '../internal-url'
import { mintMeshToken } from '../mesh/token'
import { normalizeCwd } from '../paths'
import { getSettings } from '../settings'
import { adapterEntry, adapterEnv } from './adapter-process'
import { availableModelIds, currentModel, modelConfigOption, pinnedModel, resolveModel } from './model'
import {
  appendAgentEvent,
  createAgentSession,
  createPermission,
  getAgentSession,
  listAgentSessions,
  listMcpServers,
  openAgentStream,
  resolvePermissionRow,
  updateAgentSession,
  writeAgentStream
} from '../repo'
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentStreamType,
  AppSettings,
  DevEnvironment,
  PendingPermission
} from '../../../shared/types'

interface PendingPermissionWaiter {
  permission: PendingPermission
  resolve: (optionId: string | null) => void
}

/** A run of streaming text that is being coalesced into one `agent_events` row. */
interface StreamBlock {
  type: AgentStreamType
  /** Everything received so far. */
  text: string
  /** What the row already holds, so an idle flush writes nothing. */
  written: string
  /** The insert that claimed the row's `seq`; every write waits on it. */
  row: Promise<AgentEvent>
  timer: ReturnType<typeof setTimeout> | null
}

const FLUSH_MS = 150
/** Past this, a flush costs more than it buys; see `flushDelay`. */
const FLUSH_SOFT_LIMIT = 4096
const FLUSH_MAX_MS = 2000

/**
 * How long to wait before writing the deltas received so far.
 *
 * Every write re-streams the whole row to the browser (Electric, plus
 * `REPLICA IDENTITY FULL`), so a fixed interval costs O(length^2 / interval)
 * bytes over a block: fine for the couple of kilobytes a message usually is,
 * wasteful for a long one. The interval therefore grows with the block once it
 * is past a few kilobytes, which caps the total at a few times its final size.
 */
function flushDelay(length: number): number {
  return Math.min(FLUSH_MAX_MS, Math.max(FLUSH_MS, Math.round((FLUSH_MS * length) / FLUSH_SOFT_LIMIT)))
}

/**
 * How often a working agent refreshes `last_activity_at`.
 *
 * It is not decoration: `list_agent_sessions` reports it to the voice agent,
 * which is told to pick "the most recently active agent" for a vague
 * instruction. Left to status transitions alone, an agent streaming for twenty
 * minutes would look like the stalest one in the list and Domo would hand the
 * user's "keep going" to the wrong session.
 */
const ACTIVITY_TOUCH_MS = 30_000

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
  /** Everything the agent said this turn, which becomes the session summary. */
  private textBuffer = ''
  /** The block of streaming text currently being coalesced, if any. */
  private stream: StreamBlock | null = null
  /**
   * The status we last wrote. Deltas arrive many times a second and all of them
   * mean "thinking"; without this every one of them cost a session UPDATE (and
   * an Electric round trip) that changed nothing.
   */
  private status: AgentSessionStatus | null = null
  /** When `last_activity_at` was last written; see `ACTIVITY_TOUCH_MS`. */
  private touchedAt = 0
  /**
   * The ACP SDK dispatches notifications without awaiting the previous handler,
   * so concurrent inserts would take `seq` values out of arrival order and
   * scramble streamed text. Every event write goes through this chain.
   */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(agentSessionId: string) {
    this.agentSessionId = agentSessionId
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn)
    this.writes = run.catch(() => {})
    return run
  }

  /**
   * Write the session status, but only when it actually changes. `touch` still
   * always writes: refreshing `last_activity_at` is the point of asking.
   */
  private async setStatus(
    status: AgentSessionStatus,
    patch: { touch?: boolean, lastError?: string | null, summary?: string } = {}
  ): Promise<void> {
    if (this.status === status && !patch.touch && patch.lastError === undefined && patch.summary === undefined) return
    this.status = status
    if (patch.touch) this.touchedAt = Date.now()
    await updateAgentSession(this.agentSessionId, { status, ...patch })
  }

  /**
   * Say the agent is still working, at most once every `ACTIVITY_TOUCH_MS`.
   *
   * Called from the flush timer and from the events that punctuate a turn, so
   * the write rate is bounded by the clock and never by the delta rate.
   */
  private async touchIfStale(): Promise<void> {
    if (Date.now() - this.touchedAt < ACTIVITY_TOUCH_MS) return
    this.touchedAt = Date.now()
    await updateAgentSession(this.agentSessionId, { touch: true })
  }

  /* ---------------- streaming text ---------------- */

  /**
   * Take the open block away from the runtime, synchronously, so that a delta
   * arriving right after cannot reopen or double-close it. The caller closes it
   * inside `serial`, which is what keeps `seq` in arrival order.
   */
  private takeStream(): StreamBlock | null {
    const block = this.stream
    this.stream = null
    if (block?.timer) {
      clearTimeout(block.timer)
      block.timer = null
    }
    return block
  }

  /**
   * Write a block's final text and drop its `streaming` flag. Runs in `serial`,
   * ahead of whatever event ended the block — which is why a failure here only
   * loses the text, and never the event that follows it.
   */
  private async closeStream(block: StreamBlock | null): Promise<void> {
    if (!block) return
    try {
      const row = await block.row
      await writeAgentStream(row.id, block.text, false)
      block.written = block.text
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not finish streamed text`, error)
    }
  }

  /** Fold a delta into the open block, opening one when the run starts. */
  private appendStream(type: AgentStreamType, text: string): void {
    const open = this.stream
    if (open && open.type === type) {
      open.text += text
      this.scheduleFlush(open)
      return
    }

    const previous = this.takeStream()
    const block: StreamBlock = { type, text, written: text, row: null!, timer: null }
    this.stream = block
    // One serial step: the previous block is finished before the next one takes
    // its `seq`, so two runs can never end up in the wrong order.
    block.row = this.serial(async () => {
      await this.closeStream(previous)
      return openAgentStream(this.agentSessionId, type, text)
    })
    block.row.catch(() => {})
  }

  private scheduleFlush(block: StreamBlock): void {
    if (block.timer) return
    const timer = setTimeout(() => {
      block.timer = null
      void this.flushStream(block)
    }, flushDelay(block.text.length))
    // A pending flush must not keep Node alive on its own.
    timer.unref?.()
    block.timer = timer
  }

  private async flushStream(block: StreamBlock): Promise<void> {
    if (block.written === block.text) return
    const text = block.text
    try {
      await this.serial(async () => {
        const row = await block.row
        await writeAgentStream(row.id, text, true)
        await this.touchIfStale()
      })
      block.written = text
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not flush streamed text`, error)
    }
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
        await this.setStatus('error', { lastError: message })
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        throw error
      })
    }
    return this.booting
  }

  private async boot(): Promise<void> {
    const session = await getAgentSession(this.agentSessionId)
    if (!session) throw new Error(`Agent session ${this.agentSessionId} not found`)

    await this.setStatus('starting', { lastError: null })

    let environment: DevEnvironment | null = null
    const env = await adapterEnv(session.adapter, !!session.devEnvironmentId)
    let proc: ChildProcessWithoutNullStreams
    if (session.devEnvironmentId) {
      environment = await ensureEnvironmentRunning(session.devEnvironmentId)
      this.containerName = environment.containerName
      this.containerPidFile = `/tmp/domo-agent-${this.agentSessionId}.pid`
      env.USER = environment.remoteUser ?? 'root'
      env.HOME = env.USER === 'root' ? '/root' : `/home/${env.USER}`
      env.LOGNAME = env.USER
      proc = spawn('docker', [
        ...containerExecArgs(environment, env),
        // The adapters live in the shared runtime volume at /opt/domo, not on the image's PATH.
        'sh', '-c', 'echo $$ > "$1"; exec "$2"', 'sh', this.containerPidFile, adapterCommandPath(session.adapter)
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
      const block = this.takeStream()
      void this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'adapter-exit', { code, signal })
        await this.setStatus('stopped')
      }).catch(() => {})
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

    const initialized = (await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true }
      },
      clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
    } as any)) as any

    // The mesh is an HTTP MCP server now; an adapter that cannot speak that
    // transport gets no mesh rather than a server it would fail to connect to.
    const httpMcp = !!initialized?.agentCapabilities?.mcpCapabilities?.http
    if (!httpMcp) warnNoHttpMcp(session.adapter)

    const mcpServers = await this.mcpServersForSession(environment, httpMcp)
    const settings = await getSettings()

    let sessionResponse: any = null
    if (session.acpSessionId) {
      try {
        sessionResponse = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: session.acpSessionId,
          cwd: session.cwd,
          mcpServers
        } as any)
        this.acpSessionId = session.acpSessionId
      } catch (error) {
        console.error(`[acp:${this.agentSessionId}] load failed, starting fresh`, error)
      }
    }

    let fresh = false
    const patch: { acpSessionId?: string, modes?: any, modeId?: string } = {}
    if (!this.acpSessionId) {
      const created = (await connection.agent.request(acp.methods.agent.session.new, {
        cwd: session.cwd,
        mcpServers
      } as any)) as any
      sessionResponse = created
      fresh = true
      this.acpSessionId = created.sessionId
      patch.acpSessionId = created.sessionId
    }

    Object.assign(patch, await this.applySessionMode({ session, response: sessionResponse, settings, fresh }))
    // One write, not one per thing learned: `agent_sessions` is synced, so each
    // one re-streams the whole row to every browser.
    if (Object.keys(patch).length) await updateAgentSession(this.agentSessionId, patch)

    await this.applyRequestedModel(session, sessionResponse)
    await this.setStatus('idle', { touch: true })
  }

  /**
   * Put the adapter in the mode the row asks for, and record which one it is in.
   *
   * `session/load` restores the *adapter's* transcript, not Domo's choices. It
   * comes back in whatever mode it defaults to — for Claude Code that means
   * asking for permissions again, however the session was set up — so the mode
   * has to be re-applied from the row on every attach, exactly as the model is
   * (`applyRequestedModel`). Under `pnpm dev` this is not a rare path: every
   * edit to `server/` restarts Nitro and reattaches every session.
   *
   * The row is the authority on what was *asked for* and the adapter on what
   * *is*, so what it answers with is what gets recorded. Returns the columns to
   * write rather than writing them, so a start is one row update.
   *
   * Nothing here appends a `mode_changed` event. That event means "somebody
   * changed the mode": the user or the voice agent through `setMode`, or the
   * agent itself through a `current_mode_update`, which is its own event. A
   * start is neither, and a line per restart would bury the turn it sits in.
   */
  private async applySessionMode(input: {
    session: AgentSession
    response: any
    settings: AppSettings
    /** A `session/new` response is authoritative about modes; a `session/load` may say nothing at all. */
    fresh: boolean
  }): Promise<{ modes?: any, modeId?: string }> {
    const { session, settings } = input
    const state = input.response?.modes ?? null
    const available = state
      ? (state.availableModes ?? []).map((mode: any) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? null
        }))
      : null
    const reported: string | null = state?.currentModeId ?? null
    const desired = session.modeId || settings.defaultAgentMode
    // A `session/load` may answer with no mode state even for an adapter that
    // has modes, so the row's own list is the other half of the question.
    const hasModes = !!state || !!session.modes?.length
    let effective = reported ?? session.modeId ?? settings.defaultAgentMode

    if (desired && hasModes && desired !== reported) {
      try {
        await this.connection!.agent.request(acp.methods.agent.session.setMode, {
          sessionId: this.acpSessionId,
          modeId: desired
        } as any)
        effective = desired
      } catch (error) {
        // A mode that will not take is not a reason to fail the start: the
        // session still works, it just asks more often than it was told to.
        console.error(`[acp:${this.agentSessionId}] could not set mode ${desired}`, error)
      }
    }

    const patch: { modes?: any, modeId?: string } = {}
    if (available || input.fresh) patch.modes = available
    if (effective && effective !== session.modeId) patch.modeId = effective
    return patch
  }

  /**
   * Put the session on the model it asked for, and record which one it ended up
   * on either way.
   *
   * The model is per session — two agents may be on different ones at the same
   * time — so the row is what is consulted; `NUXT_CLAUDE_MODEL` /
   * `NUXT_CODEX_MODEL` are only the install-wide default for a row that names
   * none. Both adapters expose the choice as an ACP `configOptions` select in
   * the category `model` and take `session/set_config_option`, so there is one
   * mechanism rather than one per adapter.
   *
   * What the adapter says it landed on is written back, so the row is a record
   * of the truth rather than of the request.
   */
  private async applyRequestedModel(session: AgentSession, sessionResponse: any): Promise<void> {
    const option = modelConfigOption(sessionResponse)
    if (!option) return

    const preference = session.model || pinnedModel(session.adapter)
    let chosen = currentModel(option)

    if (preference) {
      const wanted = resolveModel(option, preference)
      if (!wanted) {
        throw new Error(
          `The ${session.adapter} adapter does not offer a model matching "${preference}". `
          + `It offers: ${availableModelIds(option).join(', ') || '(none)'}.`
        )
      }
      if (wanted.value !== chosen?.value) {
        const response = (await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.acpSessionId,
          configId: wanted.configId,
          value: wanted.value
        } as any)) as any
        // The adapter answers with the full set of options; believe it about
        // what actually took, rather than what was asked for.
        chosen = currentModel(modelConfigOption(response)) ?? wanted
      } else {
        chosen = wanted
      }
    }

    if (chosen) {
      if (chosen.value !== session.model) {
        await updateAgentSession(this.agentSessionId, { model: chosen.value })
      }
      await appendAgentEvent(this.agentSessionId, 'model_changed', {
        modelId: chosen.value,
        name: chosen.name,
        requested: preference ?? null
      })
    }
  }

  private async mcpServersForSession(environment: DevEnvironment | null, httpMcp: boolean) {
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
    // The agent-mesh server lets coding agents talk to each other and spawn
    // peers. One code path for host and container sessions: the container only
    // differs in which host name reaches Domo.
    if (httpMcp) {
      out.push({
        name: 'domo',
        type: 'http',
        url: `${internalBaseUrl(!!environment)}/api/internal/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${mintMeshToken(this.agentSessionId)}` }]
      })
    }
    return out
  }

  /* ---------------- session updates ---------------- */

  private async onUpdate(params: any) {
    const update = params?.update
    if (!update) return
    const kind: string = update.sessionUpdate

    const streamType: AgentStreamType | null
      = kind === 'agent_message_chunk'
        ? 'agent_message'
        : kind === 'agent_thought_chunk' ? 'agent_thought' : null

    if (streamType) {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
      if (!text) return
      if (streamType === 'agent_message') this.textBuffer += text
      this.appendStream(streamType, text)
      await this.setStatus('thinking')
      return
    }

    // Detached here, before anything awaits: the block's row has to exist with a
    // lower `seq` than this event, or the transcript would show the text that
    // preceded a tool call after it.
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, kind, update)
      if (kind === 'tool_call') await this.setStatus('thinking')
      // The agent may switch its own mode mid-turn, and the row is what gets
      // re-applied on the next attach — so it has to follow, not just the log.
      if (kind === 'current_mode_update' && update.currentModeId) {
        await updateAgentSession(this.agentSessionId, { modeId: update.currentModeId })
      }
      // A turn that is all tool calls and no text is still a working agent.
      await this.touchIfStale()
    })
  }

  private async onPermission(params: any): Promise<any> {
    const settings = await getSettings()
    const options = (params.options ?? []).map((option: any) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind
    }))
    const title: string = params.toolCall?.title || params.toolCall?.rawInput?.description || 'Tool call'

    const block = this.takeStream()
    const permission = await this.serial(async () => {
      await this.closeStream(block)
      const row = await createPermission({
        agentSessionId: this.agentSessionId,
        toolCallId: params.toolCall?.toolCallId ?? null,
        title,
        options,
        toolCall: params.toolCall ?? null
      })
      await appendAgentEvent(this.agentSessionId, 'permission_request', { permissionId: row.id, ...params })
      await this.setStatus('awaiting-permission', { touch: true })
      return row
    })

    if (settings.autoApprovePermissions) {
      const auto =
        options.find((o: any) => o.kind === 'allow_once') ?? options.find((o: any) => o.kind === 'allow_always')
      if (auto) {
        await resolvePermissionRow(permission.id, auto.optionId, 'auto')
        await this.setStatus('thinking')
        return { outcome: { outcome: 'selected', optionId: auto.optionId } }
      }
    }

    const optionId = await new Promise<string | null>((resolvePromise) => {
      this.waiters.set(permission.id, { permission, resolve: resolvePromise })
    })
    this.waiters.delete(permission.id)

    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    await this.setStatus('thinking')
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
    const stale = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(stale)
      await appendAgentEvent(this.agentSessionId, 'user_message', { content })
      await this.setStatus('thinking', { touch: true })
    })

    const controller = new AbortController()
    this.turn = { cancel: () => controller.abort() }

    try {
      const response = (await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.acpSessionId, prompt: content } as any,
        { signal: controller.signal } as any
      )) as any
      // Queued behind any text writes still in flight, so the turn closes last.
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'turn_end', { stopReason: response?.stopReason, usage: response?.usage })
        await this.setStatus('idle', {
          touch: true,
          summary: this.textBuffer.trim().slice(-1200) || undefined
        })
      })
      return { stopReason: response?.stopReason ?? 'end_turn' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        await this.setStatus('error', { lastError: message, touch: true })
      })
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
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, 'cancelled', {})
      await this.setStatus('idle', { touch: true })
    })
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
    // A block left open would render as text that streams forever.
    const block = this.takeStream()
    void this.serial(() => this.closeStream(block)).catch(() => {})
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

const warnedNoHttpMcp = new Set<AgentAdapter>()

/** Said once per adapter: a storm of this would drown the adapter's own output. */
function warnNoHttpMcp(adapter: AgentAdapter): void {
  if (warnedNoHttpMcp.has(adapter)) return
  warnedNoHttpMcp.add(adapter)
  console.warn(
    `[acp] the ${adapter} adapter does not advertise HTTP MCP support `
    + '(agentCapabilities.mcpCapabilities.http), so its sessions get no agent mesh: '
    + 'they cannot list, message or spawn peers, or page the voice supervisor. '
    + 'Upgrade the adapter to restore it.'
  )
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
    /** Model id for *this* session; omitted means the install default, then the adapter's. */
    model?: string | null
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
      model: input.model?.trim() || null,
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

export { normalizeCwd }

const globalKey = '__domo_acp_manager__'
const g = globalThis as any
export const acpManager: AcpManager = g[globalKey] ?? (g[globalKey] = new AcpManager())

// Keep the UI honest about stale statuses after a dev-server reload.
bus.setMaxListeners(0)

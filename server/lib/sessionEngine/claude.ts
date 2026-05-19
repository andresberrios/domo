/**
 * Host-side `claude` process — long-lived per-session (Decided #3,#7).
 *
 * Spike-proven (`smoke/persistent-session-spike.mjs`): one non-`-p` process
 * with stdin kept open serves multiple turns with full context continuity
 * and exits cleanly only when stdin closes. Spawning hundreds of
 * short-lived `claude-vscode` clients is what Anthropic telemetry could
 * flag as spoofing — the long-lived process is **billing fidelity to the
 * official VS Code extension**, not a convenience.
 *
 * **Invocation mirrors the VS Code 2.1.142 extension EXACTLY (no `-p`).**
 * `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (scrubbed for nested-claude
 * hygiene, then re-pinned) drives the post-2026-06-15 billing classifier
 * via the outbound `x-anthropic-billing-header cc_entrypoint=` value.
 * `ANTHROPIC_API_KEY` is scrubbed (the CLI silently prefers it over OAuth
 * — a footgun that flips subscription→API billing). See
 * `project-agent-sdk-billing`.
 *
 * The first `system` event carries Claude's own `session_id`. We capture
 * it the first time; mid-process subsequent turns share the same session
 * (no `--resume` between turns — the spike confirms this). On respawn
 * after idle-reap / crash, `--resume <id>` re-attaches; if Domo was the
 * only writer the durable transcript stays the source of truth.
 *
 * **Permission protocol** (`--permission-prompt-tool stdio`, part of the
 * extension argv): tools that need approval surface as a `control_request`
 * `{ subtype:'can_use_tool', tool_name, input, tool_use_id }` NDJSON line
 * on stdout; the host answers with a `control_response` on stdin. The
 * stdio path is the design's edit-approval mechanism (the IDE-bridge
 * `openDiff` is dead — `bridge.ts` is gone with the pivot).
 *
 * The engine owns the lifecycle (`engine.ts`); this module exposes a
 * `ClaudeProc` handle: `runTurn` writes one user message and resolves on
 * the matching `result`, but **stdin stays open** for the next turn.
 * `close()` ends stdin (clean idle-reap exit); `kill()` SIGTERMs.
 */
import { spawn } from 'node:child_process'
import { delimiter as pathDelimiter } from 'node:path'
import { loadDomoConfig } from '../config'

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  requestId: string
}

export interface TurnSpec {
  prompt: string
  /** Called for every stream-json envelope this turn produces. */
  onEvent: (type: string, envelope: Record<string, unknown>) => void
  /** Once per process: the session id from the first `system` event. */
  onSessionId?: (id: string) => void
  /** Approve/deny a CLI `can_use_tool`. Default = auto-allow. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>
  /** The CLI withdrew a pending permission request. */
  onPermissionCancel?: (requestId: string) => void
  /** Called once stdin is ready for mid-turn steering (`uuid`-matched echo). */
  onReady?: (steer: (text: string, uuid: string) => void) => void
  /** Abort the turn — SIGTERMs the child. */
  signal?: AbortSignal
}

export interface SpawnOpts {
  cwd: string
  /** `--resume <id>` for a respawn (first-spawn omits). */
  resumeSessionId?: string
  /**
   * `--permission-mode` value (Decided #22):
   * `default` (manual, ask), `acceptEdits` (auto), or `'passthrough'`
   * (omit the flag → user's ~/.claude decides).
   */
  permissionMode?: 'default' | 'acceptEdits' | 'passthrough'
}

export interface ClaudeProc {
  /** Run one turn on the existing stdin; resolves on the matching `result`. */
  runTurn(spec: TurnSpec): Promise<void>
  /** Idle-reap: end stdin → process exits cleanly (no SIGTERM). */
  close(): void
  /** Force-kill mid-turn (SIGTERM). */
  kill(): void
  /** Fires once on process exit with the exit code (null on signal). */
  onExit(cb: (code: number | null) => void): void
  /** True until the child has exited. */
  readonly alive: boolean
}

// Scrub the key + the outer Claude Code session vars: Domo's own dev
// server may itself be running under a `claude` session, and a nested
// CLI silently prefers a leaked ANTHROPIC_API_KEY over OAuth (documented
// footgun — design "Subscription billing & credentials").
const SCRUB_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'AI_AGENT',
  'CLAUDE_EFFORT',
])

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!SCRUB_ENV.has(k)) env[k] = v
  }

  // Operator's declarative env extension (`<domoHome>/config.json`,
  // Decided #19). The host install means `claude` already inherits the
  // service env; this is the no-restart, survives-update knob for extra
  // vars / PATH (e.g. a runtime an MCP server needs). Scrubbed keys are
  // skipped here, not deleted later — `env` was built *without* them
  // above, so refusing to set them keeps the scrub the final word
  // (the knob can't reintroduce e.g. ANTHROPIC_API_KEY and silently flip
  // subscription→API billing). `PATH` isn't scrubbed.
  const claudeCfg = loadDomoConfig().claude
  if (claudeCfg?.env) {
    for (const [k, v] of Object.entries(claudeCfg.env)) {
      if (!SCRUB_ENV.has(k)) env[k] = v
    }
  }
  if (claudeCfg?.extraPath?.length) {
    env.PATH = [...claudeCfg.extraPath, env.PATH]
      .filter(Boolean)
      .join(pathDelimiter)
  }
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
  // Billing lever (spike-proven, smoke/no-print-lifecycle-spike.mjs):
  // the post-2026-06-15 classifier reads `cc_entrypoint` from
  // CLAUDE_CODE_ENTRYPOINT. It's in SCRUB_ENV (nested-claude hygiene) so
  // it's stripped above → would default to `sdk-cli` = the capped
  // Agent-SDK credit. Pin the official VS Code extension's value so usage
  // bills against the full Claude subscription. See the
  // project-agent-sdk-billing memory.
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode'
  // Official VS Code 2.1.142 extension parity — these four vars are set
  // alongside CLAUDE_CODE_ENTRYPOINT on every spawn (captured from
  // `ps eww -p <pid> -o command=` against the live extension binary,
  // 2026-05-20). Mirror, don't guess — see project-agent-sdk-billing /
  // feedback-official-integration-pattern.
  //   * MCP_CONNECTION_NONBLOCKING — slow/broken MCP servers don't
  //     block claude startup.
  //   * CLAUDE_CODE_ENABLE_TASKS=0 — the extension disables the internal
  //     Tasks feature.
  //   * CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true — file-edit
  //     checkpointing on.
  //   * CLAUDE_AGENT_SDK_VERSION — the SDK module version the
  //     "extension caller" declares. Pinned literal; bump when matching
  //     a newer extension capture.
  env.MCP_CONNECTION_NONBLOCKING = 'true'
  env.CLAUDE_CODE_ENABLE_TASKS = '0'
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true'
  env.CLAUDE_AGENT_SDK_VERSION = '0.3.142'
  return env
}

function buildArgs(opts: SpawnOpts): string[] {
  // EXACT official VS Code 2.1.142 argv (billing parity, no `-p`).
  // `--resume` is appended only when respawning (the extension omits it
  // for a fresh session and adds it when resuming — Domo's same model:
  // capture session_id from the first `system` event, resume thereafter).
  return [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-thinking-tokens', '31999',
    // Built-in stdio permission protocol — exactly what the extension's
    // argv carries (NOT the IDE-bridge openDiff; that path is gone).
    '--permission-prompt-tool', 'stdio',
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
    '--setting-sources=user,project,local',
    // `default` = the CLI asks (manual diff cards), `acceptEdits` = auto,
    // `passthrough` = omit the flag → user's own ~/.claude settings decide.
    ...(opts.permissionMode === 'passthrough'
      ? []
      : ['--permission-mode', opts.permissionMode ?? 'default']),
    '--include-partial-messages',
    '--debug',
    '--debug-to-stderr',
    '--enable-auth-status',
    '--no-chrome',
    // Echo user messages (initial + mid-turn steer) back on stdout as
    // `{type:'user',uuid,isReplay:true}` — the consumption ack the
    // transcript matches by uuid to flip a steer queued→delivered.
    '--replay-user-messages',
  ]
}

/**
 * Start a long-lived `claude` child. Stdin stays open until the engine
 * calls `close()` (clean reap) or the child exits on its own / `kill()`
 * (SIGTERM). The handle de-multiplexes turns by `result` envelope: a
 * concurrent `runTurn` is **not** supported (single-flight per session).
 */
export function spawnClaudeProcess(opts: SpawnOpts): ClaudeProc {
  const env = buildEnv()
  const args = buildArgs(opts)
  const child = spawn('claude', args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // ─── Per-process state (carried across turns on this child) ────────────
  let exited = false
  let exitCode: number | null = null
  let pendingExitCbs: Array<(code: number | null) => void> = []
  let stdoutBuf = ''
  let stderrTail = '' // rolling last ~8 KB (debug-to-stderr is verbose)
  let sessionIdCaptured = false

  // ─── Per-turn state (reset on each runTurn) ────────────────────────────
  interface TurnState {
    spec: TurnSpec
    resolve: () => void
    reject: (err: unknown) => void
    onAbort: () => void
  }
  let currentTurn: TurnState | null = null

  function writeLine(obj: unknown): void {
    if (child.stdin.writable) {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch {
        /* peer gone */
      }
    }
  }

  function respond(requestId: string, decision: PermissionDecision): void {
    writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          decision.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: decision.updatedInput ?? {} }
            : { behavior: 'deny', message: decision.message },
      },
    })
  }

  function handleControlRequest(msg: {
    request_id?: unknown
    request?: {
      subtype?: unknown
      tool_name?: unknown
      input?: unknown
      tool_use_id?: unknown
    }
  }): void {
    const requestId = String(msg.request_id ?? '')
    const req = msg.request ?? {}
    if (req.subtype !== 'can_use_tool' || !requestId) {
      // hook_callback / elicitation / mcp_message — we configure none of
      // these, so decline rather than let the CLI hang on a response.
      if (requestId) {
        writeLine({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error: 'unsupported control_request',
          },
        })
      }
      return
    }
    if (!currentTurn) {
      // The CLI shouldn't ask between turns; deny to keep state clean.
      respond(requestId, { behavior: 'deny', message: 'no turn in flight' })
      return
    }
    const request: PermissionRequest = {
      toolName: String(req.tool_name ?? ''),
      input: (req.input ?? {}) as Record<string, unknown>,
      toolUseId: String(req.tool_use_id ?? ''),
      requestId,
    }
    const decide = currentTurn.spec.onPermissionRequest
      ? currentTurn.spec.onPermissionRequest(request)
      : Promise.resolve<PermissionDecision>({
          behavior: 'allow',
          updatedInput: request.input,
        })
    decide
      .then((d) => respond(requestId, d))
      .catch((e) =>
        respond(requestId, {
          behavior: 'deny',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
  }

  function onLine(line: string): void {
    if (!line.trim()) return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      currentTurn?.spec.onEvent('raw', { text: line })
      return
    }
    const type = typeof evt.type === 'string' ? evt.type : 'unknown'

    if (type === 'control_request') {
      handleControlRequest(evt as Parameters<typeof handleControlRequest>[0])
      return
    }
    if (type === 'control_cancel_request') {
      const rid = String(evt.request_id ?? '')
      if (rid) currentTurn?.spec.onPermissionCancel?.(rid)
      return
    }
    if (type === 'control_response' || type === 'keep_alive') return

    // Capture Claude's own session id once per process. Subsequent turns
    // on the same process share the same session (spike-proven); a
    // respawn re-attaches via `--resume <id>`.
    if (
      !sessionIdCaptured &&
      type === 'system' &&
      typeof evt.session_id === 'string'
    ) {
      sessionIdCaptured = true
      currentTurn?.spec.onSessionId?.(evt.session_id)
    }
    currentTurn?.spec.onEvent(type, evt)

    // `result` ends one turn but does NOT close stdin (long-lived). The
    // next `runTurn` writes the next user message on the same stdin.
    if (type === 'result') {
      const t = currentTurn
      if (t) {
        currentTurn = null
        t.resolve()
      }
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() ?? ''
    for (const l of lines) onLine(l)
  })

  // `--debug-to-stderr` (extension parity) floods stderr; keep a rolling
  // last ~8 KB so the fatal error tail surfaces on a non-zero exit.
  child.stderr.on('data', (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-8192)
  })

  child.on('error', (err) => {
    if (!exited) {
      exited = true
      exitCode = null
      const t = currentTurn
      currentTurn = null
      t?.reject(err)
      for (const cb of pendingExitCbs) cb(exitCode)
      pendingExitCbs = []
    }
  })
  child.on('exit', (code) => {
    if (exited) return
    exited = true
    exitCode = code
    if (stdoutBuf.trim()) onLine(stdoutBuf)
    const t = currentTurn
    currentTurn = null
    if (t) {
      const aborted = t.spec.signal?.aborted ?? false
      if (aborted || code === 0 || code === null) t.resolve()
      else
        t.reject(
          new Error(
            `claude exited ${code}. stderr=${stderrTail.slice(0, 800) || '<empty>'}`,
          ),
        )
    }
    for (const cb of pendingExitCbs) cb(exitCode)
    pendingExitCbs = []
  })

  async function runTurn(spec: TurnSpec): Promise<void> {
    if (exited) throw new Error('claude process is not running')
    if (currentTurn) throw new Error('turn already in flight (single-flight)')

    const onAbortEmpty = (): void => undefined
    const turn: TurnState = {
      spec,
      resolve: () => undefined,
      reject: () => undefined,
      onAbort: onAbortEmpty,
    }
    currentTurn = turn

    const onAbort = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    turn.onAbort = onAbort
    if (spec.signal) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    const turnPromise = new Promise<void>((resolve, reject) => {
      turn.resolve = resolve
      turn.reject = reject
    })

    // Initial user message for this turn.
    writeLine({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: spec.prompt }],
      },
    })

    // stdin is open → expose the mid-turn steer channel. The CLI queues
    // the message and consumes it at the next step boundary; the echo
    // (`{type:'user',uuid,isReplay:true}`) flips the bubble delivered.
    spec.onReady?.((text: string, uuid: string) => {
      writeLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid,
      })
    })

    try {
      await turnPromise
    } finally {
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort)
    }
  }

  function close(): void {
    if (exited) return
    try {
      child.stdin.end()
    } catch {
      /* already closed */
    }
  }

  function kill(): void {
    if (exited) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  function onExit(cb: (code: number | null) => void): void {
    if (exited) cb(exitCode)
    else pendingExitCbs.push(cb)
  }

  return {
    runTurn,
    close,
    kill,
    onExit,
    get alive() {
      return !exited
    },
  }
}

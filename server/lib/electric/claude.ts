import { spawn } from 'node:child_process'

/**
 * Host-side `claude` one-turn runner (Option A — design Decided #11).
 *
 * stdout `stream-json` is the runtime event source (design Decided #7):
 * one NDJSON envelope per line — `system` (init; carries `session_id`),
 * `assistant` (text / tool_use), `user` (tool_result), `result` (final).
 *
 * **Permission protocol (the official-extension path).** We run with
 * `--permission-prompt-tool stdio --permission-mode default`, exactly as
 * the official VS Code extension spawns the CLI. Tools that need approval
 * surface as a `control_request` `{ subtype:'can_use_tool', tool_name,
 * input, tool_use_id }` NDJSON line on **stdout**; the host answers with a
 * `control_response` line on **stdin** carrying a `behavior: 'allow' |
 * 'deny'` decision. (Wire shapes verified against the public Claude Code
 * source snapshot, `src/cli/structuredIO.ts`.) This replaces the
 * step-8c/11 IDE-bridge `openDiff` trigger, which the CLI does **not**
 * use in headless `-p` mode — see CLAUDE.md gotcha. stdin therefore stays
 * open for the whole turn (we close it on the `result` envelope) so we
 * can write decisions back.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  requestId: string
}

export interface ClaudeTurnOpts {
  cwd: string
  prompt: string
  /** Claude's own session id from a prior turn → `--resume <id>`. */
  resumeSessionId?: string
  /** Called for every parsed stream-json envelope, in order. */
  onEvent: (type: string, envelope: Record<string, unknown>) => void
  /** Called once with the session id from the first `system` event. */
  onSessionId: (id: string) => void
  /**
   * Approve/deny a tool the CLI is asking about (`can_use_tool`). If
   * omitted everything is auto-allowed. On allow the CLI itself performs
   * the edit; Domo never writes the file in the live path.
   */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>
  /** The CLI withdrew a pending permission request (it decided otherwise). */
  onPermissionCancel?: (requestId: string) => void
  /**
   * Called once the child is spawned and stdin is open, with a `steer`
   * fn that injects a mid-turn user message (stream-json). The CLI queues
   * it and consumes it at the next step boundary while the turn continues
   * (`--replay-user-messages` echoes it back as `{type:'user',uuid,
   * isReplay:true}`). See design "Steering a running turn" (Decided #18).
   */
  onReady?: (steer: (text: string, uuid: string) => void) => void
  /** Abort the turn — SIGTERM the child; the turn resolves (not errors). */
  signal?: AbortSignal
}

// Scrub the key + the outer Claude Code session vars: Domo's own dev
// server may itself be running under a `claude` session, and a nested
// CLI silently prefers a leaked ANTHROPIC_API_KEY over OAuth (documented
// footgun — design "Subscription billing & credential isolation").
const SCRUB_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'AI_AGENT',
  'CLAUDE_EFFORT',
])

export async function runClaudeTurn(opts: ClaudeTurnOpts): Promise<void> {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!SCRUB_ENV.has(k)) env[k] = v
  }
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose', // required with stream-json output in -p mode
    // Headless permission delegation, matching the official VS Code
    // extension's spawn. `default` (not `acceptEdits`) so edit tools are
    // *asked*; `stdio` routes the ask to us over this stream-json channel.
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    'default',
    // Echo user messages (initial + mid-turn steer) back on stdout as
    // `{type:'user',uuid,isReplay:true}` — the consumption ack that the
    // transcript matches by uuid to flip a steer queued→delivered.
    '--replay-user-messages',
    '--add-dir',
    opts.cwd,
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
  ]

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const onAbort = (): void => {
    child.kill('SIGTERM')
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  const writeLine = (obj: unknown): void => {
    if (child.stdin.writable) {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch {
        /* peer gone */
      }
    }
  }
  const respond = (requestId: string, decision: PermissionDecision): void => {
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

  // Serialize the user message + any control responses; the CLI's stdin
  // reader is line-delimited NDJSON.
  function handleControlRequest(msg: {
    request_id?: unknown
    request?: { subtype?: unknown; tool_name?: unknown; input?: unknown; tool_use_id?: unknown }
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
    const request: PermissionRequest = {
      toolName: String(req.tool_name ?? ''),
      input: (req.input ?? {}) as Record<string, unknown>,
      toolUseId: String(req.tool_use_id ?? ''),
      requestId,
    }
    const decide = opts.onPermissionRequest
      ? opts.onPermissionRequest(request)
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

  let sessionCaptured = false
  let stdoutBuf = ''
  const onLine = (line: string): void => {
    if (!line.trim()) return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      opts.onEvent('raw', { text: line })
      return
    }
    const type = typeof evt.type === 'string' ? evt.type : 'unknown'

    if (type === 'control_request') {
      handleControlRequest(evt as Parameters<typeof handleControlRequest>[0])
      return
    }
    if (type === 'control_cancel_request') {
      const rid = String(evt.request_id ?? '')
      if (rid) opts.onPermissionCancel?.(rid)
      return
    }
    if (type === 'control_response' || type === 'keep_alive') return

    if (
      !sessionCaptured &&
      type === 'system' &&
      typeof evt.session_id === 'string'
    ) {
      sessionCaptured = true
      opts.onSessionId(evt.session_id)
    }
    opts.onEvent(type, evt)

    // `result` is the final turn envelope — close stdin so the one-shot
    // `-p` process exits (we keep it open until now for control responses).
    if (type === 'result') {
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
    }
  }
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() ?? ''
    for (const l of lines) onLine(l)
  })

  let stderr = ''
  child.stderr.on('data', (b: Buffer) => {
    if (stderr.length < 4096) stderr += b.toString().slice(0, 4096)
  })

  const userMsg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: opts.prompt }],
    },
  }
  // Keep stdin OPEN — control responses are written to it for the rest of
  // the turn; it's closed on the `result` envelope (or process exit).
  child.stdin.write(JSON.stringify(userMsg) + '\n')

  // stdin is open now → expose the mid-turn steer channel. The CLI queues
  // the message and consumes it at the next step boundary (Decided #18).
  opts.onReady?.((text: string, uuid: string) => {
    writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      uuid,
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => {
        if (stdoutBuf.trim()) onLine(stdoutBuf)
        // An aborted turn exits non-zero from SIGTERM — that's expected,
        // resolve so the caller treats it as "aborted", not "errored".
        if (opts.signal?.aborted || code === 0 || code === null) {
          return resolve()
        }
        reject(
          new Error(
            `claude exited ${code}. stderr=${stderr.slice(0, 800) || '<empty>'}`,
          ),
        )
      })
    })
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

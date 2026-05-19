import { spawn } from 'node:child_process'
import { delimiter as pathDelimiter } from 'node:path'
import { loadDomoConfig } from '../config'

/**
 * Host-side `claude` one-turn runner (Option A — design Decided #11).
 *
 * stdout `stream-json` is the runtime event source (design Decided #7):
 * one NDJSON envelope per line — `system` (init; carries `session_id`),
 * `assistant` (text / tool_use), `user` (tool_result), `result` (final).
 *
 * **Invocation mirrors the official VS Code extension EXACTLY (no `-p`).**
 * Spike-proven (`smoke/no-print-lifecycle-spike.mjs`): the post-2026-06-15
 * billing classifier reads the outbound `x-anthropic-billing-header`
 * `cc_entrypoint=` value, which claude's `main.tsx initializeEntrypoint()`
 * derives from `CLAUDE_CODE_ENTRYPOINT` (preserved if set, else forced to
 * `sdk-cli` for piped/non-TTY). `-p` is a *red herring* — changes neither
 * billing nor lifecycle. So we (1) **set
 * `CLAUDE_CODE_ENTRYPOINT=claude-vscode`** (the extension's value → full
 * subscription billing, not the capped post-2026-06-15 Agent-SDK
 * credit), and (2) pass the extension's flag set **without `-p`**, so
 * we're genuinely using the CLI the allowed/interactive way rather than
 * spoofing a header. The extension omits `--resume` for a new session
 * and adds it only when resuming — Domo's existing conditional
 * `--resume` (capture `session_id` from the first `system` event, resume
 * thereafter) already matches that. See `project-agent-sdk-billing`.
 *
 * **Permission protocol.** `--permission-prompt-tool stdio
 * --permission-mode default`, exactly as the extension spawns it (its
 * argv carries `--permission-prompt-tool stdio` too — diff approval is
 * stdio, NOT the IDE-bridge `openDiff`; `bridge.ts` stays dormant). Tools
 * that need approval surface as a `control_request`
 * `{ subtype:'can_use_tool', tool_name, input, tool_use_id }` NDJSON line
 * on **stdout**; the host answers with a `control_response` line on
 * **stdin** carrying a `behavior: 'allow' | 'deny'` decision. (Wire
 * shapes verified against the public Claude Code source snapshot,
 * `src/cli/structuredIO.ts`.) stdin stays open for the whole turn (we
 * close it on the `result` envelope) so we can write decisions back.
 *
 * NOTE: still spawn-per-turn (process exits on `result`, next turn
 * `--resume`). The spike confirmed the no-`-p` process also exits cleanly
 * on stdin-close; the long-lived per-session process model (full
 * behavioral fidelity) is the Phase-2 follow-up.
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

  // Operator's declarative env extension (`<domoHome>/config.json`,
  // Decided #19). The host install means `claude` already inherits the
  // service env; this is the no-restart, survives-update knob for extra
  // vars / PATH (e.g. a runtime an MCP server needs). Scrubbed keys are
  // skipped here, not deleted later — `env` was built *without* them
  // above, so refusing to set them keeps the scrub the final word
  // (Decided #9: the knob can't reintroduce e.g. ANTHROPIC_API_KEY and
  // silently flip subscription→API billing). `PATH` isn't scrubbed.
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

  // EXACT official VS Code 2.1.142 new-session argv (no `-p`, no
  // `--add-dir` — the extension uses neither; cwd is the spawn cwd).
  // Order mirrors the extension. `--resume` is appended only when
  // resuming (the extension omits it for new sessions, adds it for
  // resumed ones — i.e. Domo's existing conditional model already
  // matches it: capture session_id from the first `system` event, then
  // `--resume` thereafter).
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-thinking-tokens', '31999',
    // Built-in stdio permission protocol — exactly what the extension's
    // argv carries (NOT the IDE-bridge openDiff; bridge.ts stays
    // dormant). `default` (not acceptEdits) so edit tools are *asked*.
    '--permission-prompt-tool', 'stdio',
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
    '--setting-sources=user,project,local',
    '--permission-mode', 'default',
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
    // `--include-partial-messages` (extension parity) emits incremental
    // `stream_event` deltas. Domo's durable model is built on the
    // complete `assistant`/`user`/`result` envelopes; forwarding every
    // partial would flood the durable `events` stream and change adapter
    // behavior. Drop them here — preserves today's behavior exactly
    // (Domo never passed the flag before, so never saw these) while the
    // argv stays byte-identical to the official extension. (Phase 2 may
    // consume partials for a token-streaming UI.)
    if (type === 'stream_event') return

    if (
      !sessionCaptured &&
      type === 'system' &&
      typeof evt.session_id === 'string'
    ) {
      sessionCaptured = true
      opts.onSessionId(evt.session_id)
    }
    opts.onEvent(type, evt)

    // `result` is the final turn envelope — close stdin so the process
    // exits (kept open until now for control responses). Spike-proven
    // (smoke/no-print-lifecycle-spike.mjs): the no-`-p` process also
    // exits cleanly on stdin-close, so the spawn-per-turn model holds.
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

  // `--debug-to-stderr` (extension parity) floods stderr with debug
  // logs; the fatal error on a non-zero exit is at the TAIL, so keep a
  // rolling last ~8 KB (was: first 4 KB — which would now be startup
  // debug noise, burying the actual error).
  let stderr = ''
  child.stderr.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-8192)
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

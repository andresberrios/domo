import { spawn } from 'node:child_process'

/**
 * Host-side `claude` one-turn runner (Option A — design Decided #11).
 *
 * stdout `stream-json` is the ONLY runtime event source (design Decided #7):
 * one NDJSON envelope per line — `system` (init; carries `session_id`),
 * `assistant` (text / tool_use), `user` (tool_result), `result` (final).
 * The prompt goes in as a single stream-json `user` message on stdin;
 * stdin is then closed so the `-p` turn completes and the process exits.
 *
 * When `bridgePort` is given we set `CLAUDE_CODE_SSE_PORT` +
 * `ENABLE_IDE_INTEGRATION=true` so the CLI connects to the per-session
 * IDE bridge (step 8c). Under `--permission-mode acceptEdits` Edit/Write
 * route through the bridge's `openDiff`; the durable approval round-trip
 * is step 11.
 */
export interface ClaudeTurnOpts {
  cwd: string
  prompt: string
  /** Claude's own session id from a prior turn → `--resume <id>`. */
  resumeSessionId?: string
  /** Port of the per-session IDE-bridge WS server, if booted for this turn. */
  bridgePort?: number
  /** Called for every parsed stream-json envelope, in order. */
  onEvent: (type: string, envelope: Record<string, unknown>) => void
  /** Called once with the session id from the first `system` event. */
  onSessionId: (id: string) => void
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
  if (opts.bridgePort !== undefined) {
    env.CLAUDE_CODE_SSE_PORT = String(opts.bridgePort)
    env.ENABLE_IDE_INTEGRATION = 'true'
  }

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose', // required with stream-json output in -p mode
    '--permission-mode',
    'acceptEdits',
    '--add-dir',
    opts.cwd,
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
  ]

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

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
    if (
      !sessionCaptured &&
      type === 'system' &&
      typeof evt.session_id === 'string'
    ) {
      sessionCaptured = true
      opts.onSessionId(evt.session_id)
    }
    opts.onEvent(type, evt)
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
  child.stdin.write(JSON.stringify(userMsg) + '\n')
  child.stdin.end()

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      if (stdoutBuf.trim()) onLine(stdoutBuf)
      if (code === 0 || code === null) return resolve()
      reject(
        new Error(
          `claude exited ${code}. stderr=${stderr.slice(0, 800) || '<empty>'}`,
        ),
      )
    })
  })
}

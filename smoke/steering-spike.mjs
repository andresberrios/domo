/**
 * Spike: does a stdin user message mid-turn STEER (queued, picked up at the
 * next boundary while the turn continues) or only land after the turn ends,
 * and when does `--replay-user-messages` echo it back on stdout?
 *
 * Standalone — mirrors Domo's exact `claude` spawn (server/lib/electric/
 * claude.ts) + `--replay-user-messages`. Does NOT touch Domo. Logs every
 * stdout envelope with a monotonic ms timestamp so we can read the cadence:
 * after a tool call? after an assistant message? only at `result`?
 *
 *   node smoke/steering-spike.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCRUB = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'AI_AGENT',
  'CLAUDE_EFFORT',
])
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!SCRUB.has(k)) env[k] = v
env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'

const cwd = mkdtempSync(join(tmpdir(), 'domo-steer-'))
const t0 = performance.now()
const ts = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const log = (...a) => console.log(ts(), ...a)

const args = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--permission-prompt-tool', 'stdio',
  '--permission-mode', 'default',
  '--replay-user-messages',
  '--add-dir', cwd,
]
log('spawn claude', args.join(' '), 'cwd=', cwd)
const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

const writeLine = (o) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n') }

const steerUuid = randomUUID()
let injected = false
let injectAt = 0

function inject() {
  if (injected) return
  injected = true
  injectAt = performance.now()
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text:
        'STEERING_INJECT: Abandon the remaining steps. As soon as you possibly ' +
        'can, reply with exactly the single word PINEAPPLE and then finish.' }],
    },
    uuid: steerUuid,
  }
  log('>>> INJECT steering message to stdin (uuid=' + steerUuid.slice(0, 8) + ')')
  writeLine(msg)
}

let buf = ''
child.stdout.on('data', (c) => {
  buf += c.toString()
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) onLine(line)
})
let stderr = ''
child.stderr.on('data', (b) => { stderr += b.toString() })

function summarize(evt) {
  const t = evt.type
  if (t === 'assistant' || t === 'user') {
    const blocks = evt.message?.content ?? []
    const parts = (Array.isArray(blocks) ? blocks : [{ type: 'text', text: String(blocks) }]).map((b) => {
      if (b.type === 'text') return 'text:' + JSON.stringify(b.text?.slice(0, 80))
      if (b.type === 'tool_use') return `tool_use(${b.name}):` + JSON.stringify(JSON.stringify(b.input).slice(0, 80))
      if (b.type === 'tool_result') return 'tool_result:' + JSON.stringify(String(b.content?.[0]?.text ?? b.content).slice(0, 80))
      return b.type
    })
    return `${t}${evt.isReplay ? ' [isReplay]' : ''} ${parts.join(' | ')}`
  }
  if (t === 'system') return `system subtype=${evt.subtype}`
  if (t === 'result') return `result is_error=${evt.is_error} ${JSON.stringify(String(evt.result ?? '').slice(0, 120))}`
  if (t === 'control_request') return `control_request ${evt.request?.subtype} tool=${evt.request?.tool_name}`
  return t
}

let firstToolUseSeen = false
function onLine(line) {
  if (!line.trim()) return
  let evt
  try { evt = JSON.parse(line) } catch { log('raw', line.slice(0, 120)); return }

  if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
    log('AUTO-ALLOW', evt.request?.tool_name)
    writeLine({ type: 'control_response', response: { subtype: 'success', request_id: evt.request_id, response: { behavior: 'allow', updatedInput: evt.request?.input ?? {} } } })
    return
  }
  if (evt.type === 'control_response' || evt.type === 'keep_alive') return

  const s = summarize(evt)
  log(s)

  if (evt.isReplay && injected) {
    log(`### REPLAY/ACK arrived ${((performance.now() - injectAt) / 1000).toFixed(2)}s after inject`)
  }

  // Inject once, the moment the agent is genuinely mid-work: first tool_use.
  if (!firstToolUseSeen && evt.type === 'assistant') {
    const blocks = evt.message?.content ?? []
    if (Array.isArray(blocks) && blocks.some((b) => b.type === 'tool_use')) {
      firstToolUseSeen = true
      log('(first tool_use seen → scheduling inject in 1.5s, mid-tool)')
      setTimeout(inject, 1500)
    }
  }

  if (evt.type === 'result') {
    log('TURN ENDED. injected=' + injected + ' steerUuid=' + steerUuid.slice(0, 8))
    setTimeout(() => { try { child.kill() } catch { /* gone */ } process.exit(0) }, 500)
  }
}

const firstPrompt = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text:
      'Use the Bash tool to run these THREE commands, each as a SEPARATE Bash ' +
      'tool call, strictly one at a time in order, waiting for each to finish ' +
      'before starting the next. Do NOT combine them. After each finishes, ' +
      'write a short assistant message stating which step you just finished.\n' +
      '1) sleep 8 && echo SPIKE_STEP_1_DONE\n' +
      '2) sleep 8 && echo SPIKE_STEP_2_DONE\n' +
      '3) sleep 8 && echo SPIKE_STEP_3_DONE\n' +
      'Then say ALL_STEPS_DONE and finish.' }],
  },
}
log('write initial prompt')
child.stdin.write(JSON.stringify(firstPrompt) + '\n')

child.on('exit', (code) => {
  log('child exit code=' + code, stderr ? 'stderr=' + stderr.slice(0, 400) : '')
  process.exit(0)
})
setTimeout(() => { log('TIMEOUT 120s — killing'); try { child.kill() } catch { /* gone */ }; process.exit(1) }, 120000)

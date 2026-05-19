// Throwaway spike — validates the load-bearing assumption for the
// long-lived-process migration the user asked for: does ONE non-`-p`
// claude process (full official VS Code 2.1.142 flag set, entrypoint
// = claude-vscode) serve MULTIPLE turns over one persistent stdin, with
// context continuity, and shut down cleanly only when stdin closes?
//
// Turn 1 plants a fact; turn 2 (same process, stdin kept open) asks for
// it back — if turn 2 recalls it, the live session persisted across
// turns in-process (no --resume needed between turns). Then we close
// stdin and confirm the process exits.
//
// Run with harness sandbox disabled (spawned claude in a clean ns).

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE = (() => {
  try { return execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() }
  catch { return 'claude' }
})()

const SCRUB = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT', 'CLAUDE_EFFORT'])
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!SCRUB.has(k)) env[k] = v
env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode' // the proven billing lever

// Official VS Code 2.1.142 flag set, minus -p, minus --resume (one
// fresh in-process session; --resume is only for a NEW process
// re-attaching to a prior session, e.g. after a Domo restart).
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--max-thinking-tokens', '31999',
  '--permission-prompt-tool', 'stdio',
  '--setting-sources=user,project,local',
  '--permission-mode', 'default',
  '--include-partial-messages',
  '--debug-to-stderr',
  '--enable-auth-status',
  '--no-chrome',
  '--replay-user-messages',
]

const cwd = mkdtempSync(join(tmpdir(), 'domo-persist-'))
execFileSync('git', ['-C', cwd, 'init', '-q'])

const child = spawn(CLAUDE, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

let buf = ''
let turn = 0
const sessionIds = new Set()
const assistantText = { 1: '', 2: '' }
let ccEntrypoint = '(none)'
let resolveDone
const done = new Promise((r) => { resolveDone = r })

function send(text) {
  child.stdin.write(JSON.stringify({ type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
}

child.stdout.on('data', (c) => {
  buf += c.toString()
  const lines = buf.split('\n'); buf = lines.pop() ?? ''
  for (const ln of lines) {
    if (!ln.trim()) continue
    let e; try { e = JSON.parse(ln) } catch { continue }
    if (e.type === 'system' && e.session_id) sessionIds.add(e.session_id)
    if (e.type === 'assistant' && turn >= 1 && turn <= 2) {
      const parts = e.message?.content ?? []
      for (const p of parts) if (p.type === 'text') assistantText[turn] += p.text
    }
    if (e.type === 'result') {
      if (turn === 1) {
        console.log(`  [turn 1 result] session=${[...sessionIds].join(',')} reply=${JSON.stringify(assistantText[1].trim().slice(0, 60))}`)
        turn = 2
        // SAME process, stdin still open → second turn:
        send('What number did I ask you to remember in my previous message? Reply with ONLY that number, nothing else.')
      } else if (turn === 2) {
        console.log(`  [turn 2 result] session=${[...sessionIds].join(',')} reply=${JSON.stringify(assistantText[2].trim().slice(0, 60))}`)
        // Now close stdin — does the persistent process exit?
        const tClose = Date.now()
        child.once('exit', (code) => {
          console.log(`  [stdin closed] process exited code=${code} after ${Date.now() - tClose}ms`)
          finish()
        })
        try { child.stdin.end() } catch { /* already closed */ }
        setTimeout(() => { if (child.exitCode === null) { console.log('  [stdin closed] did NOT exit within 12s → persistent'); try { child.kill('SIGTERM') } catch { /* gone */ }; finish() } }, 12000)
      }
    }
  }
})
let stderr = ''
child.stderr.on('data', (c) => {
  const s = c.toString(); stderr += s
  void stderr
  const m = s.match(/cc_entrypoint=([a-z0-9-]+)/i)
  if (m) ccEntrypoint = m[1]
})
child.on('error', (e) => { console.log('SPAWN ERROR', e.message); resolveDone() })

let finished = false
function finish() {
  if (finished) return; finished = true
  const recalled = /\b42\b/.test(assistantText[2])
  console.log('\n================ VERDICT ================')
  console.log(`distinct session_ids across both turns: ${[...sessionIds].length} (${[...sessionIds].join(', ')})  → 1 = same live session`)
  console.log(`turn-2 recalled the planted fact (42)? ${recalled ? 'YES → context persisted in one process across turns' : 'NO'}`)
  console.log(`cc_entrypoint (billing): ${ccEntrypoint} (expect claude-vscode)`)
  console.log(`multi-turn-on-one-process viable for the long-lived model? ${recalled && [...sessionIds].length === 1 ? 'YES' : 'INCONCLUSIVE/NO — see above'}`)
  resolveDone()
}

// Hard timeout guard
setTimeout(() => { console.log('HARD TIMEOUT'); try { child.kill('SIGKILL') } catch { /* gone */ }; finish() }, 150000)

// Turn 1 — plant a fact.
turn = 1
send('Remember this number for later: 42. Just reply with the single word READY and nothing else. Do not use any tools.')

await done

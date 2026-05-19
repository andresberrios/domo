// Throwaway spike (kept under smoke/ per project convention, cf.
// steering-spike.mjs). Question: can Domo drop `-p` from its `claude`
// spawn (→ full-subscription billing + no headless auto-sandbox) while
// keeping its per-turn process model?
//
// A/B: the official VS Code 2.1.142 flag set WITHOUT `-p` (arm A) vs the
// same + `-p` (arm B). For each arm we measure:
//   (1) LIFECYCLE — after the `result` event we close stdin (Domo's
//       per-turn model expects the process to then exit). Does it exit,
//       and how fast — or does it persist (interactive session)?
//   (2) AUTH/BILLING — `system` init `apiKeySource` + any auth-status
//       event + stderr debug lines mentioning billing/subscription.
//   (3) SANDBOX — does the spawned claude create its OWN nested bwrap;
//       does the (fresh, git-init'd) cwd get littered with stub files;
//       is node_modules/.bin still writable.
//
// Run with the harness sandbox DISABLED so the spawned claude is in a
// clean namespace (like Domo's server), not nested in our bwrap.

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE = (() => {
  try { return execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() }
  catch { return 'claude' }
})()

// Mirror Domo's env scrub (server/lib/electric/claude.ts SCRUB_ENV).
const SCRUB = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT', 'CLAUDE_EFFORT'])
function scrubbedEnv() {
  const e = {}
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB.has(k)) e[k] = v
  e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
  return e
}

// Official VS Code 2.1.142 flag set, minus --resume (fresh session) and
// minus --debug noise we don't need; --debug-to-stderr kept for billing
// signal. Arm B appends -p.
function args(withPrint, settingSources = 'user,project,local') {
  const a = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-thinking-tokens', '31999',
    '--permission-prompt-tool', 'stdio',
    `--setting-sources=${settingSources}`,
    '--permission-mode', 'default',
    '--include-partial-messages',
    '--debug-to-stderr',
    '--enable-auth-status',
    '--no-chrome',
    '--replay-user-messages',
  ]
  if (withPrint) a.push('-p')
  return a
}

const PROMPT = 'Respond with exactly the single word PONG and nothing else. Do not use any tools.'
const HARD_TIMEOUT_MS = 120_000
const EXIT_WAIT_MS = 15_000

function nestedBwrap() {
  try {
    const out = execFileSync('bash', ['-lc',
      `ps -eo pid,ppid,comm | awk '$3=="bwrap"{print $1" ppid="$2}'`], { encoding: 'utf8' }).trim()
    return out || '(none)'
  } catch { return '(ps failed)' }
}

async function runArm(label, withPrint, extraEnv = {}, settingSources = 'user,project,local') {
  const cwd = mkdtempSync(join(tmpdir(), `domo-spike-${label}-`))
  execFileSync('git', ['-C', cwd, 'init', '-q'])
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(cwd, 'package.json'), '{"name":"spike","private":true}\n')
  const before = new Set(readdirSync(cwd))

  const r = { label, withPrint, cwd, events: [], systemInit: null, authEvents: [],
    sawResult: false, tResultMs: null, exitedOnStdinClose: null, exitLatencyMs: null,
    exitCode: null, stderrTail: '', billingLines: [], nestedBwrap: null,
    litter: [], binWritable: null, error: null }

  const t0 = Date.now()
  const child = spawn(CLAUDE, args(withPrint, settingSources), { cwd, env: { ...scrubbedEnv(), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })

  let stdoutBuf = '', stderrBuf = ''
  const done = new Promise((resolve) => {
    const hard = setTimeout(() => { r.error = 'HARD_TIMEOUT (no result)'; try { child.kill('SIGKILL') } catch { /* gone */ } }, HARD_TIMEOUT_MS)

    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString()
      const lines = stdoutBuf.split('\n'); stdoutBuf = lines.pop() ?? ''
      for (const ln of lines) {
        if (!ln.trim()) continue
        let e; try { e = JSON.parse(ln) } catch { continue }
        const ty = e.type ?? '?'
        r.events.push(ty + (e.subtype ? `:${e.subtype}` : ''))
        if (ty === 'system' && !r.systemInit) r.systemInit = e
        if (/auth|billing/i.test(ty) || /auth|billing/i.test(e.subtype ?? '')) r.authEvents.push(e)
        if (ty === 'result' && !r.sawResult) {
          r.sawResult = true; r.tResultMs = Date.now() - t0
          setTimeout(() => { r.nestedBwrap = nestedBwrap(child.pid) }, 200)
          try { child.stdin.end() } catch { /* already closed */ }      // Domo's per-turn behavior
          const exitTimer = setTimeout(() => {
            r.exitedOnStdinClose = false           // persistent session
            try { child.kill('SIGTERM') } catch { /* gone */ }
            setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 3000)
          }, EXIT_WAIT_MS)
          child.once('exit', () => clearTimeout(exitTimer))
        }
      }
    })
    child.stderr.on('data', (c) => {
      const s = c.toString(); stderrBuf += s
      for (const ln of s.split('\n'))
        if (/billing|subscription|credit|apikeysource|account|usage limit|interactive|sandbox|bwrap/i.test(ln))
          r.billingLines.push(ln.trim().slice(0, 240))
    })
    child.on('error', (err) => { r.error = `spawn error: ${err.message}`; clearTimeout(hard); resolve() })
    child.on('exit', (code) => {
      clearTimeout(hard)
      r.exitCode = code
      if (r.sawResult && r.exitedOnStdinClose === null) {
        r.exitedOnStdinClose = true
        r.exitLatencyMs = (Date.now() - t0) - r.tResultMs
      }
      r.stderrTail = stderrBuf.slice(-1200)
      resolve()
    })
  })

  child.stdin.write(JSON.stringify({ type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } }) + '\n')

  await done

  const after = readdirSync(cwd)
  r.litter = after.filter((f) => !before.has(f))
  try { writeFileSync(join(cwd, 'node_modules', '.bin', '.wtest'), 'x'); r.binWritable = true }
  catch (e) { r.binWritable = `NO (${e.code})` }
  return r
}

function summarize(r) {
  console.log(`\n================ ARM ${r.label}  (${r.withPrint ? 'WITH -p' : 'NO -p'}) ================`)
  if (r.error) console.log(`  ERROR: ${r.error}`)
  console.log(`  events: ${r.events.join(' ')}`)
  if (r.systemInit) {
    const s = r.systemInit
    console.log(`  system.apiKeySource = ${JSON.stringify(s.apiKeySource)}  permissionMode=${JSON.stringify(s.permissionMode)}`)
    console.log(`  system keys: ${Object.keys(s).join(',')}`)
  } else console.log('  system init: <none captured>')
  console.log(`  authEvents: ${r.authEvents.length ? JSON.stringify(r.authEvents).slice(0, 500) : '(none)'}`)
  console.log(`  sawResult=${r.sawResult} tResult=${r.tResultMs}ms`)
  console.log(`  LIFECYCLE → exitedOnStdinClose=${r.exitedOnStdinClose}  exitLatency=${r.exitLatencyMs}ms  exitCode=${r.exitCode}`)
  console.log(`  SANDBOX  → nestedBwrap=${r.nestedBwrap}  litter=${JSON.stringify(r.litter)}  binWritable=${r.binWritable}`)
  if (r.billingLines.length) console.log(`  billing/sandbox stderr:\n    ${r.billingLines.slice(0, 12).join('\n    ')}`)
  console.log(`  stderr tail: ${JSON.stringify(r.stderrTail.slice(-400))}`)
}

console.log(`claude = ${CLAUDE}`)
// A/B (scrub→sdk-cli, ±-p) already proven in a prior run: identical
// sdk-cli billing + 17-file litter + per-turn exit. Skipped here to save
// cost. C = billing fix only (vscode entrypoint, official setting-sources
// → litters). D = full fix candidate (vscode entrypoint + drop the `user`
// setting-source so the operator's global defaultMode:auto is ignored).
const A = { exitedOnStdinClose: 'true(prior)', systemInit: { apiKeySource: '"none"(prior)' }, billingLines: ['cc_entrypoint=sdk-cli'], litter: new Array(17) }
void A // referenced in the summary table below the live arms
const C = await runArm('C-vscode', false, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
summarize(C)
const D = await runArm('D-vscode-nouser', false, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, 'project,local')
summarize(D)

const ccEnt = (r) => {
  const l = r.billingLines.find((x) => x.includes('cc_entrypoint='))
  return l ? l.replace(/.*cc_entrypoint=([a-z0-9-]+).*/i, '$1') : '(none seen)'
}
console.log('\n================ VERDICT ================')
console.log(`per-turn exit on stdin close: C=${C.exitedOnStdinClose} D=${D.exitedOnStdinClose} (expect true)`)
console.log(`apiKeySource: C=${JSON.stringify(C.systemInit?.apiKeySource)} D=${JSON.stringify(D.systemInit?.apiKeySource)} (expect "none")`)
console.log(`cc_entrypoint (billing): C=${ccEnt(C)} D=${ccEnt(D)} (expect claude-vscode = full subscription)`)
console.log(`litter count: C(setting-sources w/ user)=${C.litter.length}  D(drop user)=${D.litter.length}  → D≈0 means dropping the user setting-source kills the litter+.bin breakage`)
console.log(`D litter: ${JSON.stringify(D.litter)}  binWritable=${D.binWritable}`)

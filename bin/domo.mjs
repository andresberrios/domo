#!/usr/bin/env node
// Domo's launcher: the supervisor that runs an installed Domo, the service
// commands around it, and the updater. One plain JavaScript file with no
// dependencies, so it runs on the bundled Node before anything is built, and
// so that replacing it is copying a file.
//
// An installed Domo lives under DOMO_HOME (default ~/.domo); see
// docs/install-and-updates.md for the layout. Development uses `pnpm dev`
// and never this file.
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = resolve(process.env.DOMO_HOME || join(homedir(), '.domo'))
const P = {
  app: join(HOME, 'app'),
  releases: join(HOME, 'releases'),
  current: join(HOME, 'current'),
  previous: join(HOME, 'previous'),
  node: join(HOME, 'node', 'bin', 'node'),
  pnpm: join(HOME, 'bin', 'pnpm'),
  caddy: join(HOME, 'bin', 'caddy'),
  bin: join(HOME, 'bin'),
  launcher: join(HOME, 'bin', 'domo.mjs'),
  data: join(HOME, 'data'),
  env: join(HOME, '.env'),
  logs: join(HOME, 'logs'),
  log: join(HOME, 'logs', 'domo.log'),
  supervisorPid: join(HOME, 'supervisor.pid'),
  updateLock: join(HOME, 'update.lock'),
  updateFailed: join(HOME, 'update-failed.json'),
  state: join(HOME, 'state.json')
}

/** The server exits with this when it wants the supervisor to start it again from `current`. */
export const RESTART_EXIT_CODE = 75
const SERVICE_LABEL = 'com.domo.app'
const HEALTH_TIMEOUT_MS = 60_000

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function log(...parts) {
  console.log(`${new Date().toISOString()} [domo] ${parts.join(' ')}`)
}

function fail(message) {
  console.error(`domo: ${message}`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** `KEY=value` lines of `.env`, without touching what the caller already has. */
function readDotenv(file = P.env) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * The PATH the user's own shell would have. A launchd or systemd service
 * starts with a bare PATH, and the coding agents Domo spawns need git, docker
 * and whatever the user installed with Homebrew or in their home directory.
 */
function loginPath() {
  const shell = process.env.SHELL || '/bin/sh'
  const probe = spawnSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
  const found = probe.status === 0 ? probe.stdout.trim().split('\n').pop() : ''
  const base = found && found.includes('/') ? found : (process.env.PATH || '/usr/bin:/bin')
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]
  const parts = [P.bin, dirname(P.node), ...base.split(':'), ...extra]
  return [...new Set(parts.filter(Boolean))].join(':')
}

/** The environment the server, Caddy and the updater run with. */
function serverEnv() {
  const dotenv = readDotenv()
  const env = { ...dotenv, ...process.env }
  env.DOMO_HOME = HOME
  env.PATH = loginPath()
  env.PORT = env.DOMO_PORT || '3667'
  // The Caddyfile is the one `pnpm dev` uses and names the upstream port after
  // the dev variable.
  env.DOMO_DEV_PORT = env.PORT
  env.HOST = '0.0.0.0'
  env.DOMO_HTTPS_ADDRESS ||= 'localhost:3666'
  env.DOMO_HTTPS_PORT = env.DOMO_HTTPS_ADDRESS.split(':').pop() || '3666'
  env.NUXT_DATA_DIR ||= P.data
  env.DATABASE_URL ||= 'postgresql://postgres:password@localhost:54321/domo'
  env.ELECTRIC_URL ||= 'http://localhost:30000'
  env.NODE_ENV = 'production'
  return env
}

function currentRelease() {
  try {
    return realpathSync(P.current)
  } catch {
    return null
  }
}

function releaseInfo(dir) {
  return dir ? readJson(join(dir, 'build.json'), { commit: basename(dir) }) : null
}

/** Point `link` at `target` atomically: a symlink that is never missing. */
function relink(link, target) {
  const tmp = `${link}.tmp-${process.pid}`
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  renameSync(tmp, link)
}

function git(args, options = {}) {
  const result = spawnSync('git', ['-C', P.app, ...args], { encoding: 'utf8', timeout: options.timeout ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0) {
    if (options.lenient) return null
    throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

function runStreaming(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? done() : reject(new Error(`${basename(command)} ${args.join(' ')} exited ${code}`))))
  })
}

/**
 * Is the server up? The app shell, not `/api/health`: that route waits on
 * Postgres for fifteen seconds, and a database that is down is the UI's
 * banner to show, not a reason to roll a release back.
 */
async function healthy(env, timeoutMs, abort = () => false) {
  const url = `http://127.0.0.1:${env.PORT}/`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (abort()) return false
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(500)
  }
  return false
}

// --------------------------------------------------------------------------
// run: the supervisor
// --------------------------------------------------------------------------

async function run() {
  mkdirSync(P.logs, { recursive: true })
  mkdirSync(P.data, { recursive: true })
  if (!currentRelease()) fail(`nothing to run: ${P.current} does not point at a release. Run the installer, or \`domo update\`.`)
  const other = supervisorPid()
  if (other && other !== process.pid) fail(`a supervisor is already running (pid ${other})`)
  writeFileSync(P.supervisorPid, String(process.pid))

  const env = serverEnv()
  log(`home ${HOME}, https://${env.DOMO_HTTPS_ADDRESS}, upstream :${env.PORT}`)

  let stopping = false
  let server = null
  let caddy = null
  // Set when the server was asked to restart (exit 75, or SIGHUP): the next
  // start is a candidate for rollback, and gets no backoff.
  let restartRequested = false
  // One rollback per swap, so a release that is broken in both directions
  // does not flip for ever.
  let rolledBack = false

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    log(`${signal}: stopping`)
    server?.kill('SIGTERM')
    caddy?.kill('SIGTERM')
    setTimeout(() => {
      server?.kill('SIGKILL')
      caddy?.kill('SIGKILL')
    }, 25_000).unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGHUP', () => {
    // `domo restart`: the server only, onto whatever `current` is now.
    log('SIGHUP: restarting the server')
    restartRequested = true
    server?.kill('SIGTERM')
  })

  await composeUp(env)

  const startCaddy = () => {
    const release = currentRelease()
    caddy = spawn(P.caddy, ['run', '--config', join(release, 'Caddyfile'), '--adapter', 'caddyfile'], { env, stdio: 'inherit' })
    caddy.on('exit', (code, signal) => {
      caddy = null
      if (stopping) return
      log(`caddy exited (${signal || code}); starting it again in 3s`)
      setTimeout(startCaddy, 3000)
    })
  }
  startCaddy()

  let crashes = 0
  while (!stopping) {
    const release = currentRelease()
    const info = releaseInfo(release)
    log(`starting ${basename(release)} (${info?.commit?.slice(0, 7) ?? '?'}, built ${info?.builtAt ?? '?'})`)
    const candidate = restartRequested
    restartRequested = false
    const child = spawn(P.node, [join(release, 'server', 'index.mjs')], { env, stdio: 'inherit', cwd: release })
    server = child
    let exited = null
    const exit = new Promise(r => child.on('exit', (code, signal) => r((exited = { code, signal }))))
    child.on('error', error => log(`server failed to start: ${error.message}`))

    const ok = await healthy(env, HEALTH_TIMEOUT_MS, () => exited !== null || stopping)
    if (ok) {
      crashes = 0
      rolledBack = false
      log(`up at http://127.0.0.1:${env.PORT}`)
      rmSync(P.updateFailed, { force: true })
    } else if (!stopping && candidate && !rolledBack && existsSync(P.previous)) {
      const previous = realpathSync(P.previous)
      if (previous !== release) {
        rolledBack = true
        const reason = exited ? `exited ${exited.signal || exited.code} before answering` : `no answer on /api/health within ${HEALTH_TIMEOUT_MS / 1000}s`
        log(`release ${basename(release)} ${reason}; rolling back to ${basename(previous)}`)
        writeJson(P.updateFailed, { release: basename(release), rolledBackTo: basename(previous), reason, at: new Date().toISOString() })
        relink(P.current, previous)
        relink(P.previous, release)
        restartRequested = true
        if (!exited) child.kill('SIGTERM')
      }
    }

    const result = await exit
    server = null
    if (stopping) break
    if (result.code === RESTART_EXIT_CODE || restartRequested) {
      restartRequested = true
      log(`server asked for a restart (${result.signal || result.code})`)
      continue
    }
    crashes += 1
    const wait = Math.min(30_000, 2000 * 2 ** Math.min(crashes, 4))
    log(`server exited (${result.signal || result.code}); starting it again in ${wait / 1000}s`)
    await sleep(wait)
  }

  if (caddy) await new Promise(r => caddy.on('exit', r))
  rmSync(P.supervisorPid, { force: true })
  log('stopped')
}

/** Postgres and Electric, from the release's compose file. Failure is reported in the UI, not here. */
async function composeUp(env) {
  const release = currentRelease()
  const file = join(release, 'docker-compose.yml')
  if (!existsSync(file)) return
  log('docker compose up -d postgres electric')
  const result = spawnSync('docker', ['compose', '-f', file, 'up', '-d', 'postgres', 'electric'], { env, encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) log(`compose failed: ${(result.stderr || result.error?.message || '').trim().split('\n').pop()}`)
}

// --------------------------------------------------------------------------
// Service management (launchd on macOS, systemd --user on Linux)
// --------------------------------------------------------------------------

function servicePaths() {
  if (platform() === 'darwin') {
    return { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`), domain: `gui/${userInfo().uid}` }
  }
  return { kind: 'systemd', file: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'domo.service') }
}

function writeService() {
  const service = servicePaths()
  mkdirSync(dirname(service.file), { recursive: true })
  mkdirSync(P.logs, { recursive: true })
  if (service.kind === 'launchd') {
    writeFileSync(service.file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${P.node}</string>
    <string>${P.launcher}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOMO_HOME</key><string>${HOME}</string>
  </dict>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${P.log}</string>
  <key>StandardErrorPath</key><string>${P.log}</string>
</dict>
</plist>
`)
  } else {
    writeFileSync(service.file, `[Unit]
Description=Domo
After=network-online.target docker.service

[Service]
Environment=DOMO_HOME=${HOME}
WorkingDirectory=${HOME}
ExecStart=${P.node} ${P.launcher} run
Restart=always
RestartSec=5
StandardOutput=append:${P.log}
StandardError=append:${P.log}

[Install]
WantedBy=default.target
`)
  }
  return service
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

function serviceStart() {
  const service = writeService()
  if (service.kind === 'launchd') {
    sh('launchctl', ['bootout', `${service.domain}/${SERVICE_LABEL}`])
    const result = sh('launchctl', ['bootstrap', service.domain, service.file])
    if (!result.ok) fail(`launchctl bootstrap: ${result.err}`)
  } else {
    sh('systemctl', ['--user', 'daemon-reload'])
    const result = sh('systemctl', ['--user', 'enable', '--now', 'domo'])
    if (!result.ok) fail(`systemctl: ${result.err}`)
  }
  log(`service started (${service.kind})`)
}

function serviceStop() {
  const service = servicePaths()
  if (service.kind === 'launchd') sh('launchctl', ['bootout', `${service.domain}/${SERVICE_LABEL}`])
  else sh('systemctl', ['--user', 'stop', 'domo'])
  const pid = supervisorPid()
  if (pid) process.kill(pid, 'SIGTERM')
  log('service stopped')
}

function serviceUninstall() {
  serviceStop()
  const service = servicePaths()
  if (service.kind === 'systemd') sh('systemctl', ['--user', 'disable', 'domo'])
  rmSync(service.file, { force: true })
  if (service.kind === 'systemd') sh('systemctl', ['--user', 'daemon-reload'])
  console.log(`Domo no longer starts at login. Its files are still in ${HOME}; remove that directory to delete them.\nPostgres and Electric are still in Docker: \`docker compose -p domo down\` stops them, add \`-v\` to delete the database.`)
}

function supervisorPid() {
  const pid = Number(existsSync(P.supervisorPid) ? readFileSync(P.supervisorPid, 'utf8') : 0)
  return alive(pid) ? pid : null
}

function restart() {
  const pid = supervisorPid()
  if (!pid) {
    log('no supervisor running; starting the service')
    return serviceStart()
  }
  process.kill(pid, 'SIGHUP')
  log('asked the supervisor to restart the server')
}

async function status() {
  const env = serverEnv()
  const release = currentRelease()
  const info = releaseInfo(release)
  const pid = supervisorPid()
  const ok = release && pid ? await healthy(env, 2500) : false
  console.log(`home       ${HOME}`)
  console.log(`release    ${release ? `${basename(release)} (built ${info?.builtAt ?? '?'})` : 'none'}`)
  console.log(`channel    ${readState().channel}`)
  console.log(`supervisor ${pid ? `running (pid ${pid})` : 'not running'}`)
  console.log(`server     ${ok ? `answering at https://${env.DOMO_HTTPS_ADDRESS}` : 'not answering'}`)
  const failed = readJson(P.updateFailed)
  if (failed) console.log(`last update ${failed.release} failed (${failed.reason}) and was rolled back to ${failed.rolledBackTo} at ${failed.at}`)
  const lock = readJson(P.updateLock)
  if (lock && alive(lock.pid)) console.log(`update     in progress (pid ${lock.pid}, since ${lock.at})`)
}

function logs() {
  spawn('tail', ['-n', '200', '-f', P.log], { stdio: 'inherit' })
}

// --------------------------------------------------------------------------
// Updates
// --------------------------------------------------------------------------

function readState() {
  return { channel: 'release', ...readJson(P.state, {}) }
}

function writeState(patch) {
  writeJson(P.state, { ...readState(), ...patch })
}

/** The lock is a live pid, never a timestamp: a dead holder's lock is taken over. */
function takeUpdateLock() {
  const held = readJson(P.updateLock)
  if (held && held.pid !== process.pid && alive(held.pid)) fail(`an update is already running (pid ${held.pid}, since ${held.at})`)
  writeJson(P.updateLock, { pid: process.pid, at: new Date().toISOString() })
  const release = () => rmSync(P.updateLock, { force: true })
  process.on('exit', release)
  return release
}

function fetchChannel(channel) {
  git(['fetch', '--quiet', 'origin', channel], { timeout: 120_000 })
  return git(['rev-parse', `origin/${channel}`])
}

function updateCheck(channel) {
  const target = fetchChannel(channel)
  const installed = releaseInfo(currentRelease())?.commit ?? git(['rev-parse', 'HEAD'])
  const behind = installed === target ? 0 : Number(git(['rev-list', '--count', `${installed}..${target}`]))
  const commits = behind
    ? git(['log', '--format=%h %s', `${installed}..${target}`]).split('\n')
    : []
  return { installed, target, behind, commits }
}

/**
 * Build `commit` into releases/<commit>: the Nuxt output plus the files the
 * supervisor and Caddy read from a release. Skipped when it is already there.
 */
async function buildRelease(commit, env) {
  const dir = join(P.releases, commit)
  if (existsSync(join(dir, 'build.json'))) {
    log(`release ${commit.slice(0, 7)} is already built`)
    return dir
  }
  const building = `${dir}.building`
  rmSync(building, { recursive: true, force: true })
  mkdirSync(P.releases, { recursive: true })

  log(`checking out ${commit.slice(0, 7)}`)
  git(['checkout', '--quiet', '--detach', commit])
  const buildEnv = { ...env, NODE_ENV: undefined, CI: '1', COREPACK_ENABLE_STRICT: '0' }
  delete buildEnv.NODE_ENV
  log('pnpm install --frozen-lockfile')
  await runStreaming(P.pnpm, ['install', '--frozen-lockfile'], { cwd: P.app, env: buildEnv })
  log('pnpm build')
  await runStreaming(P.pnpm, ['build'], { cwd: P.app, env: buildEnv })

  log('assembling the release')
  cpSync(join(P.app, '.output'), building, { recursive: true })
  for (const file of ['Caddyfile', 'docker-compose.yml']) cpSync(join(P.app, file), join(building, file))
  mkdirSync(join(building, 'bin'), { recursive: true })
  cpSync(join(P.app, 'bin', 'domo.mjs'), join(building, 'bin', 'domo.mjs'))
  writeJson(join(building, 'build.json'), {
    commit,
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
    subject: git(['log', '-1', '--format=%s', commit])
  })
  renameSync(building, dir)
  return dir
}

/** Start the release on a spare port against no database: proves the bundle loads and serves. */
async function smokeTest(dir, env) {
  const port = String(40_000 + Math.floor(Math.random() * 10_000))
  const testEnv = {
    ...env,
    PORT: port,
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://postgres:none@127.0.0.1:1/none',
    ELECTRIC_URL: 'http://127.0.0.1:1',
    NUXT_DATA_DIR: join(dir, '.smoke-data'),
    NUXT_CLAUDE_CODE_OAUTH_TOKEN: '',
    NUXT_OPENCODE_API_KEY: ''
  }
  log(`smoke test on :${port}`)
  const child = spawn(P.node, [join(dir, 'server', 'index.mjs')], { env: testEnv, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', d => (output += d))
  child.stderr.on('data', d => (output += d))
  let exited = false
  child.on('exit', () => (exited = true))
  const ok = await healthy(testEnv, 30_000, () => exited)
  child.kill('SIGTERM')
  await Promise.race([new Promise(r => child.on('exit', r)), sleep(10_000)])
  if (!exited) child.kill('SIGKILL')
  rmSync(testEnv.NUXT_DATA_DIR, { recursive: true, force: true })
  if (!ok) throw new Error(`the new release did not come up:\n${output.trim().split('\n').slice(-20).join('\n')}`)
}

function pruneReleases(keep) {
  if (!existsSync(P.releases)) return
  for (const name of readdirSync(P.releases)) {
    const dir = join(P.releases, name)
    if (keep.includes(dir)) continue
    log(`removing old release ${name}`)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Replace the launcher with the one in `dir` when it differs. Safe while running: Node has it in memory. */
function refreshLauncher(dir) {
  const source = join(dir, 'bin', 'domo.mjs')
  if (!existsSync(source)) return
  if (existsSync(P.launcher) && readFileSync(source, 'utf8') === readFileSync(P.launcher, 'utf8')) return
  const tmp = `${P.launcher}.new`
  cpSync(source, tmp)
  renameSync(tmp, P.launcher)
  log('launcher updated; it is used from the next start of the service')
}

async function update(args) {
  const checkOnly = args.includes('--check')
  const channelFlag = args.indexOf('--channel')
  const channel = channelFlag >= 0 ? args[channelFlag + 1] : readState().channel
  if (!channel) fail('--channel needs a branch name')
  if (!existsSync(join(P.app, '.git'))) fail(`${P.app} is not a git checkout; run the installer`)
  if (channelFlag >= 0) writeState({ channel })

  const check = updateCheck(channel)
  if (checkOnly) {
    if (!check.behind) console.log(`up to date with ${channel} (${check.installed.slice(0, 7)})`)
    else console.log(`${check.behind} commit${check.behind === 1 ? '' : 's'} behind ${channel}:\n  ${check.commits.join('\n  ')}`)
    return
  }
  if (!check.behind && !args.includes('--force') && currentRelease()) {
    console.log(`up to date with ${channel} (${check.installed.slice(0, 7)})`)
    return
  }

  const releaseLock = takeUpdateLock()
  const env = serverEnv()
  const started = Date.now()
  try {
    const dir = await buildRelease(check.target, env)
    await smokeTest(dir, env)
    const old = currentRelease()
    if (old && old !== dir) relink(P.previous, old)
    relink(P.current, dir)
    writeState({ channel, lastAppliedAt: new Date().toISOString() })
    pruneReleases([dir, old].filter(Boolean))
    refreshLauncher(dir)
    log(`current is now ${check.target.slice(0, 7)} (${Math.round((Date.now() - started) / 1000)}s)`)
    if (!args.includes('--no-restart')) {
      if (supervisorPid()) restart()
      else log('the service is not running; start it with `domo start`')
    }
  } finally {
    releaseLock()
  }
}

// --------------------------------------------------------------------------
// install: the part of the installer that is not downloading binaries
// --------------------------------------------------------------------------

async function install(args) {
  const channel = (args.indexOf('--channel') >= 0 ? args[args.indexOf('--channel') + 1] : null) || readState().channel
  writeState({ channel })
  for (const [what, file] of [['Node', P.node], ['pnpm', P.pnpm], ['Caddy', P.caddy], ['the checkout', join(P.app, '.git')]]) {
    if (!existsSync(file)) fail(`${what} is missing at ${file}; run scripts/install.sh`)
  }
  mkdirSync(P.bin, { recursive: true })
  mkdirSync(P.data, { recursive: true })
  mkdirSync(P.logs, { recursive: true })
  if (!existsSync(P.env)) {
    cpSync(join(P.app, '.env.example'), P.env)
    log(`wrote ${P.env}; add your keys there or in Settings`)
  }
  if (!existsSync(P.launcher)) cpSync(fileURLToPath(import.meta.url), P.launcher)

  await update(['--no-restart', '--force', ...(channel ? ['--channel', channel] : [])])

  if (!args.includes('--skip-trust')) {
    log('caddy trust (so the browser accepts the local certificate; this may ask for your password)')
    const trust = sh(P.caddy, ['trust'], { stdio: 'inherit' })
    if (!trust.ok) log('caddy trust failed; the browser will warn about the certificate until you run `caddy trust`')
  }

  serviceStart()
  const env = serverEnv()
  const ok = await healthy(env, HEALTH_TIMEOUT_MS)
  const url = `https://${env.DOMO_HTTPS_ADDRESS}`
  if (!ok) fail(`Domo did not come up within a minute; see ${P.log}`)
  console.log(`\n  Domo is running at ${url}\n`)
  if (!args.includes('--no-open')) sh(platform() === 'darwin' ? 'open' : 'xdg-open', [url])
}

// --------------------------------------------------------------------------

const HELP = `domo <command>

  run                 run Domo in the foreground (what the service runs)
  start | stop        start or stop the login service
  restart             restart the server onto the current release
  status              what is installed and whether it answers
  logs                follow the log
  update [--check] [--channel <branch>] [--force] [--no-restart]
                      fetch, build and switch to the newest commit of the channel
  install             finish an installation (used by scripts/install.sh)
  uninstall           remove the login service (keeps ${HOME})

Environment: DOMO_HOME (${HOME}). Settings live in ${P.env}.`

const [command, ...args] = process.argv.slice(2)
try {
  switch (command) {
    case 'run': await run(); break
    case 'start': serviceStart(); break
    case 'stop': serviceStop(); break
    case 'restart': restart(); break
    case 'status': await status(); break
    case 'logs': logs(); break
    case 'update': await update(args); break
    case 'install': await install(args); break
    case 'uninstall': serviceUninstall(); break
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); break
    default: fail(`unknown command "${command}"\n\n${HELP}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

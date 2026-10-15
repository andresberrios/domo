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
import { createHash } from 'node:crypto'
import {
  cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { arch, homedir, platform, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HOME = resolve(process.env.DOMO_HOME || join(homedir(), '.domo'))
/**
 * Where releases are published: a GitHub repository's releases, read without
 * an account. `<feed>/latest/download/manifest.json` is the newest release,
 * `<feed>/download/v<version>/<file>` its files. DOMO_FEED, kept in
 * `state.json` by `domo install`, points a test install at a local server.
 */
const DEFAULT_FEED = 'https://github.com/andresberrios/domo-releases/releases'
const P = {
  // The git checkout installs before 2026-10 built from. Kept only while a
  // release built from it is still `current` or `previous`.
  app: join(HOME, 'app'),
  releases: join(HOME, 'releases'),
  // The coding agents, one install per lockfile, shared by the releases that pin it.
  agents: join(HOME, 'agents'),
  current: join(HOME, 'current'),
  previous: join(HOME, 'previous'),
  nodeDir: join(HOME, 'node'),
  node: join(HOME, 'node', 'bin', 'node'),
  caddy: join(HOME, 'bin', 'caddy'),
  uv: join(HOME, 'bin', 'uv'),
  caddySocket: join(HOME, 'caddy.sock'),
  bin: join(HOME, 'bin'),
  launcher: join(HOME, 'bin', 'domo.mjs'),
  data: join(HOME, 'data'),
  env: join(HOME, '.env'),
  logs: join(HOME, 'logs'),
  log: join(HOME, 'logs', 'domo.log'),
  supervisorPid: join(HOME, 'supervisor.pid'),
  updateLock: join(HOME, 'update.lock'),
  updateFailed: join(HOME, 'update-failed.json'),
  // The server writes this before it stops when it wants to come back on
  // `current`; the supervisor reads and removes it. See RESTART_EXIT_CODE.
  restartRequested: join(HOME, 'restart-requested'),
  state: join(HOME, 'state.json')
}

/**
 * The server exits with this when it wants the supervisor to start it again
 * from `current`. Nitro's own shutdown always exits 0, so the server usually
 * asks with the `restart-requested` file instead and stops normally.
 */
export const RESTART_EXIT_CODE = 75
/**
 * The login service's name. launchd and systemd are per user, not per home,
 * so an install in any home but the default one gets its own name, from its
 * path: a test install's `install`, `stop` or `uninstall` never reaches the
 * real one's service.
 */
const SERVICE_SUFFIX = HOME === resolve(homedir(), '.domo') ? '' : createHash('sha256').update(HOME).digest('hex').slice(0, 8)
const SERVICE_LABEL = SERVICE_SUFFIX ? `com.domo.app.${SERVICE_SUFFIX}` : 'com.domo.app'
const SYSTEMD_UNIT = SERVICE_SUFFIX ? `domo-${SERVICE_SUFFIX}` : 'domo'
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

/**
 * `KEY=value` lines of `.env`, without touching what the caller already has.
 * An install has none: the launcher's defaults below are all it needs, and
 * people set Domo up in the app. A developer may add one to override them.
 */
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
  // Caddy's admin API, on a socket of this install's own: what `domo trust` asks
  // for the root certificate.
  env.DOMO_CADDY_ADMIN ||= `unix/${P.caddySocket}`
  env.NUXT_DATA_DIR ||= P.data
  // Not `domo-dev-`, which `pnpm dev` uses, nor a prefix of it: the leftover
  // report attributes by prefix, and both may run on one daemon.
  env.NUXT_DEV_ENV_RESOURCE_PREFIX ||= 'domo-prod-'
  // The production stack's ports (docker-compose.prod.yml), not the development stack's.
  env.DATABASE_URL ||= 'postgresql://postgres:password@localhost:54322/domo'
  env.ELECTRIC_URL ||= 'http://localhost:30002'
  env.NODE_ENV = 'production'
  // Nitro waits this long for open connections on SIGTERM. Electric's shape
  // long-polls are always open, so the default thirty seconds is a restart
  // that takes thirty seconds; the browser reconnects anyway.
  env.NITRO_SHUTDOWN_TIMEOUT ||= '5000'
  return env
}

/** Where a release link points, or null. */
function linked(link) {
  try {
    return realpathSync(link)
  } catch {
    return null
  }
}

function currentRelease() {
  return linked(P.current)
}

function releaseInfo(dir) {
  return dir ? readJson(join(dir, 'build.json'), { commit: basename(dir) }) : null
}

/** A release's name: its version, or the commit of one built from a git checkout. */
function releaseId(info) {
  return info ? (info.version ?? info.commit) : null
}

/** A commit is shown short; a version as it is. */
function label(id) {
  return /^[0-9a-f]{40}$/.test(id ?? '') ? id.slice(0, 7) : id
}

/** Built from the git checkout by an earlier launcher: a worktree, so it has a `.git` file. */
function isCheckoutRelease(dir) {
  return existsSync(join(dir, '.git'))
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
// The bundled tools: Node, Caddy and uv at the versions a release's
// `.tool-versions` names, so a release can move any of them.
// --------------------------------------------------------------------------

function toolVersions(dir) {
  const out = {}
  for (const line of readFileSync(join(dir, '.tool-versions'), 'utf8').split('\n')) {
    const [tool, version] = line.trim().split(/\s+/)
    if (tool && version && !tool.startsWith('#')) out[tool] = version
  }
  return out
}

function installedVersion(file, args, pattern) {
  if (!existsSync(file)) return null
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 20_000 })
  return result.status === 0 ? (result.stdout.match(pattern)?.[1] ?? null) : null
}

/** Stream `url` into `file`; with `sha256`, fail unless the bytes match it. */
async function download(url, file, sha256 = null) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`)
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(file))
  const actual = hash.digest('hex')
  if (sha256 && actual !== sha256) throw new Error(`${basename(file)} does not match its checksum (expected ${sha256}, got ${actual}); not installing it`)
}

function untar(file, dir, ...args) {
  const result = spawnSync('tar', ['-xzf', file, '-C', dir, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tar ${file}: ${(result.stderr || '').trim()}`)
}

/**
 * Each tool fetched only when its version differs from the pin. Node is
 * replaced as a directory swap: the launcher that runs on the old one keeps
 * its binary's inode until it exits, and the next server starts on the new.
 * uv is optional (Pocket TTS), so its failure is a line, not an error.
 */
async function ensureTools(dir) {
  const wanted = toolVersions(dir)
  const os = platform() === 'darwin' ? 'darwin' : 'linux'
  const cpu = arch() === 'arm64' ? 'arm64' : 'x64'
  const tmp = mkdtempSync(join(tmpdir(), 'domo-tools-'))
  mkdirSync(P.bin, { recursive: true })
  try {
    if (wanted.nodejs && installedVersion(P.node, ['-v'], /v(\S+)/) !== wanted.nodejs) {
      log(`downloading Node ${wanted.nodejs}`)
      const tgz = join(tmp, 'node.tgz')
      await download(`https://nodejs.org/dist/v${wanted.nodejs}/node-v${wanted.nodejs}-${os}-${cpu}.tar.gz`, tgz)
      const fresh = `${P.nodeDir}.new`
      rmSync(fresh, { recursive: true, force: true })
      mkdirSync(fresh, { recursive: true })
      untar(tgz, fresh, '--strip-components=1')
      const old = `${P.nodeDir}.old`
      rmSync(old, { recursive: true, force: true })
      if (existsSync(P.nodeDir)) renameSync(P.nodeDir, old)
      renameSync(fresh, P.nodeDir)
      rmSync(old, { recursive: true, force: true })
    }
    if (wanted.caddy && installedVersion(P.caddy, ['version'], /v?(\d+\.\d+\.\d+)/) !== wanted.caddy) {
      log(`downloading Caddy ${wanted.caddy}`)
      const tgz = join(tmp, 'caddy.tgz')
      await download(`https://github.com/caddyserver/caddy/releases/download/v${wanted.caddy}/caddy_${wanted.caddy}_${os === 'darwin' ? 'mac' : 'linux'}_${cpu === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`, tgz)
      untar(tgz, tmp, 'caddy')
      cpSync(join(tmp, 'caddy'), P.caddy)
    }
    if (wanted.uv && installedVersion(P.uv, ['--version'], /uv (\S+)/) !== wanted.uv) {
      try {
        log(`downloading uv ${wanted.uv} (for the Pocket TTS voice; optional)`)
        const triple = `${cpu === 'arm64' ? 'aarch64' : 'x86_64'}-${os === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
        const tgz = join(tmp, 'uv.tgz')
        await download(`https://github.com/astral-sh/uv/releases/download/${wanted.uv}/uv-${triple}.tar.gz`, tgz)
        untar(tgz, tmp)
        for (const name of ['uv', 'uvx']) cpSync(join(tmp, `uv-${triple}`, name), join(P.bin, name))
      } catch (error) {
        log(`uv could not be installed (${error.message}); Pocket TTS will say so if you pick it`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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

  // Read again at every server start, so `domo restart` picks up an edit to `.env`.
  let env = serverEnv()
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
    env = serverEnv()
    const release = currentRelease()
    const info = releaseInfo(release)
    log(`starting ${label(releaseId(info)) ?? '?'} (built ${info?.builtAt ?? '?'})`)
    const candidate = restartRequested
    restartRequested = false
    const child = spawn(P.node, [join(release, '.output', 'server', 'index.mjs')], { env, stdio: 'inherit', cwd: release })
    server = child
    let exited = null
    const exit = new Promise(r => child.on('exit', (code, signal) => r((exited = { code, signal }))))
    child.on('error', error => log(`server failed to start: ${error.message}`))

    const ok = await healthy(env, HEALTH_TIMEOUT_MS, () => exited !== null || stopping)
    if (ok) {
      crashes = 0
      rolledBack = false
      log(`up at http://127.0.0.1:${env.PORT}`)
      // A later release that comes up clears the record; the one that was
      // rolled back to must not, or the failure is never seen.
      const failed = readJson(P.updateFailed)
      if (failed && failed.release !== basename(release) && failed.rolledBackTo !== basename(release)) rmSync(P.updateFailed, { force: true })
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
    if (existsSync(P.restartRequested)) {
      rmSync(P.restartRequested, { force: true })
      restartRequested = true
    }
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

/**
 * Postgres and Electric, from the release's production compose file: its own
 * project, volume and ports, never the development stack's. Failure is
 * reported in the UI, not here.
 */
async function composeUp(env) {
  const release = currentRelease()
  const file = join(release, 'docker-compose.prod.yml')
  if (!existsSync(file)) return
  log('docker compose -f docker-compose.prod.yml up -d')
  const result = spawnSync('docker', ['compose', '-f', file, 'up', '-d'], { env, encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) log(`compose failed: ${(result.stderr || result.error?.message || '').trim().split('\n').pop()}`)
}

// --------------------------------------------------------------------------
// Service management (launchd on macOS, systemd --user on Linux)
// --------------------------------------------------------------------------

function servicePaths() {
  if (platform() === 'darwin') {
    return { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`), domain: `gui/${userInfo().uid}` }
  }
  return { kind: 'systemd', file: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${SYSTEMD_UNIT}.service`) }
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
    const result = sh('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
    if (!result.ok) fail(`systemctl: ${result.err}`)
  }
  log(`service started (${service.kind})`)
}

function serviceStop() {
  const service = servicePaths()
  if (service.kind === 'launchd') sh('launchctl', ['bootout', `${service.domain}/${SERVICE_LABEL}`])
  else sh('systemctl', ['--user', 'stop', SYSTEMD_UNIT])
  const pid = supervisorPid()
  if (pid) process.kill(pid, 'SIGTERM')
  log('service stopped')
}

function serviceUninstall() {
  serviceStop()
  const service = servicePaths()
  if (service.kind === 'systemd') sh('systemctl', ['--user', 'disable', SYSTEMD_UNIT])
  rmSync(service.file, { force: true })
  if (service.kind === 'systemd') sh('systemctl', ['--user', 'daemon-reload'])
  const project = { ...readDotenv(), ...process.env }.COMPOSE_PROJECT_NAME || 'domo-prod'
  console.log(`Domo no longer starts at login. Its files are still in ${HOME}; remove that directory to delete them.\nPostgres and Electric are still in Docker: \`docker compose -p ${project} down\` stops them, add \`-v\` to delete the database.`)
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
  console.log(`release    ${release ? `${label(releaseId(info))} (built ${info?.builtAt ?? '?'})` : 'none'}`)
  console.log(`feed       ${feed()}`)
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
  return readJson(P.state, {})
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

function feed() {
  return (process.env.DOMO_FEED || readDotenv().DOMO_FEED || readState().feed || DEFAULT_FEED).replace(/\/+$/, '')
}

function platformKey() {
  return `${platform() === 'darwin' ? 'darwin' : 'linux'}-${arch() === 'arm64' ? 'arm64' : 'x64'}`
}

/** The newest release: its version, a build per platform, and the releases before it with their commits. */
async function fetchManifest() {
  const url = `${feed()}/latest/download/manifest.json`
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const manifest = await response.json()
  if (manifest?.schema !== 1 || typeof manifest.version !== 'string') throw new Error(`${url} is not a Domo release manifest`)
  return manifest
}

/**
 * Where the install stands against the newest release. `behind` counts the
 * commits of the releases in between, from the manifest's history; null is
 * "an update, count unknown": the installed one is older than the history, or
 * it was built from git, which always moves onto a release, even of its own
 * commit.
 */
async function updateCheck() {
  const manifest = await fetchManifest()
  const release = currentRelease()
  const info = releaseInfo(release)
  const installed = releaseId(info)
  const fromCheckout = Boolean(release && isCheckoutRelease(release))
  const result = { installed, target: manifest.version, behind: 0, commits: [], manifest }
  if (installed === manifest.version && !fromCheckout) return result
  const history = Array.isArray(manifest.history) ? manifest.history : []
  const at = history.findIndex(entry => entry.version === installed || (fromCheckout && entry.commit === info.commit))
  const newer = at >= 0 ? history.slice(0, at) : []
  result.commits = newer.flatMap(entry => entry.commits ?? [])
  result.behind = result.commits.length || null
  return result
}

/**
 * Download the manifest's build for this platform into releases/<version>,
 * check it against the manifest's checksum, and unpack it beside the running
 * one. It is renamed into place whole, so a release directory with
 * `build.json` is always complete.
 */
async function fetchRelease(manifest) {
  const dir = join(P.releases, manifest.version)
  if (existsSync(join(dir, 'build.json'))) {
    log(`release ${manifest.version} is already downloaded`)
    return dir
  }
  const artifact = manifest.artifacts?.[platformKey()]
  if (!artifact) throw new Error(`release ${manifest.version} has no build for ${platformKey()}`)
  mkdirSync(P.releases, { recursive: true })
  const tmp = mkdtempSync(join(P.releases, '.download-'))
  try {
    const file = join(tmp, artifact.file)
    log(`downloading ${artifact.file} (${Math.round(artifact.size / 1e6)} MB)`)
    await download(`${feed()}/download/v${manifest.version}/${artifact.file}`, file, artifact.sha256)
    const into = join(tmp, 'release')
    mkdirSync(into)
    untar(file, into, '--strip-components=1')
    if (!existsSync(join(into, 'build.json'))) throw new Error(`${artifact.file} holds no build.json`)
    removeRelease(dir)
    renameSync(into, dir)
    return dir
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function removeRelease(dir) {
  if (!existsSync(dir)) return
  const worktree = isCheckoutRelease(dir) && existsSync(P.app)
  if (worktree) git(['worktree', 'remove', '--force', dir], { lenient: true })
  rmSync(dir, { recursive: true, force: true })
  if (worktree) git(['worktree', 'prune'], { lenient: true })
}

/** The git checkout of an older install, once no release kept for rollback was built from it. */
function forgetCheckout() {
  if (!existsSync(P.app)) return
  if (readdirSync(P.releases).some(name => isCheckoutRelease(join(P.releases, name)))) return
  log(`removing ${P.app}: releases are downloaded now, not built from git`)
  rmSync(P.app, { recursive: true, force: true })
}

// --------------------------------------------------------------------------
// The coding agents: installed apart from the app, since they are most of the
// weight and change far less often. A release carries only their pins
// (`agents/package.json` and its lockfile); every release that pins the same
// ones shares one install, `agents/<the lockfile's hash>`, which the release's
// `node_modules` links to and the server resolves the adapters through.
// --------------------------------------------------------------------------

/** The name of the agents' install a release pins, or null for one that carries its own (built from git). */
function agentsKey(dir) {
  const lock = join(dir, 'agents', 'package-lock.json')
  return existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 16) : null
}

function runStep(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? done() : reject(new Error(`${basename(command)} ${args.slice(0, 2).join(' ')} exited ${code}`))))
  })
}

/**
 * Install the agents `dir` pins, unless an earlier release already did, and
 * link the release's `node_modules` to them. `npm ci` from the lockfile, with
 * the bundled Node's npm: every package is checked against the lockfile's
 * integrity hash, and the lockfile came in the checked tarball. No package's
 * install script runs but OpenCode's, which places its binary for this
 * machine. Built beside and renamed into place, then each agent is started
 * once, so an install directory with `.installed` is always whole.
 */
async function ensureAgents(dir) {
  const key = agentsKey(dir)
  if (!key) return
  const target = join(P.agents, key)
  if (!existsSync(join(target, '.installed'))) {
    log(`installing the coding agents (${key}); this downloads them once, not on every update`)
    mkdirSync(P.agents, { recursive: true })
    const tmp = mkdtempSync(join(P.agents, '.install-'))
    try {
      for (const file of ['package.json', 'package-lock.json']) cpSync(join(dir, 'agents', file), join(tmp, file))
      const env = { ...process.env, PATH: `${dirname(P.node)}:${process.env.PATH || '/usr/bin:/bin'}`, npm_config_update_notifier: 'false' }
      const npm = join(P.nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      await runStep(P.node, [npm, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--cache', join(tmp, '.npm')], { cwd: tmp, env })
      rmSync(join(tmp, '.npm'), { recursive: true, force: true })
      const opencode = join(tmp, 'node_modules', '@opencode', 'cli')
      if (existsSync(join(opencode, 'postinstall.mjs'))) {
        await runStep(P.node, ['postinstall.mjs'], { cwd: opencode, env })
        // It copied its platform's binary into `bin`; the platform package is a second copy.
        for (const name of readdirSync(dirname(opencode)).filter(n => n.startsWith('cli-'))) rmSync(join(dirname(opencode), name), { recursive: true, force: true })
      }
      // npm installs the musl builds beside the glibc ones (it does not read
      // `libc`); a release runs on glibc only.
      for (const scope of ['@anthropic-ai', '@github', '@openai']) {
        const dir = join(tmp, 'node_modules', scope)
        for (const name of existsSync(dir) ? readdirSync(dir).filter(n => /musl/.test(n)) : []) rmSync(join(dir, name), { recursive: true, force: true })
      }
      checkAgents(tmp)
      writeFileSync(join(tmp, '.installed'), new Date().toISOString())
      rmSync(target, { recursive: true, force: true })
      renameSync(tmp, target)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  relink(join(dir, 'node_modules'), relative(dir, join(target, 'node_modules')))
}

/** Each agent's CLI starts on this machine: the platform packages are there and run. */
function checkAgents(dir) {
  const os = platform() === 'darwin' ? 'darwin' : 'linux'
  const cpu = arch() === 'arm64' ? 'arm64' : 'x64'
  const modules = join(dir, 'node_modules')
  const commands = [
    [P.node, join(modules, '@openai', 'codex', 'bin', 'codex.js')],
    [join(modules, '@opencode', 'cli', 'bin', 'opencode.exe')],
    [join(modules, '@github', `copilot-${os}-${cpu}`, 'copilot')],
    [join(modules, '@anthropic-ai', `claude-agent-sdk-${os}-${cpu}`, 'claude')]
  ]
  for (const [command, ...args] of commands) {
    const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 60_000 })
    if (result.status !== 0) throw new Error(`${[command, ...args].pop()} --version failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n').pop()}`)
  }
}

/** Agents' installs no kept release pins. */
function pruneAgents() {
  if (!existsSync(P.agents)) return
  const pinned = new Set(readdirSync(P.releases).map(name => agentsKey(join(P.releases, name))).filter(Boolean))
  for (const name of readdirSync(P.agents)) {
    if (pinned.has(name)) continue
    log(`removing agents ${name}, which no kept release uses`)
    rmSync(join(P.agents, name), { recursive: true, force: true })
  }
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
  const child = spawn(P.node, [join(dir, '.output', 'server', 'index.mjs')], { env: testEnv, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
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
  // By real path: on macOS /tmp is /private/tmp, and `current` resolves to the latter.
  const kept = keep.map(dir => realpathSync(dir))
  for (const name of readdirSync(P.releases)) {
    const dir = join(P.releases, name)
    if (kept.includes(realpathSync(dir))) continue
    log(`removing old release ${name}`)
    removeRelease(dir)
  }
}

/** Replace the launcher with the one in `dir` when it differs. Safe while running: Node has it in memory. */
function refreshLauncher(dir) {
  const source = join(dir, 'bin', 'domo.mjs')
  if (!existsSync(source)) return false
  if (existsSync(P.launcher) && readFileSync(source, 'utf8') === readFileSync(P.launcher, 'utf8')) return false
  const tmp = `${P.launcher}.new`
  cpSync(source, tmp)
  renameSync(tmp, P.launcher)
  return true
}

/** Restart the whole service, supervisor included: what a new launcher needs. */
function serviceRestart() {
  const service = servicePaths()
  if (!supervisorPid()) return serviceStart()
  if (service.kind === 'launchd') {
    const result = sh('launchctl', ['kickstart', '-k', `${service.domain}/${SERVICE_LABEL}`])
    if (!result.ok) fail(`launchctl kickstart: ${result.err}`)
  } else {
    const result = sh('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    if (!result.ok) fail(`systemctl restart: ${result.err}`)
  }
  log('service restarted')
}

async function update(args) {
  const checkOnly = args.includes('--check')
  const json = args.includes('--json')
  // `--channel` is still accepted from a server that passes it; there is one feed.
  const check = await updateCheck()
  const { manifest, ...summary } = check
  if (checkOnly) {
    if (json) console.log(JSON.stringify({ channel: 'release', ...summary }))
    else if (check.behind === 0) console.log(`up to date (${label(check.installed)})`)
    else if (check.behind === null) console.log(`${check.target} is out (installed: ${label(check.installed) ?? 'nothing'})`)
    else console.log(`${check.target} is out, ${check.behind} commit${check.behind === 1 ? '' : 's'} newer:\n  ${check.commits.map(c => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n  ')}`)
    return
  }
  if (check.behind === 0 && !args.includes('--force') && currentRelease()) {
    console.log(`up to date (${label(check.installed)})`)
    return
  }

  const releaseLock = takeUpdateLock()
  const env = serverEnv()
  const started = Date.now()
  try {
    rmSync(P.updateFailed, { force: true })
    const dir = await fetchRelease(manifest)
    const old = currentRelease()
    try {
      await ensureTools(dir)
      await ensureAgents(dir)
      await smokeTest(dir, env)
    } catch (error) {
      // Not kept: the next attempt downloads it again rather than trust it.
      if (![old, linked(P.previous)].includes(realpathSync(dir))) removeRelease(dir)
      throw error
    }
    if (old && old !== realpathSync(dir)) relink(P.previous, old)
    relink(P.current, dir)
    writeState({ lastAppliedAt: new Date().toISOString() })
    pruneReleases([dir, old].filter(Boolean))
    pruneAgents()
    forgetCheckout()
    const launcherChanged = refreshLauncher(dir)
    log(`current is now ${manifest.version} (${Math.round((Date.now() - started) / 1000)}s)`)
    if (!args.includes('--no-restart')) {
      if (!supervisorPid()) log('the service is not running; start it with `domo start`')
      // The supervisor runs the launcher it started with, so a new one needs
      // the service restarted, Caddy and all; otherwise only the server.
      else if (launcherChanged) serviceRestart()
      else restart()
    }
  } finally {
    releaseLock()
  }
}

// --------------------------------------------------------------------------
// install: the part of the installer that is not downloading binaries
// --------------------------------------------------------------------------

async function install(args) {
  // The service starts without the installer's environment, so a feed it was given is kept.
  if (process.env.DOMO_FEED) writeState({ feed: process.env.DOMO_FEED })
  mkdirSync(P.bin, { recursive: true })
  mkdirSync(P.data, { recursive: true })
  mkdirSync(P.logs, { recursive: true })
  if (!existsSync(P.launcher)) cpSync(fileURLToPath(import.meta.url), P.launcher)

  // The installer brought Node, which this runs on; the update brings the
  // release and the tools its `.tool-versions` names, as every update does.
  await update(['--no-restart', '--force'])
  if (args.includes('--no-service')) {
    console.log(`\n  Installed. Start Domo with \`${P.bin}/domo run\` (no login service was installed).\n`)
    return
  }

  serviceStart()
  const env = serverEnv()
  const ok = await healthy(env, HEALTH_TIMEOUT_MS)
  const url = `https://${env.DOMO_HTTPS_ADDRESS}`
  if (!ok) fail(`Domo did not come up within a minute; see ${P.log}`)
  // After the start: the certificate is made by the running server, and it is
  // the running server `caddy trust` asks for it.
  if (!args.includes('--skip-trust')) trust()
  console.log(`\n  Domo is running at ${url}\n`)
  if (!args.includes('--no-open')) sh(platform() === 'darwin' ? 'open' : 'xdg-open', [url])
}

/**
 * Install Caddy's root certificate into the system trust stores, so the browser
 * accepts `https://localhost`. Asks for the password: macOS and Linux both
 * guard their stores. Needs the service running, which holds the certificate.
 */
function trust() {
  if (!supervisorPid()) fail('the service is not running; start it with `domo start`, then run `domo trust`')
  log('caddy trust (so the browser accepts the local certificate; this may ask for your password)')
  const result = sh(P.caddy, ['trust', '--address', serverEnv().DOMO_CADDY_ADMIN], { stdio: 'inherit' })
  if (!result.ok) log('caddy trust failed; the browser will warn about the certificate until `domo trust` succeeds')
}

// --------------------------------------------------------------------------

const HELP = `domo <command>

  run                 run Domo in the foreground (what the service runs)
  start | stop        start or stop the login service
  restart             restart the server onto the current release
  status              what is installed and whether it answers
  trust               make the browser accept the local certificate (asks for your password)
  logs                follow the log
  update [--check] [--json] [--force] [--no-restart]
                      download the newest release and switch to it
  install [--no-service] [--skip-trust] [--no-open]
                      finish an installation (used by scripts/install.sh)
  uninstall           remove the login service (keeps ${HOME})

Environment: DOMO_HOME (${HOME}). Domo is set up in the app; \`domo status\` shows its address.`

const [command, ...args] = process.argv.slice(2)
try {
  switch (command) {
    case 'run': await run(); break
    case 'start': serviceStart(); break
    case 'stop': serviceStop(); break
    case 'restart': restart(); break
    case 'status': await status(); break
    case 'trust': trust(); break
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

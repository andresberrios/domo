#!/usr/bin/env node
// Builds a release of Domo on this Mac for all four platforms and publishes
// it, ending with the release live. See docs/install-and-updates.md.
//
//   pnpm release:publish [--ref <commit>] [--platforms darwin-arm64,linux-x64,…]
//                        [--jobs 2] [--no-publish] [--repo owner/name]
//
// 1. The commit is --ref, by default the tip of origin/main. It must be on
//    origin/main, and origin's `release` must be behind it, so the push at the
//    end only moves `release` forward.
// 2. It is exported with `git archive`, never built from this working tree.
// 3. Each platform builds in a copy of its own: darwin-arm64 on an arm64 Node,
//    darwin-x64 on an x64 Node under Rosetta (pnpm installed through it, so
//    every native package is x64), the two Linux ones in a `node` container of
//    their architecture (linux/amd64 through Docker Desktop's emulation).
// 4. The manifest builds on the latest published one.
// 5. The release is published with `gh`, on the gh login of whoever runs this:
//    a draft, every file uploaded, then marked latest.
// 6. Only then is `release` pushed. An install built from git learns of the
//    new launcher through `release`, and every install reads the feed, so the
//    feed has the release before `release` names its commit.
//
// Every step is skipped when it is already done, so after a failure the same
// command picks up where it stopped: built platforms are kept under
// ~/.cache/domo-release/<version> (DOMO_RELEASE_WORK), a draft is uploaded to
// again rather than made twice, and a release already live is not touched.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_DIR = resolve(import.meta.dirname, '..')
const PLATFORMS = ['linux-x64', 'darwin-x64', 'linux-arm64', 'darwin-arm64']

function option(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : fallback
}

function say(message) {
  console.log(`\x1b[1m==>\x1b[0m ${message}`)
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() || result.error?.message || '' }
}

function must(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} exited ${result.status ?? result.error?.message}`)
}

function git(...args) {
  const result = sh('git', ['-C', REPO_DIR, ...args])
  if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.err}`)
  return result.out
}

/** Run a step with its output in a log file; rejects with the log's tail. */
function logged(command, args, log, options = {}) {
  return new Promise((done, reject) => {
    const fd = openSync(log, 'a')
    const child = spawn(command, args, { ...options, stdio: [options.stdin ?? 'ignore', options.stdout ?? fd, fd] })
    closeSync(fd)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return done()
      const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-15).join('\n')
      reject(new Error(`${command} ${args.slice(0, 2).join(' ')} exited ${code}; ${log}:\n${tail}`))
    })
  })
}

function minutes(ms) {
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

// --------------------------------------------------------------------------

const repo = option('--repo', process.env.DOMO_RELEASES_REPO || 'andresberrios/domo-releases')
const publish = !process.argv.includes('--no-publish')
const platforms = option('--platforms', PLATFORMS.join(',')).split(',').map(p => p.trim()).filter(Boolean)
const jobs = Math.max(1, Number(option('--jobs', '2')))
for (const key of platforms) if (!PLATFORMS.includes(key)) fail(`unknown platform ${key}; one of ${PLATFORMS.join(', ')}`)
if (publish && platforms.length !== PLATFORMS.length) fail('a published release has every platform; use --no-publish to build only some')

say('Fetching origin')
git('fetch', '--quiet', 'origin')
const commit = git('rev-parse', '--verify', `${option('--ref', 'origin/main')}^{commit}`)
if (!sh('git', ['-C', REPO_DIR, 'merge-base', '--is-ancestor', commit, 'origin/main']).ok) {
  fail(`${commit.slice(0, 7)} is not on origin/main; merge and push it first`)
}
const releaseTip = sh('git', ['-C', REPO_DIR, 'rev-parse', '--verify', '--quiet', 'origin/release']).out
if (releaseTip && !sh('git', ['-C', REPO_DIR, 'merge-base', '--is-ancestor', releaseTip, commit]).ok) {
  fail(`origin/release (${releaseTip.slice(0, 7)}) is not behind ${commit.slice(0, 7)}, so it could not be moved forward to it`)
}

// The commit's facts, from the release script as of that commit.
const script = sh('git', ['-C', REPO_DIR, 'show', `${commit}:scripts/release.mjs`])
if (!script.ok) fail(`${commit.slice(0, 7)} has no scripts/release.mjs`)
const scratch = mkdtempSync(join(tmpdir(), 'domo-release-'))
writeFileSync(join(scratch, 'release.mjs'), `${script.out}\n`)
const asked = sh(process.execPath, [join(scratch, 'release.mjs'), 'info'], { env: { ...process.env, DOMO_RELEASE_GIT_DIR: REPO_DIR, DOMO_RELEASE_REF: commit } })
rmSync(scratch, { recursive: true, force: true })
if (!asked.ok) fail(`could not read ${commit.slice(0, 7)}'s release facts: ${asked.err}`)
const info = JSON.parse(asked.out)
const version = info.version
const tag = `v${version}`
say(`Domo ${version} (${commit.slice(0, 7)} ${info.subject})`)

if (publish) {
  if (!sh('gh', ['auth', 'status']).ok) fail('gh is not logged in: run `gh auth login`')
}
const live = publish && sh('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft']).out === 'false'

const work = join(process.env.DOMO_RELEASE_WORK || join(homedir(), '.cache', 'domo-release'), version)
const dist = join(work, 'dist')
const logs = join(work, 'logs')
mkdirSync(dist, { recursive: true })
mkdirSync(logs, { recursive: true })

// An export of exactly the commit, and the env that tells a build without git
// which commit it is.
const sourceTar = join(work, 'src.tar')
if (!existsSync(sourceTar)) {
  must('git', ['-C', REPO_DIR, 'archive', '--format=tar', '-o', `${sourceTar}.tmp`, commit])
  renameSync(`${sourceTar}.tmp`, sourceTar)
}
const releaseEnv = {
  DOMO_RELEASE_COMMIT: info.commit,
  DOMO_RELEASE_VERSION: info.version,
  DOMO_RELEASE_DATE: info.date,
  DOMO_RELEASE_EPOCH: info.epoch,
  DOMO_RELEASE_SUBJECT: info.subject
}
const tools = Object.fromEntries(sh('git', ['-C', REPO_DIR, 'show', `${commit}:.tool-versions`]).out.split('\n')
  .map(line => line.trim().split(/\s+/)).filter(([name, value]) => name && value && !name.startsWith('#')))

const tarball = key => join(dist, `domo-${version}-${key}.tar.gz`)

/** The official Node for os-cpu, kept under the work directory's parent. */
async function nodeFor(os, cpu) {
  const dir = join(work, '..', 'tools', `node-${tools.nodejs}-${os}-${cpu}`)
  if (existsSync(join(dir, 'bin', 'node'))) return dir
  const tgz = `${dir}.tar.gz`
  mkdirSync(dir, { recursive: true })
  must('curl', ['-fsSL', '-o', tgz, `https://nodejs.org/dist/v${tools.nodejs}/node-v${tools.nodejs}-${os}-${cpu}.tar.gz`])
  must('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'])
  rmSync(tgz, { force: true })
  return dir
}

/**
 * A Mac build: an export of its own with the Node of its architecture and
 * pnpm installed through that Node, so pnpm and every postinstall see that
 * architecture. On Apple silicon an x64 Node runs under Rosetta.
 */
async function buildMac(cpu, log) {
  if (platform() !== 'darwin' || arch() !== 'arm64') throw new Error('the macOS builds need an Apple silicon Mac')
  if (cpu === 'x64' && !sh('arch', ['-x86_64', '/usr/bin/true']).ok) {
    throw new Error('darwin-x64 builds under Rosetta, which is not installed: softwareupdate --install-rosetta --agree-to-license')
  }
  const node = await nodeFor('darwin', cpu)
  const pnpmDir = join(work, '..', 'tools', `pnpm-${tools.pnpm}-darwin-${cpu}`)
  const path = `${join(pnpmDir, 'bin')}:${join(node, 'bin')}:${process.env.PATH}`
  if (!existsSync(join(pnpmDir, 'bin', 'pnpm'))) {
    await logged(join(node, 'bin', 'npm'), ['install', '--global', '--prefix', pnpmDir, `pnpm@${tools.pnpm}`], log, { env: { ...process.env, PATH: path } })
  }
  const src = join(work, `src-darwin-${cpu}`)
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src)
  must('tar', ['-xf', sourceTar, '-C', src])
  const env = { ...process.env, ...releaseEnv, PATH: path, CI: '1' }
  await logged('pnpm', ['install', '--frozen-lockfile'], log, { cwd: src, env })
  await logged('node', ['scripts/release.mjs', 'build', '--out', join(src, 'out'), '--platform', `darwin-${cpu}`], log, { cwd: src, env })
  renameSync(join(src, 'out', `domo-${version}-darwin-${cpu}.tar.gz`), tarball(`darwin-${cpu}`))
  rmSync(src, { recursive: true, force: true })
}

/**
 * A Linux build, in the official `node` image of its architecture, with the
 * export on its stdin and the built tarball on its stdout: nothing is mounted
 * from this machine but a pnpm store volume of the build's own.
 */
async function buildLinux(cpu, log) {
  const out = join(work, `out-linux-${cpu}.tar`)
  const script = [
    'set -e',
    'mkdir -p /src /out',
    'tar -x -C /src',
    'cd /src',
    `npm install --global --silent pnpm@${tools.pnpm} >&2`,
    'pnpm install --frozen-lockfile --store-dir /pnpm-store >&2',
    `node scripts/release.mjs build --out /out --platform linux-${cpu} >&2`,
    `tar -c -C /out domo-${version}-linux-${cpu}.tar.gz`
  ].join('\n')
  const env = Object.entries({ ...releaseEnv, CI: '1' }).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const stdin = openSync(sourceTar, 'r')
  const stdout = openSync(out, 'w')
  try {
    await logged('docker', [
      'run', '--rm', '-i', '--platform', `linux/${cpu === 'x64' ? 'amd64' : 'arm64'}`,
      '-v', `domo-release-pnpm-${cpu}:/pnpm-store`, ...env,
      `node:${tools.nodejs}-bookworm`, 'sh', '-c', script
    ], log, { stdin, stdout })
  } finally {
    closeSync(stdin)
    closeSync(stdout)
  }
  must('tar', ['-xf', out, '-C', dist])
  rmSync(out, { force: true })
}

// --------------------------------------------------------------------------

const todo = live ? [] : platforms.filter(key => !existsSync(tarball(key)))
if (live) say(`${tag} is already live on ${repo}`)
else if (todo.length < platforms.length) say(`Already built: ${platforms.filter(key => !todo.includes(key)).join(', ')}`)
if (todo.some(key => key.startsWith('linux')) && !sh('docker', ['info']).ok) fail('Docker is not running; the Linux builds run in containers')

const started = Date.now()
const times = {}
const queue = [...todo]
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const key = queue.shift()
    const [os, cpu] = key.split('-')
    const log = join(logs, `${key}.log`)
    rmSync(log, { force: true })
    say(`Building ${key} (log: ${log})`)
    const at = Date.now()
    try {
      await (os === 'darwin' ? buildMac(cpu, log) : buildLinux(cpu, log))
    } catch (error) {
      fail(`${key}: ${error.message}`)
    }
    times[key] = Date.now() - at
    say(`${key} built in ${minutes(times[key])}`)
  }
}))
if (todo.length) say(`Built ${todo.join(', ')} in ${minutes(Date.now() - started)}`)

if (!publish) {
  say(`Built, not published: ${dist}`)
  process.exit(0)
}

if (!live) {
  // The manifest from this commit's release script, on the latest one published.
  const previous = join(work, 'previous.json')
  rmSync(previous, { force: true })
  const download = sh('gh', ['release', 'download', '--repo', repo, '--pattern', 'manifest.json', '--output', previous])
  if (!download.ok && !/release not found|no assets/i.test(download.err)) fail(`could not read the latest manifest: ${download.err}`)
  // This release is not its own predecessor.
  if (existsSync(previous) && JSON.parse(readFileSync(previous, 'utf8')).version === version) rmSync(previous)
  const src = join(work, 'src-manifest')
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src)
  must('tar', ['-xf', sourceTar, '-C', src])
  must(process.execPath, [join(src, 'scripts', 'release.mjs'), 'manifest', '--out', dist, ...(existsSync(previous) ? ['--previous', previous] : [])], {
    env: { ...process.env, DOMO_RELEASE_GIT_DIR: REPO_DIR, DOMO_RELEASE_REF: commit }
  })
  rmSync(src, { recursive: true, force: true })

  const notes = join(work, 'notes.md')
  writeFileSync(notes, `${git('log', '-1', '--format=%s%n%n%b', commit)}\n`)
  const files = ['manifest.json', 'SHA256SUMS', 'domo.mjs', 'install.sh', ...readdirSync(dist).filter(name => name.startsWith(`domo-${version}-`) && name.endsWith('.tar.gz'))]
    .map(name => join(dist, name))
  // A draft until every file is up: installs follow `latest`, which must never lack one.
  if (sh('gh', ['release', 'view', tag, '--repo', repo]).ok) {
    say(`Uploading to the draft ${tag}`)
    must('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...files])
  } else {
    say(`Creating the draft ${tag} on ${repo}`)
    must('gh', ['release', 'create', tag, '--repo', repo, '--title', `Domo ${version}`, '--notes-file', notes, '--draft', ...files])
  }
  must('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  say(`${tag} is live: https://github.com/${repo}/releases/tag/${tag}`)
}

// Last: an install built from git takes the new launcher from `release`.
if (releaseTip === commit) {
  say(`origin/release is already ${commit.slice(0, 7)}`)
} else {
  say(`Pushing ${commit.slice(0, 7)} to origin/release`)
  must('git', ['-C', REPO_DIR, 'push', 'origin', `${commit}:refs/heads/release`])
}
say(`Done: Domo ${version} is released`)

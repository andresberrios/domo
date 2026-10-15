#!/usr/bin/env node
// Builds Domo's release artifacts: what an installed Domo downloads, with no
// source in it. See docs/install-and-updates.md.
//
//   node scripts/release.mjs version            the version of HEAD
//   node scripts/release.mjs build [--out dist] [--skip-build] [--platform <os>-<arch>]
//       dist/domo-<version>-<os>-<arch>.tar.gz for the machine it runs on
//       (the Node it runs on: an x64 Node under Rosetta builds darwin-x64);
//       --platform fails the build when that is not the platform named
//   node scripts/release.mjs manifest [--out dist] [--previous manifest.json]
//       dist/manifest.json, SHA256SUMS, domo.mjs and install.sh beside the tarballs
//   node scripts/release.mjs serve [--out dist] [--port 8765]
//       serve dist the way GitHub Releases does, for an install to test against
//       (DOMO_FEED=http://localhost:8765)
//
// A tarball holds one directory, `domo/`: the built server and client
// (`.output`, without source maps, which carry the source), the launcher, the
// Caddyfile, the production compose file, `.tool-versions`, `build.json` and
// `agents/`, the coding agents' package.json and lockfile. The agents
// themselves are not in it: the launcher installs them from npm into a
// directory of their own, shared by every release that pins the same ones
// (bin/domo.mjs, `ensureAgents()`). `.output` traces sharp and the ONNX
// runtime for this machine, so each platform is built on its own
// (.github/workflows/release.yml).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
/** How many releases the manifest remembers, for the changelog of an install that is several behind. */
const HISTORY = 100
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.error?.message}`)
  return result
}

/**
 * The repository and commit being released: this checkout's HEAD, or, for
 * `scripts/publish-release.mjs`, which builds from an export of a commit, the
 * repository it came from and that commit. A build with no git at all (in a
 * container) is told the commit's facts instead (`DOMO_RELEASE_COMMIT` and the
 * rest, as `info` prints them).
 */
const GIT_DIR = process.env.DOMO_RELEASE_GIT_DIR || ROOT
const REF = process.env.DOMO_RELEASE_REF || 'HEAD'

function git(...args) {
  return spawnSync('git', ['-C', GIT_DIR, ...args], { encoding: 'utf8' }).stdout.trim()
}

function option(args, name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * The commit's hash, subject, date and the version named after it:
 * `2026.10.15-ab18e19`, its UTC date and short hash, so every build of one
 * commit agrees.
 */
function commitInfo() {
  const env = process.env
  if (env.DOMO_RELEASE_COMMIT) {
    return { commit: env.DOMO_RELEASE_COMMIT, version: env.DOMO_RELEASE_VERSION, date: env.DOMO_RELEASE_DATE, epoch: env.DOMO_RELEASE_EPOCH, subject: env.DOMO_RELEASE_SUBJECT }
  }
  const [commit, short, epoch, date, subject] = git('log', '-1', '--abbrev=7', '--format=%H%x1f%h%x1f%ct%x1f%cI%x1f%s', REF).split('\x1f')
  if (!commit) throw new Error(`no commit ${REF} in ${GIT_DIR}`)
  const d = new Date(Number(epoch) * 1000)
  return { commit, version: `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}-${short}`, date, epoch, subject }
}

function platformKey() {
  return `${platform() === 'darwin' ? 'darwin' : 'linux'}-${arch() === 'arm64' ? 'arm64' : 'x64'}`
}

/**
 * Nitro keeps two versions of one package (zod 4.6.5 and 4.6.7, say) under
 * `node_modules/.nitro/<name>@<version>` and links to them by absolute path,
 * into the directory it built in: on any other machine those links point
 * nowhere. Each becomes a relative link inside the copy; one that leads out
 * of `.output` is an error.
 */
function relativeLinks(built, copy) {
  // As Nitro saw it, which on macOS may be /private/var where this sees /var.
  const roots = [built, realpathSync(built)]
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        if (!isAbsolute(target)) continue
        const inside = roots.map(root => relative(root, target)).find(rest => !rest.startsWith('..') && !isAbsolute(rest))
        if (inside === undefined) throw new Error(`${relative(copy, path)} links out of .output, to ${target}`)
        rmSync(path)
        symlinkSync(relative(dirname(path), join(copy, inside)), path)
      } else if (stat.isDirectory()) {
        walk(path)
      }
    }
  }
  walk(copy)
}

/**
 * Start `.output` where no `node_modules` is above it, against no database,
 * and require the app shell: it must run on what it carries. A package it
 * only found by resolving upward (once the agents' zod) would be found in a
 * release only while the agents' install happens to have it.
 */
async function selfContained(stage) {
  const dir = mkdtempSync(join(tmpdir(), 'domo-release-check-'))
  cpSync(join(stage, '.output'), join(dir, '.output'), { recursive: true, verbatimSymlinks: true })
  const port = String(40_000 + Math.floor(Math.random() * 10_000))
  const child = spawn(process.execPath, [join(dir, '.output', 'server', 'index.mjs')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: port, HOST: '127.0.0.1', DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/none', ELECTRIC_URL: 'http://127.0.0.1:1', NUXT_DATA_DIR: join(dir, 'data') }
  })
  let output = ''
  child.stdout.on('data', d => (output += d))
  child.stderr.on('data', d => (output += d))
  let exited = false
  child.on('exit', () => (exited = true))
  let ok = false
  for (let i = 0; i < 60 && !exited && !ok; i++) {
    await new Promise(r => setTimeout(r, 500))
    ok = await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok, () => false)
  }
  child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
  if (!ok) throw new Error(`.output does not run on its own:\n${output.trim().split('\n').slice(-12).join('\n')}`)
}

async function build(args) {
  const out = resolve(option(args, '--out', 'dist'))
  const expected = option(args, '--platform', null)
  if (expected && expected !== platformKey()) throw new Error(`asked for ${expected}, but this Node is ${platformKey()}`)
  const { version: v, commit, date, epoch, subject } = commitInfo()
  if (!args.includes('--skip-build')) run('pnpm', ['build'], { env: { ...process.env, DOMO_RELEASE_BUILD: '1', DOMO_BUILD_ID: commit } })
  if (!existsSync(join(ROOT, '.output', 'server', 'index.mjs'))) throw new Error('no .output: run pnpm build')

  const stage = join(out, 'stage', 'domo')
  rmSync(join(out, 'stage'), { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  // Source maps embed the source they map.
  cpSync(join(ROOT, '.output'), join(stage, '.output'), { recursive: true, verbatimSymlinks: true, filter: src => !src.endsWith('.map') })
  relativeLinks(join(ROOT, '.output'), join(stage, '.output'))

  // This platform's native packages only: the ONNX runtime ships every one's.
  const [os, cpu] = platformKey().split('-')
  const onnx = join(stage, '.output', 'server', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
  for (const dir of existsSync(onnx) ? readdirSync(onnx) : []) {
    for (const sub of readdirSync(join(onnx, dir))) if (dir !== os || sub !== cpu) rmSync(join(onnx, dir, sub), { recursive: true, force: true })
  }
  if (!existsSync(join(stage, '.output', 'server', 'node_modules', '@img', `sharp-${os}-${cpu}`))) {
    throw new Error(`.output has no sharp for ${platformKey()}; it was built for another platform`)
  }

  // The agents' pins. A lockfile that does not match its package.json would
  // fail `npm ci` on every machine that installs the release.
  const agents = JSON.parse(readFileSync(join(ROOT, 'agents', 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(ROOT, 'agents', 'package-lock.json'), 'utf8'))
  if (JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(agents.dependencies)) {
    throw new Error('agents/package-lock.json is out of date: run `npm install --package-lock-only` in agents/')
  }
  mkdirSync(join(stage, 'agents'))
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(ROOT, 'agents', file), join(stage, 'agents', file))
  // The server resolves the adapters from its working directory's package.json;
  // the launcher links `node_modules` beside it to the agents' install.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'domo', version: v, private: true, type: 'module', license: pkg.license }, null, 2)}\n`)

  mkdirSync(join(stage, 'bin'))
  cpSync(join(ROOT, 'bin', 'domo.mjs'), join(stage, 'bin', 'domo.mjs'))
  for (const file of ['Caddyfile', 'docker-compose.prod.yml', 'LICENSE.md']) cpSync(join(ROOT, file), join(stage, file))
  // A release builds nothing, so it needs no pnpm.
  const tools = readFileSync(join(ROOT, '.tool-versions'), 'utf8').split('\n').filter(line => line && !line.startsWith('pnpm '))
  writeFileSync(join(stage, '.tool-versions'), `${tools.join('\n')}\n`)
  const nodeVersion = tools.find(line => line.startsWith('nodejs '))?.split(/\s+/)[1]
  writeFileSync(join(stage, 'build.json'), `${JSON.stringify({
    version: v, commit, subject, builtAt: date, nodeVersion, platform: platformKey()
  }, null, 2)}\n`)

  await selfContained(stage)

  const file = join(out, `domo-${v}-${platformKey()}.tar.gz`)
  // GNU tar can make the archive byte-for-byte reproducible; bsdtar (macOS) cannot sort.
  const tar = ['gtar', 'tar'].find(name => spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar'))
  const flags = tar ? ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner'] : []
  run(tar ?? 'tar', ['-C', join(out, 'stage'), ...flags, '-cf', file.replace(/\.gz$/, ''), 'domo'])
  rmSync(file, { force: true })
  // -n: no name or time in the gzip header.
  run('gzip', ['-n', file.replace(/\.gz$/, '')])
  rmSync(join(out, 'stage'), { recursive: true, force: true })
  console.log(`${file} (${Math.round(statSync(file).size / 1e6)} MB)`)
}

/**
 * The manifest an install reads: the newest version, a build per platform,
 * and the history of releases with the commits each brought, newest first,
 * so an install several releases behind can list what it would get.
 */
function manifest(args) {
  const out = resolve(option(args, '--out', 'dist'))
  const previousFile = option(args, '--previous', null)
  const previous = previousFile && existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null
  const { version: v, commit, date } = commitInfo()

  const artifacts = {}
  for (const name of readdirSync(out).filter(n => n.startsWith(`domo-${v}-`) && n.endsWith('.tar.gz'))) {
    const key = name.slice(`domo-${v}-`.length, -'.tar.gz'.length)
    artifacts[key] = { file: name, sha256: sha256(join(out, name)), size: statSync(join(out, name)).size }
  }
  if (!Object.keys(artifacts).length) throw new Error(`no domo-${v}-*.tar.gz in ${out}`)

  // The commits since the previous release; without one, or after a rewrite
  // of the branch, only this one.
  const since = previous?.commit && spawnSync('git', ['-C', GIT_DIR, 'merge-base', '--is-ancestor', previous.commit, commit]).status === 0
    ? [`${previous.commit}..${commit}`]
    : ['-1', commit]
  const commits = git('log', '--format=%H%x1f%s%x1f%aI', ...since).split('\n').filter(Boolean).map((line) => {
    const [sha, subject, at] = line.split('\x1f')
    return { sha, subject, date: at }
  })
  const history = [{ version: v, commit, date, commits }, ...(previous?.history ?? []).filter(entry => entry.version !== v)].slice(0, HISTORY)

  cpSync(join(ROOT, 'bin', 'domo.mjs'), join(out, 'domo.mjs'))
  cpSync(join(ROOT, 'scripts', 'install.sh'), join(out, 'install.sh'))
  const node = readFileSync(join(ROOT, '.tool-versions'), 'utf8').match(/^nodejs\s+(\S+)/m)?.[1]
  // One key per line at the top: install.sh reads `version`, `node` and
  // `launcherSha256` with sed, before it has a Node to parse JSON with.
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({
    schema: 1, version: v, commit, date, node, launcherSha256: sha256(join(out, 'domo.mjs')), artifacts, history
  }, null, 2)}\n`)
  const sums = ['domo.mjs', 'install.sh', 'manifest.json', ...Object.values(artifacts).map(a => a.file)]
  writeFileSync(join(out, 'SHA256SUMS'), sums.map(name => `${sha256(join(out, name))}  ${name}\n`).join(''))
  console.log(`${join(out, 'manifest.json')}: ${v}, ${Object.keys(artifacts).join(', ')}, ${commits.length} commit(s)`)
}

/**
 * `/latest/download/<file>` and `/download/v<version>/<file>`, both from the
 * one release in `--out`: the two kinds of URL an install asks for.
 */
function serve(args) {
  const out = resolve(option(args, '--out', 'dist'))
  const port = Number(option(args, '--port', '8765'))
  createServer((req, res) => {
    const match = /^\/(?:latest\/download|download\/v[^/]+)\/([^/?]+)/.exec(req.url ?? '')
    const file = match && join(out, decodeURIComponent(match[1]))
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end()
    } else {
      res.writeHead(200, { 'content-length': statSync(file).size })
      createReadStream(file).pipe(res)
    }
    console.log(res.statusCode, req.url)
  }).listen(port, () => console.log(`serving ${out} at http://localhost:${port}`))
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'version': console.log(commitInfo().version); break
  case 'info': console.log(JSON.stringify(commitInfo())); break
  case 'build': await build(args); break
  case 'manifest': manifest(args); break
  case 'serve': serve(args); break
  default:
    console.error('usage: node scripts/release.mjs version | build [--out dist] [--skip-build] | manifest [--out dist] [--previous file] | serve [--out dist] [--port 8765]')
    process.exit(1)
}

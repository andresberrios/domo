#!/usr/bin/env node
// Builds Domo's release artifacts: what an installed Domo downloads, with no
// source in it. See docs/install-and-updates.md.
//
//   node scripts/release.mjs version            the version of HEAD
//   node scripts/release.mjs build [--out dist] [--skip-build]
//       dist/domo-<version>-<os>-<arch>.tar.gz for the machine it runs on
//   node scripts/release.mjs manifest [--out dist] [--previous manifest.json]
//       dist/manifest.json, SHA256SUMS, domo.mjs and install.sh beside the tarballs
//   node scripts/release.mjs serve [--out dist] [--port 8765]
//       serve dist the way GitHub Releases does, for an install to test against
//       (DOMO_FEED=http://localhost:8765)
//
// A tarball holds one directory, `domo/`: the built server and client
// (`.output`, without source maps, which carry the source), a `node_modules`
// with only the packages the server resolves from its working directory (the
// ACP adapters and the coding-agent binaries they run, which Nitro's tracing
// does not carry), the launcher, the Caddyfile, the production compose file,
// `.tool-versions` and `build.json`. Native packages are this machine's, so
// each platform is built on its own (.github/workflows/release.yml).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
/** Resolved from the server's working directory at run time (`adapterEntry()`, `codexBinary()`). */
const RUNTIME_PACKAGES = ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp', '@openai/codex', '@opencode/cli']
/** How many releases the manifest remembers, for the changelog of an install that is several behind. */
const HISTORY = 100

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.error?.message}`)
  return result
}

function git(...args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
}

function option(args, name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** `2026.10.15-ab18e19`: the commit's UTC date and short hash, so every job that builds one commit agrees. */
function version() {
  const [sha, epoch] = git('log', '-1', '--format=%h %ct', '--abbrev=7').split(' ')
  const d = new Date(Number(epoch) * 1000)
  return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}-${sha}`
}

function platformKey() {
  return `${platform() === 'darwin' ? 'darwin' : 'linux'}-${arch() === 'arm64' ? 'arm64' : 'x64'}`
}

function build(args) {
  const out = resolve(option(args, '--out', 'dist'))
  const v = version()
  const commit = git('rev-parse', 'HEAD')
  const date = git('log', '-1', '--format=%cI')
  if (!args.includes('--skip-build')) run('pnpm', ['build'], { env: { ...process.env, DOMO_RELEASE_BUILD: '1', DOMO_BUILD_ID: commit } })
  if (!existsSync(join(ROOT, '.output', 'server', 'index.mjs'))) throw new Error('no .output: run pnpm build')

  const stage = join(out, 'stage', 'domo')
  rmSync(join(out, 'stage'), { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  // Source maps embed the source they map.
  cpSync(join(ROOT, '.output'), join(stage, '.output'), { recursive: true, filter: src => !src.endsWith('.map') })

  // The runtime packages at the versions the lockfile installed, from the
  // same lockfile, so their dependencies resolve as they do in development.
  // Hoisted: plain directories, which is what a tarball and `createRequire`
  // from the working directory both want.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const dependencies = Object.fromEntries(RUNTIME_PACKAGES.map(name => [
    name, JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version
  ]))
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'domo', version: v, private: true, type: 'module', license: pkg.license, dependencies }, null, 2)}\n`)
  cpSync(join(ROOT, 'pnpm-lock.yaml'), join(stage, 'pnpm-lock.yaml'))
  cpSync(join(ROOT, 'pnpm-workspace.yaml'), join(stage, 'pnpm-workspace.yaml'))
  run('pnpm', [
    'install', '--prod', '--no-frozen-lockfile', '--config.node-linker=hoisted',
    '--config.enable-global-virtual-store=false', '--config.confirm-modules-purge=false'
  ], { cwd: stage, env: { ...process.env, CI: '1' } })
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', join('node_modules', '.modules.yaml'), join('node_modules', '.pnpm-workspace-state-v1.json')]) {
    rmSync(join(stage, file), { force: true })
  }
  // OpenCode's postinstall copied its platform's binary into `@opencode/cli/bin`;
  // the platform package it came from would be a second copy of 200 MB.
  if (!existsSync(join(stage, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'))) throw new Error('OpenCode\'s postinstall did not place its binary')
  for (const name of readdirSync(join(stage, 'node_modules', '@opencode')).filter(n => n.startsWith('cli-'))) {
    rmSync(join(stage, 'node_modules', '@opencode', name), { recursive: true, force: true })
  }

  mkdirSync(join(stage, 'bin'))
  cpSync(join(ROOT, 'bin', 'domo.mjs'), join(stage, 'bin', 'domo.mjs'))
  for (const file of ['Caddyfile', 'docker-compose.prod.yml', 'LICENSE.md']) cpSync(join(ROOT, file), join(stage, file))
  // A release builds nothing, so it needs no pnpm.
  const tools = readFileSync(join(ROOT, '.tool-versions'), 'utf8').split('\n').filter(line => line && !line.startsWith('pnpm '))
  writeFileSync(join(stage, '.tool-versions'), `${tools.join('\n')}\n`)
  const nodeVersion = tools.find(line => line.startsWith('nodejs '))?.split(/\s+/)[1]
  writeFileSync(join(stage, 'build.json'), `${JSON.stringify({
    version: v, commit, subject: git('log', '-1', '--format=%s'), builtAt: date, nodeVersion, platform: platformKey()
  }, null, 2)}\n`)

  const file = join(out, `domo-${v}-${platformKey()}.tar.gz`)
  // GNU tar can make the archive byte-for-byte reproducible; bsdtar (macOS) cannot sort.
  const tar = ['gtar', 'tar'].find(name => spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar'))
  const epoch = git('log', '-1', '--format=%ct')
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
  const v = version()
  const commit = git('rev-parse', 'HEAD')
  const date = git('log', '-1', '--format=%cI')

  const artifacts = {}
  for (const name of readdirSync(out).filter(n => n.startsWith(`domo-${v}-`) && n.endsWith('.tar.gz'))) {
    const key = name.slice(`domo-${v}-`.length, -'.tar.gz'.length)
    artifacts[key] = { file: name, sha256: sha256(join(out, name)), size: statSync(join(out, name)).size }
  }
  if (!Object.keys(artifacts).length) throw new Error(`no domo-${v}-*.tar.gz in ${out}`)

  // The commits since the previous release; without one, or after a rewrite
  // of the branch, only this one.
  const since = previous?.commit && spawnSync('git', ['merge-base', '--is-ancestor', previous.commit, commit], { cwd: ROOT }).status === 0
    ? `${previous.commit}..${commit}`
    : '-1'
  const commits = git('log', '--format=%H%x1f%s%x1f%aI', since).split('\n').filter(Boolean).map((line) => {
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
  case 'version': console.log(version()); break
  case 'build': build(args); break
  case 'manifest': manifest(args); break
  case 'serve': serve(args); break
  default:
    console.error('usage: node scripts/release.mjs version | build [--out dist] [--skip-build] | manifest [--out dist] [--previous file] | serve [--out dist] [--port 8765]')
    process.exit(1)
}

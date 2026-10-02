import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const LAUNCHER = join(process.cwd(), 'bin', 'domo.mjs')
const COMPOSE_FILE = join(process.cwd(), 'docker-compose.yml')

/**
 * `domo run` with a fake `docker` on the PATH that writes down every call and
 * answers what it is asked. Postgres holds the data, so the supervisor must
 * never hand it to compose once it exists: compose recreates a container whose
 * config changed, and treats every container of the project's name as its own.
 */
describe('the supervisor and the compose stack', () => {
  let home: string
  let dockerLog: string

  beforeEach(async () => {
    // The real path: the supervisor resolves `current` and logs that.
    home = await realpath(await mkdtemp(join(tmpdir(), 'domo-launcher-')))
    dockerLog = join(home, 'docker.log')
    const release = join(home, 'releases', 'r1')
    await mkdir(join(release, '.output', 'server'), { recursive: true })
    await mkdir(join(home, 'bin'), { recursive: true })
    await mkdir(join(home, 'node', 'bin'), { recursive: true })
    await symlink(release, join(home, 'current'))
    await symlink(process.execPath, join(home, 'node', 'bin', 'node'))
    await writeFile(join(release, 'build.json'), JSON.stringify({ commit: 'abc', builtAt: '2026-10-02T00:00:00Z' }))
    await writeFile(join(release, 'docker-compose.yml'), await readFile(COMPOSE_FILE))
    await writeFile(join(release, 'Caddyfile'), '')
    await writeFile(join(release, '.output', 'server', 'index.mjs'), [
      'import { createServer } from "node:http"',
      'createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1")',
      'process.on("SIGTERM", () => process.exit(0))'
    ].join('\n'))
    await writeFile(join(home, 'bin', 'caddy'), '#!/bin/sh\nexec sleep 300\n')
    await writeFile(join(home, 'bin', 'docker'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$DOMO_TEST_DOCKER_LOG"',
      'case "$1 $2" in',
      '  "container inspect") [ -e "$DOMO_TEST_POSTGRES_EXISTS" ] && exit 0 || exit 1 ;;',
      '  "inspect --format") echo healthy ;;',
      'esac',
      'exit 0'
    ].join('\n'))
    await chmod(join(home, 'bin', 'caddy'), 0o755)
    await chmod(join(home, 'bin', 'docker'), 0o755)
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number }
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }

  /** Runs the supervisor until the stack is up, then stops it; the docker calls it made, one per line. */
  async function dockerCallsOfARun(): Promise<string[]> {
    const port = await freePort()
    const child = spawn(process.execPath, [LAUNCHER, 'run'], {
      env: {
        ...process.env,
        DOMO_HOME: home,
        DOMO_PORT: String(port),
        SHELL: '/bin/sh',
        DOMO_TEST_DOCKER_LOG: dockerLog,
        DOMO_TEST_POSTGRES_EXISTS: join(home, 'postgres-exists')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))
    try {
      await expect.poll(() => output, { timeout: 20_000, interval: 100 }).toMatch(/up at http/)
    } finally {
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(r => setTimeout(r, 10_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    return (await readFile(dockerLog, 'utf8')).trim().split('\n')
  }

  it('creates Postgres with compose only when there is none, and never recreates it', async () => {
    const calls = await dockerCallsOfARun()
    const compose = calls.filter(call => call.startsWith('compose '))
    expect(compose).toEqual([
      `compose -f ${join(home, 'releases', 'r1', 'docker-compose.yml')} up -d --no-recreate postgres`,
      `compose -f ${join(home, 'releases', 'r1', 'docker-compose.yml')} up -d --no-deps electric`
    ])
    expect(calls).not.toContainEqual(expect.stringMatching(/^(start|stop|rm|restart) /))
  })

  it('only starts a Postgres that exists, and leaves compose to Electric alone', async () => {
    await writeFile(join(home, 'postgres-exists'), '')
    const calls = await dockerCallsOfARun()
    expect(calls).toContain('start domo-postgres-1')
    expect(calls.filter(call => call.startsWith('compose '))).toEqual([
      `compose -f ${join(home, 'releases', 'r1', 'docker-compose.yml')} up -d --no-deps electric`
    ])
    expect(calls).not.toContainEqual(expect.stringMatching(/\bpostgres$/))
    expect(calls).not.toContainEqual(expect.stringMatching(/^(stop|rm|restart|down) /))
  })

  it('names the container after the compose project the installation chose', async () => {
    await writeFile(join(home, '.env'), 'COMPOSE_PROJECT_NAME=domo-inst\n')
    await writeFile(join(home, 'postgres-exists'), '')
    const calls = await dockerCallsOfARun()
    expect(calls).toContain('container inspect domo-inst-postgres-1')
    expect(calls).toContain('start domo-inst-postgres-1')
  })
})

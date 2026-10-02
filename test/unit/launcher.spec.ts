import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const LAUNCHER = join(process.cwd(), 'bin', 'domo.mjs')

/**
 * `domo run` with a fake `docker` on the PATH that writes down every call. The
 * stack an installed Domo runs is the production one: the development stack
 * on the same machine holds the developer's data and tests, and once the two
 * met under one project name.
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
    await writeFile(join(release, 'docker-compose.yml'), await readFile(join(process.cwd(), 'docker-compose.yml')))
    await writeFile(join(release, 'docker-compose.prod.yml'), await readFile(join(process.cwd(), 'docker-compose.prod.yml')))
    await writeFile(join(release, 'Caddyfile'), '')
    await writeFile(join(release, '.output', 'server', 'index.mjs'), [
      'import { createServer } from "node:http"',
      'createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1")',
      'process.on("SIGTERM", () => process.exit(0))'
    ].join('\n'))
    await writeFile(join(home, 'bin', 'caddy'), '#!/bin/sh\nexec sleep 300\n')
    await writeFile(join(home, 'bin', 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOMO_TEST_DOCKER_LOG"\n')
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

  /** Runs the supervisor until the server is up, then stops it; the docker calls it made, one per line. */
  async function dockerCallsOfARun(): Promise<string[]> {
    const port = await freePort()
    const child = spawn(process.execPath, [LAUNCHER, 'run'], {
      env: { ...process.env, DOMO_HOME: home, DOMO_PORT: String(port), SHELL: '/bin/sh', DOMO_TEST_DOCKER_LOG: dockerLog },
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

  it('brings up the production stack from its own compose file, and touches no other', async () => {
    expect(await dockerCallsOfARun()).toEqual([
      `compose -f ${join(home, 'releases', 'r1', 'docker-compose.prod.yml')} up -d`
    ])
  })
})

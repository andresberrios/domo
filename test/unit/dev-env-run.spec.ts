import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('run with a signal', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'domo-run-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // The Dev Container CLI runs `docker build` as its own child; stopping only
  // the CLI would leave the build going.
  it('stops what the command started too, and rejects with the reason', async () => {
    const pidFile = join(dir, 'pid')
    const controller = new AbortController()
    const running = run('sh', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'sh', pidFile], { signal: controller.signal })
    running.catch(() => {})
    const pid = await vi.waitFor(async () => Number((await readFile(pidFile, 'utf8')).trim()) || Promise.reject(new Error('no pid')))
    expect(alive(pid)).toBe(true)

    controller.abort(new Error('retired'))

    await expect(running).rejects.toThrow('retired')
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
  })

  it('never starts once already stopped', async () => {
    const controller = new AbortController()
    controller.abort(new Error('retired'))
    await expect(run('sh', ['-c', `touch "${join(dir, 'ran')}"`], { signal: controller.signal })).rejects.toThrow('retired')
    await expect(readFile(join(dir, 'ran'))).rejects.toThrow()
  })
})

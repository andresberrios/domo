import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUBBLEWRAP_SYSCALLS, ensureSeccompProfile, environmentSeccompProfile } from '../../server/lib/dev-env/seccomp'
import dockerDefault from '../../server/lib/dev-env/seccomp-docker-default.json'

/**
 * Docker's default seccomp profile, plus exactly what bubblewrap needs for
 * Codex's sandbox. That it works is the agents-live layer's to prove (Codex
 * reading in `read-only` without asking); this pins that nothing else is added.
 */
describe('the environment seccomp profile', () => {
  let dir = ''
  afterEach(async () => {
    delete process.env.NUXT_DATA_DIR
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('is Docker\'s default with one rule added, for the five calls bubblewrap makes', () => {
    const profile = environmentSeccompProfile()

    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO')
    expect(profile.syscalls.slice(0, -1)).toEqual(dockerDefault.syscalls)
    expect(profile.syscalls.at(-1)).toEqual({ names: BUBBLEWRAP_SYSCALLS, action: 'SCMP_ACT_ALLOW' })
    expect(BUBBLEWRAP_SYSCALLS).toEqual(['clone', 'mount', 'pivot_root', 'umount2', 'unshare'])
  })

  it('is written once, as a file named by its content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'domo-seccomp-'))
    process.env.NUXT_DATA_DIR = dir

    const path = await ensureSeccompProfile()

    expect(path).toMatch(/\/seccomp\/environment-[0-9a-f]{12}\.json$/)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(environmentSeccompProfile())
    await expect(ensureSeccompProfile()).resolves.toBe(path)
  })
})

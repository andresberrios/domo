import { describe, expect, it } from 'vitest'

import { query } from '../../server/lib/db'
import {
  createAgentSession,
  createDevEnvironmentRow,
  createProject,
  environmentInstallsMayRun,
  getDockerDisk,
  saveDockerDisk
} from '../../server/lib/repo'

/** The `docker_disk` row and the question the cache cleanup asks before it prunes, against a real Postgres. */

describe('docker_disk', () => {
  it('keeps one row, its sizes as numbers and its caches as written', async () => {
    expect(await getDockerDisk()).toBeNull()
    const disk = {
      totalBytes: 62_671_097_856,
      freeBytes: 8_321_499_136,
      level: 'low' as const,
      caches: [{ key: 'pnpm-store', label: 'pnpm package store', bytes: 6_227_000_000, reclaimable: 2_630_000_000 }],
      docker: [{ type: 'Images', bytes: 5_300_000_000, reclaimable: 2_100_000_000 }],
      reclaimableBytes: 2_630_000_000,
      measuredAt: '2026-10-14T21:00:00.000Z',
      checkedAt: '2026-10-14T21:00:00.000Z',
      cleaning: false,
      lastCleanupAt: null,
      lastCleanupLevel: null,
      lastFreedBytes: null,
      lastError: null
    }
    await saveDockerDisk(disk)
    await saveDockerDisk({ ...disk, cleaning: true, lastCleanupLevel: 'pressure', lastFreedBytes: 1_500_000_000 })

    const row = await getDockerDisk()
    expect(row).toMatchObject({ ...disk, cleaning: true, lastCleanupLevel: 'pressure', lastFreedBytes: 1_500_000_000 })
    expect((await query('select count(*)::int as n from docker_disk'))[0].n).toBe(1)
  })
})

describe('environmentInstallsMayRun', () => {
  it('is true while an environment is being created or an agent in one is mid-turn, and only then', async () => {
    const project = await createProject({ name: 'p', repoPath: '/srv/p' })
    const environment = await createDevEnvironmentRow({ projectId: project.id, name: 'e', containerName: 'c', workspacePath: '/workspaces/p' })
    // A new row is `creating`.
    expect(await environmentInstallsMayRun()).toBe(true)

    await query(`update dev_environments set status = 'running' where id = $1`, [environment.id])
    const host = await createAgentSession({ adapter: 'claude-code', title: 'on the host', cwd: '/srv/p' })
    await query(`update agent_sessions set status = 'thinking' where id = $1`, [host.id])
    expect(await environmentInstallsMayRun()).toBe(false)

    const inside = await createAgentSession({ adapter: 'claude-code', title: 'inside', cwd: '/workspaces/p', devEnvironmentId: environment.id })
    await query(`update agent_sessions set status = 'thinking' where id = $1`, [inside.id])
    expect(await environmentInstallsMayRun()).toBe(true)
  })
})

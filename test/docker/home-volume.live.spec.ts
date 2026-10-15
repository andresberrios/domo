import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { homeSnapshotName, migrateHome } from '../../server/lib/dev-env/home-volume'
import { homeVolumeName } from '../../server/lib/dev-env/leftovers'

/**
 * An environment another Domo made bind-mounts that Domo's proxy socket, which
 * is gone by the time this one upgrades it. Reading a stopped container mounts
 * its binds again, and that one fails (`mkdirat …: file exists`), so the home
 * has to come out of a snapshot. The binds are under the checkout so that,
 * inside an environment, the proxy can resolve them.
 */

const IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
const environmentId = `env_live${randomBytes(6).toString('hex')}`
const name = `domo-homelive-${environmentId}`
const HOME = '/home/vscode'
let scratch = ''

beforeAll(async () => {
  process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-homelive-'
  await run('docker', ['image', 'inspect', IMAGE]).catch(() => run('docker', ['pull', IMAGE]))
  scratch = await mkdtemp(join(resolve('.'), '.home-live-'))
  await writeFile(join(scratch, 'proxy.sock'), '')
  await mkdir(join(scratch, 'ssh'))
  await writeFile(join(scratch, 'ssh', 'id_ed25519'), 'the developer\'s key\n')
  await run('docker', [
    'run', '--name', name, '--label', `domo.envId=${environmentId}`,
    '--volume', `${join(scratch, 'proxy.sock')}:/run/docker-host.sock`,
    '--volume', `${join(scratch, 'ssh')}:${HOME}/.ssh-host:ro`,
    IMAGE, 'sh', '-c', `mkdir -p ${HOME}/.claude/projects/w && echo session > ${HOME}/.claude/projects/w/s.jsonl && echo {} > ${HOME}/.claude.json`
  ])
  // The socket's Domo is gone.
  await rm(scratch, { recursive: true, force: true })
})

afterAll(async () => {
  await run('docker', ['rm', '--force', name], { allowFailure: true })
  await run('docker', ['volume', 'rm', homeVolumeName(environmentId)], { allowFailure: true })
  await rm(scratch, { recursive: true, force: true })
  delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
})

describe('migrateHome from an exited container whose bind source is gone', () => {
  it('copies its own home without the mounts under it, and leaves no snapshot', async () => {
    const volume = await migrateHome({
      environmentId,
      containerId: name,
      home: HOME,
      mountDestinations: ['/run/docker-host.sock', `${HOME}/.ssh-host`],
      helperImage: IMAGE
    })

    const { stdout } = await run('docker', [
      'run', '--rm', '--mount', `type=volume,source=${volume},target=/mnt`, IMAGE,
      'sh', '-c', 'cd /mnt && find . | sort && cat .claude/projects/w/s.jsonl'
    ])
    const listed = stdout.split('\n')
    expect(listed).toEqual(expect.arrayContaining(['./.claude.json', './.claude/projects/w/s.jsonl', 'session']))
    // Not even the empty stub the snapshot holds for it.
    expect(listed.filter(line => line.includes('.ssh-host'))).toEqual([])

    const snapshot = await run('docker', ['image', 'inspect', homeSnapshotName(environmentId)], { allowFailure: true })
    expect(snapshot.stdout).toBe('[]')
    const readers = await run('docker', ['ps', '--all', '--quiet', '--filter', `ancestor=${homeSnapshotName(environmentId)}`])
    expect(readers.stdout).toBe('')
  })
})

import { randomBytes } from 'node:crypto'
import { basename, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  findEnvironmentContainer,
  listEnvironmentContainers,
  watchEnvironmentContainers,
  type ContainerWatcher
} from '../../server/lib/dev-env/container-state'
import { inspectContainer, run } from '../../server/lib/dev-env/docker'

/**
 * The shapes that are Docker's, not Domo's: what `docker ps --format` prints
 * for an environment container, that `docker events` names it by its
 * `domo.envId` label, and where `docker inspect` says a bind comes from. A
 * stand-in container with the label, so no environment is built; inside a Domo
 * environment the same calls go through its Docker proxy, which is the nested
 * case (`dood/labels.ts`).
 */

const IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
const environmentId = `env_live${randomBytes(6).toString('hex')}`
const name = `domo-statelive-${environmentId}`
const mountSource = resolve('docs')

let watcher: ContainerWatcher | null = null
const changes: string[] = []
let reconciles = 0

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(wait => setTimeout(wait, 100))
  }
}
const state = async () =>
  findEnvironmentContainer({ containerId: null, containerName: name }, await listEnvironmentContainers())?.state ?? null

beforeAll(async () => {
  await run('docker', ['image', 'inspect', IMAGE]).catch(() => run('docker', ['pull', IMAGE]))
  await run('docker', [
    'run', '--detach', '--name', name, '--label', `domo.envId=${environmentId}`,
    '--volume', `${mountSource}:/mounted:ro`, '--stop-timeout', '1', IMAGE, 'sleep', '600'
  ])
  watcher = watchEnvironmentContainers({
    onChange: id => changes.push(id),
    onReconcile: () => { reconciles++ },
    pollMs: 60_000
  })
  await until(() => watcher!.streaming, 'the event stream')
})

afterAll(async () => {
  watcher?.stop()
  await run('docker', ['rm', '--force', name], { allowFailure: true })
})

describe('an environment container as Docker reports it', () => {
  it('is listed with its id, name, state and environment', async () => {
    const listed = (await listEnvironmentContainers()).find(container => container.name === name)
    const inspection = await inspectContainer(name)

    expect(listed).toEqual({ id: inspection!.id, name, state: 'running', environmentId })
    expect(reconciles).toBeGreaterThanOrEqual(1)
  })

  it('names its bind sources, which is where a proxy socket is found', async () => {
    const inspection = await inspectContainer(name)

    expect(inspection!.bindSources.map(source => basename(source))).toContain(basename(mountSource))
  })

  it('raises an event naming the environment when it stops, and lists as exited', async () => {
    changes.length = 0
    await run('docker', ['stop', name])

    await until(() => changes.includes(environmentId), 'the stop event')
    expect(await state()).toBe('exited')
  })

  it('raises one when it starts again', async () => {
    changes.length = 0
    await run('docker', ['start', name])

    await until(() => changes.includes(environmentId), 'the start event')
    expect(await state()).toBe('running')
  })

  it('raises one when it is removed, and is no longer listed', async () => {
    changes.length = 0
    await run('docker', ['rm', '--force', name])

    await until(() => changes.includes(environmentId), 'the destroy event')
    expect(await state()).toBeNull()
  })
})

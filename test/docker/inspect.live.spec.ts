import { describe, expect, it } from 'vitest'

import { inspectContainer, run } from '../../server/lib/dev-env/docker'

/**
 * The one place a real Docker daemon earns its keep: `inspectContainer` parses
 * `docker inspect` output, and that shape is Docker's, not ours. It runs
 * against the Postgres container from docker-compose, which the database layers
 * need anyway, so nothing is pulled or built for this.
 *
 * Opt in with `pnpm test:docker`; it is not part of `pnpm test`.
 */

const CONTAINER = process.env.DOMO_TEST_CONTAINER || 'domo-postgres-1'

const running = await run('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER], {
  allowFailure: true
}).then(output => output.stdout === 'true').catch(() => false)

describe.skipIf(!running)(`inspectContainer against ${CONTAINER}`, () => {
  it('reports a running container with its id, name and address', async () => {
    const inspection = await inspectContainer(CONTAINER)

    expect(inspection).toMatchObject({ name: CONTAINER, running: true })
    expect(inspection!.id).toMatch(/^[0-9a-f]{12,}$/)
    expect(inspection!.ipAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  it('reads the published ports compose asked for', async () => {
    const inspection = await inspectContainer(CONTAINER)

    expect(inspection!.publishedPorts).toContainEqual({ innerPort: 5432, protocol: 'tcp', hostPort: 54321 })
  })

  it('finds the same container by its id', async () => {
    const byName = await inspectContainer(CONTAINER)
    const byId = await inspectContainer(byName!.id)

    expect(byId).toEqual(byName)
  })

  it('returns null for a container that does not exist', async () => {
    await expect(inspectContainer('domo-no-such-container')).resolves.toBeNull()
  })
})

if (!running) {
  console.warn(
    `[test] skipping live Docker tests: container "${CONTAINER}" is not running. `
    + 'Start it with `docker compose up -d`.'
  )
}

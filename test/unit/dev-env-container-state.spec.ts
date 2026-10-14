import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EVENTS_ARGS,
  findEnvironmentContainer,
  MISSING_CONTAINER_ERROR,
  nextEnvironmentStatus,
  watchEnvironmentContainers,
  type EnvironmentContainer
} from '../../server/lib/dev-env/container-state'

const container = (state: string, overrides: Partial<EnvironmentContainer> = {}): EnvironmentContainer =>
  ({ id: 'sha-1', name: 'domo-dev-env_1', state, environmentId: 'env_1', ...overrides })

describe('nextEnvironmentStatus', () => {
  const row = (status: string, retiredAt: string | null = null) => ({ status: status as any, retiredAt })

  it('calls an environment whose container exited stopped, which is what offers Start', () => {
    expect(nextEnvironmentStatus(row('running'), container('exited'))).toEqual({ status: 'stopped', lastError: null })
  })

  it('reads a paused or restarting container as stopped: neither can run an agent', () => {
    expect(nextEnvironmentStatus(row('running'), container('paused'))?.status).toBe('stopped')
    expect(nextEnvironmentStatus(row('running'), container('restarting'))?.status).toBe('stopped')
  })

  it('calls one started from outside Domo running', () => {
    expect(nextEnvironmentStatus(row('stopped'), container('running'))).toEqual({ status: 'running', lastError: null })
  })

  it('breaks a row whose container is gone, since only a recreate fixes that', () => {
    expect(nextEnvironmentStatus(row('running'), null)).toEqual({ status: 'error', lastError: MISSING_CONTAINER_ERROR })
    expect(nextEnvironmentStatus(row('stopped'), null)).toEqual({ status: 'error', lastError: MISSING_CONTAINER_ERROR })
  })

  it('writes nothing when the row already agrees', () => {
    expect(nextEnvironmentStatus(row('running'), container('running'))).toBeNull()
    expect(nextEnvironmentStatus(row('stopped'), container('exited'))).toBeNull()
  })

  it('leaves a build, a retirement and an error to whoever owns them', () => {
    expect(nextEnvironmentStatus(row('creating'), null)).toBeNull()
    expect(nextEnvironmentStatus(row('creating'), container('running'))).toBeNull()
    expect(nextEnvironmentStatus(row('running', '2026-01-01T00:00:00.000Z'), null)).toBeNull()
    // A failed creation can leave its container up; that it is up says nothing
    // about whether the failure was dealt with.
    expect(nextEnvironmentStatus(row('error'), container('running'))).toBeNull()
  })
})

describe('findEnvironmentContainer', () => {
  it('finds a container by the id the row recorded', () => {
    const found = findEnvironmentContainer(
      { containerId: 'sha-2', containerName: 'renamed' },
      [container('running'), container('exited', { id: 'sha-2', name: 'other' })]
    )
    expect(found?.id).toBe('sha-2')
  })

  it('finds another install\'s container by the row\'s own name, not this install\'s prefix', () => {
    const found = findEnvironmentContainer(
      { containerId: null, containerName: 'domo-prod-env_1' },
      [container('running', { name: 'domo-prod-env_1' })]
    )
    expect(found?.name).toBe('domo-prod-env_1')
    expect(findEnvironmentContainer({ containerId: null, containerName: 'domo-dev-env_9' }, [container('running')])).toBeNull()
  })
})

/** A `docker events` that the test writes to and ends. */
function fakeEvents() {
  const spawned: Array<{ child: ChildProcess, stdout: PassThrough, args: string[] }> = []
  const spawnEvents = (args: string[]) => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() }) as unknown as ChildProcess
    spawned.push({ child, stdout, args })
    return child
  }
  return { spawned, spawnEvents }
}

describe('watchEnvironmentContainers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for exactly the environment containers\' state changes', () => {
    expect(EVENTS_ARGS).toEqual(expect.arrayContaining(['--filter', 'type=container', '--filter', 'label=domo.envId']))
    for (const event of ['start', 'die', 'stop', 'destroy']) expect(EVENTS_ARGS).toContain(`event=${event}`)
  })

  it('looks at everything once the stream is up, then only at what an event names', async () => {
    vi.useFakeTimers()
    const { spawned, spawnEvents } = fakeEvents()
    const onChange = vi.fn()
    const onReconcile = vi.fn()
    const watcher = watchEnvironmentContainers({ onChange, onReconcile, spawnEvents, pollMs: 10_000, retryMs: 2_000 })

    expect(onReconcile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watcher.streaming).toBe(true)
    expect(onReconcile).toHaveBeenCalledTimes(1)

    spawned[0]!.stdout.write(`${JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID: 'sha', Attributes: { 'domo.envId': 'env_1' } } })}\n{"Actor":`)
    spawned[0]!.stdout.write(`{"Attributes":{"domo.envId":"env_2"}}}\nnot json\n`)
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange.mock.calls).toEqual([['env_1'], ['env_2']])

    // No poll while the stream is up.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onReconcile).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('looks again when the stream drops, polls until it is back, and reconciles when it is', async () => {
    vi.useFakeTimers()
    const { spawned, spawnEvents } = fakeEvents()
    const onReconcile = vi.fn()
    const watcher = watchEnvironmentContainers({ onChange: vi.fn(), onReconcile, spawnEvents, pollMs: 10_000, retryMs: 30_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReconcile).toHaveBeenCalledTimes(1)

    // Docker Desktop restarting: the CLI exits.
    spawned[0]!.child.emit('exit', 1)
    expect(watcher.streaming).toBe(false)
    expect(onReconcile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onReconcile).toHaveBeenCalledTimes(4)

    // The retry fails at once: the daemon is still down. Still polling.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(spawned).toHaveLength(2)
    spawned[1]!.child.emit('exit', 1)
    const beforeSecondRetry = onReconcile.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onReconcile.mock.calls.length).toBeGreaterThan(beforeSecondRetry)

    // Back: the stream holds, it reconciles, and the poll stops.
    expect(spawned).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watcher.streaming).toBe(true)
    const settled = onReconcile.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onReconcile.mock.calls.length).toBe(settled)
    watcher.stop()
  })

  it('polls from the start when the stream never comes up', async () => {
    vi.useFakeTimers()
    const { spawned, spawnEvents } = fakeEvents()
    const onReconcile = vi.fn()
    const watcher = watchEnvironmentContainers({ onChange: vi.fn(), onReconcile, spawnEvents, pollMs: 10_000, retryMs: 60_000 })
    spawned[0]!.child.emit('error', new Error('spawn docker ENOENT'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onReconcile).toHaveBeenCalledTimes(3)
    watcher.stop()
  })

  it('stops for good', async () => {
    vi.useFakeTimers()
    const { spawned, spawnEvents } = fakeEvents()
    const onReconcile = vi.fn()
    const watcher = watchEnvironmentContainers({ onChange: vi.fn(), onReconcile, spawnEvents, pollMs: 1_000, retryMs: 1_000 })
    watcher.stop()
    expect(spawned[0]!.child.kill).toHaveBeenCalled()
    spawned[0]!.child.emit('exit', null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(spawned).toHaveLength(1)
    expect(onReconcile).not.toHaveBeenCalled()
  })
})

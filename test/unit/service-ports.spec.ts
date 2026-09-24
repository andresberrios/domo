import { describe, expect, it } from 'vitest'

import {
  parseListeningPorts,
  planPortHelpers,
  requestedPorts,
  siblingFromInspect,
  type SiblingContainer
} from '../../server/lib/dev-env/service-ports'

/**
 * Which of an environment's containers on the host daemon get a port helper,
 * and which helpers are stale. A helper shares its service's network
 * namespace, and — measured — does not follow it through a restart: it keeps
 * running in the old, empty one. So "the right helper" is one naming the
 * service's id *and* its start time.
 */

function container(overrides: Partial<SiblingContainer> & { id: string }): SiblingContainer {
  return {
    name: overrides.id,
    running: true,
    startedAt: '2026-09-24T10:00:00Z',
    labels: { 'domo.env': 'env_1' },
    networkMode: 'stack_default',
    ...overrides
  }
}

function helper(id: string, forId: string, startedAt = '2026-09-24T10:00:00Z', running = true): SiblingContainer {
  return container({
    id,
    running,
    networkMode: `container:${forId}`,
    labels: {
      'domo.env': 'env_1',
      'domo.role': 'port-helper',
      'domo.portsFor': forId,
      'domo.portsStartedAt': startedAt
    }
  })
}

describe('planPortHelpers', () => {
  it('asks for a helper per running service that has none', () => {
    const plan = planPortHelpers([container({ id: 'web' }), container({ id: 'db' })])

    expect(plan.create.map(service => service.id)).toEqual(['web', 'db'])
    expect(plan.remove).toEqual([])
    expect(plan.services.map(entry => entry.helper)).toEqual([null, null])
  })

  it('keeps a helper that still serves its service', () => {
    const plan = planPortHelpers([container({ id: 'web' }), helper('h1', 'web')])

    expect(plan.create).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.services).toEqual([{ service: expect.objectContaining({ id: 'web' }), helper: 'h1' }])
  })

  it('replaces a helper whose service restarted since', () => {
    const plan = planPortHelpers([
      container({ id: 'web', startedAt: '2026-09-24T11:00:00Z' }),
      helper('h1', 'web', '2026-09-24T10:00:00Z')
    ])

    expect(plan.create.map(service => service.id)).toEqual(['web'])
    expect(plan.remove).toEqual(['h1'])
  })

  it('removes a helper whose service is stopped or gone, and scans no stopped service', () => {
    const plan = planPortHelpers([
      container({ id: 'web', running: false }),
      helper('h1', 'web'),
      helper('h2', 'removed-long-ago')
    ])

    expect(plan.services).toEqual([])
    expect(plan.create).toEqual([])
    expect(plan.remove).toEqual(['h1', 'h2'])
  })

  it('skips what has no namespace of its own to scan', () => {
    const plan = planPortHelpers([
      container({ id: 'sidecar', networkMode: 'container:web' }),
      container({ id: 'hostnet', networkMode: 'host' }),
      container({ id: 'offline', networkMode: 'none' })
    ])

    expect(plan.services).toEqual([])
  })

  it('keeps one helper and drops a duplicate a race left behind', () => {
    const plan = planPortHelpers([container({ id: 'web' }), helper('h1', 'web'), helper('h2', 'web')])

    expect(plan.services[0]!.helper).toBe('h1')
    expect(plan.remove).toEqual(['h2'])
  })
})

describe('parseListeningPorts', () => {
  it('reads LISTEN sockets out of /proc/net/tcp and tcp6, and nothing else', () => {
    const proc = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
      '   1: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 2 1',
      '  sl  local_address                         remote_address                        st tx_queue',
      '   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000'
    ].join('\n')

    // A loopback listener (127.0.0.1:3000) is exactly what the helper is for.
    expect([...parseListeningPorts(proc)]).toEqual([3000, 8080])
  })

  it('ignores Docker\'s embedded DNS resolver, which listens in every container on a user network', () => {
    const proc = '   0: 0B00007F:9B13 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1\n'

    expect([...parseListeningPorts(proc)]).toEqual([])
    expect([...parseListeningPorts('LISTEN 0 4096 127.0.0.11:39699 0.0.0.0:*\n')]).toEqual([])
  })

  it('reads ss and netstat output', () => {
    expect([...parseListeningPorts('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*\n')]).toEqual([5173])
    expect([...parseListeningPorts('tcp 0 0 0.0.0.0:4000 0.0.0.0:* LISTEN\n')]).toEqual([4000])
  })
})

describe('requestedPorts and siblingFromInspect', () => {
  it('reads what the proxy wrote down, and tolerates anything else', () => {
    expect(requestedPorts({ 'domo.ports': '[{"containerPort":80,"protocol":"tcp","hostPort":8080}]' }))
      .toEqual([{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }])
    expect(requestedPorts({ 'domo.ports': 'nope' })).toEqual([])
    expect(requestedPorts({})).toEqual([])
  })

  it('takes the fields the scanner needs out of docker inspect', () => {
    expect(siblingFromInspect({
      Id: 'abc',
      Name: '/stack-web-1',
      State: { Running: true, StartedAt: 't' },
      Config: { Labels: { a: 'b' } },
      HostConfig: { NetworkMode: 'stack_default' }
    })).toEqual({
      id: 'abc', name: 'stack-web-1', running: true, startedAt: 't', labels: { a: 'b' }, networkMode: 'stack_default'
    })
  })
})

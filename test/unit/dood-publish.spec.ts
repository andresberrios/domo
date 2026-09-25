import { describe, expect, it, vi } from 'vitest'

import type { DoodRequest } from '../../server/lib/dood/http'
import type { Outcome } from '../../server/lib/dood/layers'
import { namespaceFor } from '../../server/lib/dood/names'
import type { EnvironmentNetwork } from '../../server/lib/dood/network'
import {
  bindFailureMessage,
  bindingsFor,
  conflictingNetworkMode,
  environmentAddress,
  extraHostsFor,
  listenerSpecs,
  normalizeHostIp,
  parseHostPort,
  portListFromBindings,
  portsFromBindings,
  primaryNetwork,
  publishingError,
  targetAddress
} from '../../server/lib/dood/publish'
import { publishLayer } from '../../server/lib/dood/publish-layer'

/**
 * Publishing on an environment's own `localhost`: what a container's
 * publishing means as listeners, how the relay's answer is reported in
 * Docker's shapes, and the layer that decides when to hold, refuse and
 * release — against a fake network, since the network is the I/O.
 */

describe('parsing what was asked to be published', () => {
  it('reads a host port as a single port, a range, or any port', () => {
    expect(parseHostPort('5432')).toEqual([5432, 5432])
    expect(parseHostPort('8000-8010')).toEqual([8000, 8010])
    expect(parseHostPort('')).toEqual([0, 0])
    expect(parseHostPort(undefined)).toEqual([0, 0])
    expect(parseHostPort('9-1')).toBeNull()
    expect(parseHostPort('70000')).toBeNull()
    expect(parseHostPort('http')).toBeNull()
  })

  it('treats 0.0.0.0 and nothing as every address, and unwraps an IPv6 literal', () => {
    expect(normalizeHostIp('')).toBe('')
    expect(normalizeHostIp('0.0.0.0')).toBe('')
    expect(normalizeHostIp('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeHostIp('[::1]')).toBe('::1')
  })

  it('refuses SCTP loudly, and a host port that is not one', () => {
    expect(publishingError({ PortBindings: { '80/tcp': [{ HostPort: '8080' }], '53/udp': [{ HostPort: '' }] } })).toBeNull()
    expect(publishingError({ PortBindings: { '9000/sctp': [{ HostPort: '9000' }] } })).toMatch(/^Domo: SCTP ports \(9000\/sctp\)/)
    expect(publishingError({ PortBindings: { '80/tcp': [{ HostPort: 'eighty' }] } })).toBe('invalid hostPort: eighty')
    expect(publishingError(null)).toBeNull()
  })

  it('refuses publishing on a container network mode, as the daemon would have', () => {
    expect(conflictingNetworkMode({ NetworkMode: 'container:abc' }, { PortBindings: { '80/tcp': [{ HostPort: '1' }] } }))
      .toBe('conflicting options: port publishing and the container type network mode')
    expect(conflictingNetworkMode({ NetworkMode: 'container:abc' }, null)).toBeNull()
    expect(conflictingNetworkMode({ NetworkMode: 'bridge' }, { PortBindings: { '80/tcp': [{ HostPort: '1' }] } })).toBeNull()
  })
})

describe('listenerSpecs', () => {
  it('makes one listener per binding, with the address and the port asked for', () => {
    const specs = listenerSpecs('c1', {
      PortBindings: {
        '5432/tcp': [{ HostIp: '', HostPort: '5432' }],
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }, { HostIp: '', HostPort: '9090' }],
        '53/udp': [{ HostIp: '0.0.0.0', HostPort: '' }],
        '3000/tcp': [{ HostIp: '', HostPort: '3000-3005' }]
      }
    })
    expect(specs).toEqual([
      { key: 'c1/5432/tcp/0', containerId: 'c1', containerPort: 5432, proto: 'tcp', host: '', range: [5432, 5432] },
      { key: 'c1/80/tcp/0', containerId: 'c1', containerPort: 80, proto: 'tcp', host: '127.0.0.1', range: [8080, 8080] },
      { key: 'c1/80/tcp/1', containerId: 'c1', containerPort: 80, proto: 'tcp', host: '', range: [9090, 9090] },
      { key: 'c1/53/udp/0', containerId: 'c1', containerPort: 53, proto: 'udp', host: '', range: [0, 0] },
      { key: 'c1/3000/tcp/0', containerId: 'c1', containerPort: 3000, proto: 'tcp', host: '', range: [3000, 3005] }
    ])
  })

  it('publishes every exposed port on a free one for -P, and leaves an explicit binding as asked', () => {
    const specs = listenerSpecs('c1', { PortBindings: { '6379/tcp': [{ HostPort: '6000' }] }, PublishAllPorts: true },
      ['6379/tcp', '7000/tcp', '53/udp'])
    expect(specs.map(spec => [spec.key, spec.range])).toEqual([
      ['c1/6379/tcp/0', [6000, 6000]],
      ['c1/7000/tcp/0', [0, 0]],
      ['c1/53/udp/0', [0, 0]]
    ])
  })

  it('publishes nothing without -P for a port that is only exposed', () => {
    expect(listenerSpecs('c1', { PortBindings: {} }, ['80/tcp'])).toEqual([])
    expect(listenerSpecs('c1', null, ['80/tcp'])).toEqual([])
  })
})

describe('reporting what the relay holds', () => {
  const specs = listenerSpecs('c1', {
    PortBindings: { '80/tcp': [{ HostPort: '' }], '53/udp': [{ HostIp: '127.0.0.1', HostPort: '5353' }] }
  })
  const bindings = bindingsFor(specs, [
    { key: 'c1/80/tcp/0', port: 49153, addresses: ['0.0.0.0', '::'] },
    { key: 'c1/53/udp/0', port: 5353, addresses: ['127.0.0.1'] }
  ])

  it('reports a dual-stack port under both families, as Docker does', () => {
    expect(bindings).toEqual([
      { containerPort: 80, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 49153 },
      { containerPort: 80, proto: 'tcp', hostIp: '::', hostPort: 49153 },
      { containerPort: 53, proto: 'udp', hostIp: '127.0.0.1', hostPort: 5353 }
    ])
  })

  it('shapes NetworkSettings.Ports the way `docker port` and `compose port` read it', () => {
    expect(portsFromBindings({ '80/tcp': null, '53/udp': null, '9000/tcp': null }, bindings)).toEqual({
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '49153' }, { HostIp: '::', HostPort: '49153' }],
      '53/udp': [{ HostIp: '127.0.0.1', HostPort: '5353' }],
      '9000/tcp': null
    })
  })

  it('shapes `docker ps` Ports, keeping an exposed port that nothing publishes', () => {
    expect(portListFromBindings([{ PrivatePort: 80, Type: 'tcp' }, { PrivatePort: 9000, Type: 'tcp' }], bindings)).toEqual([
      { PrivatePort: 9000, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 49153, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 49153, Type: 'tcp' },
      { IP: '127.0.0.1', PrivatePort: 53, PublicPort: 5353, Type: 'udp' }
    ])
  })
})

describe('bindFailureMessage', () => {
  // Measured against Docker 29 for the first; the second is the userland proxy's.
  it('says "port is already allocated" when another published container holds it', () => {
    expect(bindFailureMessage('db', 'abc123', { key: 'k', host: '', port: 5432, proto: 'tcp', reason: 'allocated' })).toBe(
      'failed to set up container networking: driver failed programming external connectivity on endpoint db (abc123): '
      + 'Bind for 0.0.0.0:5432 failed: port is already allocated'
    )
  })

  it('says "address already in use" when something else in the environment is listening there', () => {
    expect(bindFailureMessage('db', 'abc123', { key: 'k', host: '127.0.0.1', port: 5432, proto: 'tcp', reason: 'in-use' }))
      .toMatch(/Error starting userland proxy: listen tcp4 127\.0\.0\.1:5432: bind: address already in use$/)
    expect(bindFailureMessage('db', 'abc123', { key: 'k', host: '::1', port: 53, proto: 'udp', reason: 'in-use' }))
      .toMatch(/listen udp6 \[::1\]:53: bind/)
  })
})

describe('where traffic and callbacks go', () => {
  const networks = {
    other: { IPAddress: '10.9.0.5', NetworkID: 'n-other' },
    stack_default: { IPAddress: '172.20.0.3', NetworkID: 'n-stack' }
  }

  it('relays to the address on a network the environment shares', () => {
    expect(targetAddress(networks, new Set(['n-stack']))).toBe('172.20.0.3')
    expect(targetAddress(networks, new Set())).toBe('10.9.0.5')
    expect(targetAddress({}, new Set())).toBeNull()
  })

  it('finds the network a new container lands on', () => {
    expect(primaryNetwork({ NetworkMode: 'default' }, undefined)).toBe('bridge')
    // What `docker run` with no --network sends.
    expect(primaryNetwork({ NetworkMode: 'default' }, { default: {} })).toBe('bridge')
    expect(primaryNetwork({}, undefined)).toBe('bridge')
    expect(primaryNetwork({ NetworkMode: 'env_x-stack_default' }, {})).toBe('env_x-stack_default')
    expect(primaryNetwork({ NetworkMode: 'default' }, { 'env_x-net': {} })).toBe('env_x-net')
    expect(primaryNetwork({ NetworkMode: 'container:abc' }, undefined)).toBeNull()
    expect(primaryNetwork({ NetworkMode: 'none' }, undefined)).toBeNull()
    expect(primaryNetwork({ NetworkMode: 'host' }, undefined)).toBeNull()
  })

  it('finds the environment on that network by name or by id', () => {
    const env = { bridge: { IPAddress: '172.17.0.4', NetworkID: 'aaaaaaaaaaaaaaaa' }, 'env_x-stack_default': { IPAddress: '172.20.0.2', NetworkID: 'bbbbbbbbbbbbbbbbbb' } }
    expect(environmentAddress(env, 'bridge')).toBe('172.17.0.4')
    expect(environmentAddress(env, 'bbbbbbbbbbbbbbbbbb')).toBe('172.20.0.2')
    expect(environmentAddress(env, 'bbbbbbbbbbbb')).toBe('172.20.0.2')
    expect(environmentAddress(env, 'elsewhere')).toBeNull()
  })

  it('points host.docker.internal at the environment, rewrites host-gateway, and keeps an explicit address', () => {
    expect(extraHostsFor(undefined, '172.17.0.4')).toEqual([
      'host.docker.internal:172.17.0.4', 'gateway.docker.internal:172.17.0.4'
    ])
    expect(extraHostsFor(['host.docker.internal:host-gateway', 'db=host-gateway', 'api:10.0.0.1'], '172.20.0.2')).toEqual([
      'host.docker.internal:172.20.0.2', 'db=172.20.0.2', 'api:10.0.0.1', 'gateway.docker.internal:172.20.0.2'
    ])
    expect(extraHostsFor(['host.docker.internal=1.2.3.4'], '172.20.0.2')).toEqual([
      'host.docker.internal=1.2.3.4', 'gateway.docker.internal:172.20.0.2'
    ])
  })
})

describe('publishLayer', () => {
  const ns = namespaceFor('env_abc')

  function fakeNetwork(overrides: Partial<Record<keyof EnvironmentNetwork, unknown>> = {}) {
    return {
      ensureRedirect: vi.fn(async () => {}),
      addressOn: vi.fn(async () => '172.17.0.4'),
      prepareStart: vi.fn(async () => null),
      finishStart: vi.fn(async () => {}),
      schedule: vi.fn(),
      ...overrides
    } as unknown as EnvironmentNetwork & Record<string, ReturnType<typeof vi.fn>>
  }

  const request = (method: string, path: string, body?: unknown): DoodRequest => ({
    method,
    path,
    version: '/v1.47',
    query: new URLSearchParams(),
    httpVersion: 'HTTP/1.1',
    headers: [],
    body: body === undefined ? null : Buffer.from(JSON.stringify(body))
  })

  const forward = vi.fn(async (req: DoodRequest): Promise<Outcome> => ({ kind: 'forward', request: req }))

  it('refuses SCTP at create, before the daemon sees it', async () => {
    const layer = publishLayer({ ns, network: fakeNetwork() })
    const outcome = await layer.handle(request('POST', '/containers/create', {
      Labels: { 'domo.publishing': JSON.stringify({ PortBindings: { '9000/sctp': [{ HostPort: '9000' }] } }) }
    }), forward)
    expect(outcome).toMatchObject({ kind: 'answer', status: 400, body: { message: expect.stringMatching(/^Domo: SCTP/) } })
  })

  it('points host.docker.internal at the environment on the container\'s network, and remembers what was asked', async () => {
    const network = fakeNetwork()
    const layer = publishLayer({ ns, network })
    const outcome = await layer.handle(request('POST', '/containers/create', {
      Image: 'alpine',
      HostConfig: { NetworkMode: 'env_abc-stack_default', ExtraHosts: ['host.docker.internal:host-gateway'] },
      Labels: { a: 'b' }
    }), forward)
    expect(network.ensureRedirect).toHaveBeenCalled()
    expect(network.addressOn).toHaveBeenCalledWith('env_abc-stack_default')
    const sent = JSON.parse((outcome as any).request.body.toString())
    expect(sent.HostConfig.ExtraHosts).toEqual(['host.docker.internal:172.17.0.4', 'gateway.docker.internal:172.17.0.4'])
    expect(sent.Labels).toEqual({ 'a': 'b', 'domo.hosts': '["host.docker.internal:host-gateway"]' })
  })

  it('adds no hosts to a container sharing another\'s namespace', async () => {
    const network = fakeNetwork()
    const layer = publishLayer({ ns, network })
    const body = { HostConfig: { NetworkMode: 'container:abc' } }
    const outcome = await layer.handle(request('POST', '/containers/create', body), forward)
    expect(JSON.parse((outcome as any).request.body.toString())).toEqual(body)
  })

  it('refuses a start whose port is taken with Docker\'s words, and never forwards it', async () => {
    const network = fakeNetwork({
      prepareStart: vi.fn(async () => ({
        id: 'c1full', name: 'env_abc-db', failure: { key: 'k', host: '', port: 5432, proto: 'tcp', reason: 'allocated' }
      }))
    })
    const next = vi.fn(forward)
    const outcome = await publishLayer({ ns, network }).handle(request('POST', '/containers/c1full/start'), next)
    expect(next).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      kind: 'answer',
      status: 500,
      body: { message: expect.stringContaining('on endpoint db (c1full): Bind for 0.0.0.0:5432 failed: port is already allocated') }
    })
  })

  it('forwards a start whose ports are held, and tells the network once it is answered', async () => {
    const network = fakeNetwork({ prepareStart: vi.fn(async () => ({ id: 'c1full', name: 'env_abc-db', failure: null })) })
    const outcome = await publishLayer({ ns, network }).handle(request('POST', '/containers/c1/restart'), forward)
    expect(outcome.kind).toBe('forward')
    await (outcome as any).response.after(204)
    expect(network.finishStart).toHaveBeenCalledWith('c1full')
  })

  it('says loudly when the ports cannot be published at all', async () => {
    const network = fakeNetwork({ prepareStart: vi.fn(async () => { throw new Error('the relay did not start in time') }) })
    const outcome = await publishLayer({ ns, network }).handle(request('POST', '/containers/env_abc-db/start'), forward)
    expect(outcome).toMatchObject({
      kind: 'answer',
      status: 500,
      body: { message: 'Domo: could not publish the ports of db in this environment: the relay did not start in time' }
    })
  })

  it('reconciles once a stop, a kill or a removal has been answered', async () => {
    const network = fakeNetwork()
    const layer = publishLayer({ ns, network })
    for (const [method, path] of [['POST', '/containers/c1/stop'], ['POST', '/containers/c1/kill'], ['DELETE', '/containers/c1']]) {
      const outcome = await layer.handle(request(method!, path!), forward)
      await (outcome as any).response.after(204)
    }
    expect(network.schedule).toHaveBeenCalledTimes(3)
  })
})

import { describe, expect, it } from 'vitest'

import { namespaceFor } from '../../server/lib/dood/names'
import {
  containerInspectForAgent,
  containerSummaryForAgent,
  eventForAgent,
  networkForAgent,
  networkListForAgent,
  pruneReportForAgent,
  systemDfForAgent,
  volumeForAgent,
  type EventScope
} from '../../server/lib/dood/responses'

const ns = namespaceFor('env_abc')
const scope = { ns, workspaceVolume: 'domo-dev-env_abc-workspace' }
const LABEL: [string, string] = ['domo.env', 'env_abc']

const labels = {
  'com.docker.compose.project': 'stack',
  'domo.env': 'env_abc',
  'domo.ports': '[{"containerPort":80,"protocol":"tcp","hostPort":8080}]',
  'domo.binds': JSON.stringify({ Binds: ['data:/data', '/workspaces/domo/site:/site:ro'] }),
  'domo.publishing': JSON.stringify({ PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }], '53/udp': [{ HostPort: '' }] } })
}

/** What the daemon answers for a container created through the proxy. */
const inspected = {
  Id: 'c1',
  Name: '/env_abc-web',
  Config: { Labels: labels },
  HostConfig: {
    Binds: ['env_abc-data:/data'],
    Mounts: [{ Type: 'volume', Source: 'domo-dev-env_abc-workspace', Target: '/site', ReadOnly: true, VolumeOptions: { Subpath: 'site' } }],
    PortBindings: {},
    PublishAllPorts: false,
    NetworkMode: 'env_abc-stack_default',
    Links: ['/env_abc-db:/env_abc-web/db']
  },
  Mounts: [
    { Type: 'volume', Name: 'env_abc-data', Source: '/var/lib/docker/volumes/env_abc-data/_data', Destination: '/data', RW: true },
    { Type: 'volume', Name: 'domo-dev-env_abc-workspace', Source: '/var/lib/docker/volumes/domo-dev-env_abc-workspace/_data', Destination: '/site', RW: false }
  ],
  NetworkSettings: {
    Ports: { '80/tcp': null, '53/udp': null },
    Networks: {
      'env_abc-stack_default': { Aliases: ['web', 'stack-web-1'], DNSNames: ['env_abc-stack-web-1', 'web', 'stack-web-1', 'c1'] }
    }
  }
}

describe('containerInspectForAgent', () => {
  const out = containerInspectForAgent(inspected, scope) as any

  it('shows the name, networks and links without the prefix', () => {
    expect(out.Name).toBe('/web')
    expect(out.HostConfig.NetworkMode).toBe('stack_default')
    expect(out.HostConfig.Links).toEqual(['/db:/web/db'])
    expect(Object.keys(out.NetworkSettings.Networks)).toEqual(['stack_default'])
    expect(out.NetworkSettings.Networks.stack_default.DNSNames).toEqual(['stack-web-1', 'web', 'c1'])
  })

  it('hides Domo\'s own labels and keeps the rest', () => {
    expect(out.Config.Labels).toEqual({ 'com.docker.compose.project': 'stack' })
  })

  it('restores the binds and mounts the client asked for', () => {
    expect(out.HostConfig.Binds).toEqual(['data:/data', '/workspaces/domo/site:/site:ro'])
    expect(out.HostConfig.Mounts).toBeNull()
    expect(out.Mounts).toEqual([
      { Type: 'volume', Name: 'data', Source: '/var/lib/docker/volumes/data/_data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/workspaces/domo/site', Destination: '/site', Mode: 'ro', RW: false, Propagation: 'rprivate' }
    ])
  })

  it('restores the publishing asked for, and reports only the ports that named a host port', () => {
    expect(out.HostConfig.PortBindings).toEqual({ '80/tcp': [{ HostIp: '', HostPort: '8080' }], '53/udp': [{ HostPort: '' }] })
    expect(out.NetworkSettings.Ports).toEqual({ '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }], '53/udp': null })
  })

  it('leaves a container created before the labels existed as it is', () => {
    const plain = { Name: '/bold_gauss', Config: { Labels: {} }, HostConfig: { Binds: ['/x:/y'] }, Mounts: [] }
    expect(containerInspectForAgent(plain, scope)).toMatchObject({ Name: '/bold_gauss', HostConfig: { Binds: ['/x:/y'] } })
  })
})

describe('containerSummaryForAgent', () => {
  it('rewrites the list entry the way `docker ps` and compose read it', () => {
    const out = containerSummaryForAgent({
      Id: 'c1',
      Names: ['/env_abc-web'],
      Labels: labels,
      Ports: [{ PrivatePort: 80, Type: 'tcp' }, { PrivatePort: 53, Type: 'udp' }],
      Mounts: inspected.Mounts,
      HostConfig: { NetworkMode: 'env_abc-stack_default' },
      NetworkSettings: { Networks: inspected.NetworkSettings.Networks }
    }, scope) as any
    expect(out.Names).toEqual(['/web'])
    expect(out.Labels).toEqual({ 'com.docker.compose.project': 'stack' })
    expect(out.Ports).toEqual([
      { PrivatePort: 80, Type: 'tcp' },
      { PrivatePort: 53, Type: 'udp' },
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }
    ])
    expect(out.Mounts[0].Name).toBe('data')
    expect(out.HostConfig.NetworkMode).toBe('stack_default')
    expect(Object.keys(out.NetworkSettings.Networks)).toEqual(['stack_default'])
  })
})

describe('networks', () => {
  const network = {
    Name: 'env_abc-stack_default',
    Id: 'n1',
    Labels: { 'domo.env': 'env_abc', 'com.docker.compose.network': 'default' },
    Containers: {
      c1: { Name: 'env_abc-stack-web-1' },
      own: { Name: 'domo-dev-env_abc' },
      other: { Name: 'env_zzz-web' }
    }
  }

  it('shows the agent its own endpoints only, never the environment itself', () => {
    const out = networkForAgent(network, scope, id => id === 'c1') as any
    expect(out.Name).toBe('stack_default')
    expect(out.Labels).toEqual({ 'com.docker.compose.network': 'default' })
    expect(out.Containers).toEqual({ c1: { Name: 'stack-web-1' } })
  })

  it('lists the builtins and the environment\'s own networks, nobody else\'s', () => {
    const list = [
      network,
      { Name: 'bridge', Id: 'b', Labels: {} },
      { Name: 'host', Id: 'h', Labels: {} },
      { Name: 'none', Id: 'x', Labels: {} },
      { Name: 'domo_default', Id: 'd', Labels: { 'com.docker.compose.project': 'domo' } },
      { Name: 'env_zzz-stack_default', Id: 'z', Labels: { 'domo.env': 'env_zzz' } }
    ]
    const out = networkListForAgent(list, scope, LABEL) as any[]
    expect(out.map(entry => entry.Name)).toEqual(['stack_default', 'bridge', 'host', 'none'])
  })
})

describe('volumes and prunes', () => {
  it('shows a volume by its own name', () => {
    expect(volumeForAgent({
      Name: 'env_abc-data',
      Mountpoint: '/var/lib/docker/volumes/env_abc-data/_data',
      Labels: { 'domo.env': 'env_abc', keep: '1' }
    }, scope)).toEqual({ Name: 'data', Mountpoint: '/var/lib/docker/volumes/data/_data', Labels: { keep: '1' } })
  })

  it('reports what a prune removed by the names the agent knows', () => {
    expect(pruneReportForAgent({ VolumesDeleted: ['env_abc-data', 'f00'], SpaceReclaimed: 1 }, scope))
      .toEqual({ VolumesDeleted: ['data', 'f00'], SpaceReclaimed: 1 })
    expect(pruneReportForAgent({ NetworksDeleted: ['env_abc-stack_default'] }, scope))
      .toEqual({ NetworksDeleted: ['stack_default'] })
  })

  it('narrows `system df` to the environment and leaves the shared images', () => {
    const out = systemDfForAgent({
      Images: [{ Id: 'i' }],
      Containers: [{ Id: 'c1', Names: ['/env_abc-web'], Labels: { 'domo.env': 'env_abc' } }, { Id: 'x', Labels: {} }],
      Volumes: [{ Name: 'env_abc-data', Labels: { 'domo.env': 'env_abc' } }, { Name: 'pg', Labels: null }]
    }, scope, LABEL) as any
    expect(out.Images).toHaveLength(1)
    expect(out.Containers.map((entry: any) => entry.Names)).toEqual([['/web']])
    expect(out.Volumes.map((entry: any) => entry.Name)).toEqual(['data'])
  })
})

describe('eventForAgent', () => {
  const eventScope = (): EventScope => ({
    ...scope,
    environmentLabel: LABEL,
    containers: new Set(['c1']),
    volumes: new Set(['0123abcd'])
  })

  const container = (id: string, action: string, attributes: Record<string, string>) =>
    ({ Type: 'container', Action: action, Actor: { ID: id, Attributes: attributes }, id, status: action })

  it('keeps the environment\'s container events, renamed, with Domo\'s labels hidden', () => {
    const out = eventForAgent(container('c2', 'create', { 'name': 'env_abc-db', 'domo.env': 'env_abc', 'image': 'pg' }), eventScope()) as any
    expect(out.Actor.Attributes).toEqual({ name: 'db', image: 'pg' })
  })

  it('drops everyone else\'s container events', () => {
    expect(eventForAgent(container('x', 'start', { name: 'postgres' }), eventScope())).toBeNull()
    expect(eventForAgent(container('y', 'start', { 'name': 'env_zzz-web', 'domo.env': 'env_zzz' }), eventScope())).toBeNull()
  })

  it('follows a container created on the stream into its network events', () => {
    const state = eventScope()
    eventForAgent(container('c9', 'create', { 'name': 'env_abc-new', 'domo.env': 'env_abc' }), state)
    const connect = { Type: 'network', Action: 'connect', Actor: { ID: 'b', Attributes: { name: 'bridge', container: 'c9', type: 'bridge' } } }
    expect(eventForAgent(connect, state)).not.toBeNull()
    const theirs = { ...connect, Actor: { ID: 'b', Attributes: { name: 'bridge', container: 'zz', type: 'bridge' } } }
    expect(eventForAgent(theirs, state)).toBeNull()
  })

  it('keeps its own networks\' and volumes\' events and drops the rest', () => {
    const state = eventScope()
    const network = (name: string) => ({ Type: 'network', Action: 'create', Actor: { ID: 'n', Attributes: { name } } })
    expect((eventForAgent(network('env_abc-stack_default'), state) as any).Actor.Attributes.name).toBe('stack_default')
    expect(eventForAgent(network('domo_default'), state)).toBeNull()
    const volume = (name: string) => ({ Type: 'volume', Action: 'create', Actor: { ID: name, Attributes: { driver: 'local' } } })
    expect((eventForAgent(volume('env_abc-data'), state) as any).Actor.ID).toBe('data')
    expect(eventForAgent(volume('0123abcd'), state)).not.toBeNull()
    expect(eventForAgent(volume('pgdata'), state)).toBeNull()
  })

  it('passes image events, which describe the shared cache', () => {
    expect(eventForAgent({ Type: 'image', Action: 'pull', Actor: { ID: 'alpine:3', Attributes: {} } }, eventScope())).not.toBeNull()
  })
})

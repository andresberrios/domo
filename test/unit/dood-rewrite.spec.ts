import { describe, expect, it } from 'vitest'

import {
  createReferences,
  labelCreate,
  rewriteContainerCreate,
  workspaceSubpath,
  type CreateNames,
  type DoodScope
} from '../../server/lib/dood/rewrite'

const scope: DoodScope = {
  workspacePath: '/workspaces/domo',
  workspaceVolume: 'domo-dev-env_abc-workspace',
  labels: { 'domo.env': 'env_abc' }
}

const mountsOf = (result: ReturnType<typeof rewriteContainerCreate>) =>
  (result.spec.HostConfig as { Mounts?: unknown[] }).Mounts ?? []

describe('workspaceSubpath', () => {
  it('maps a path under the workspace to its relative subpath', () => {
    expect(workspaceSubpath('/workspaces/domo/app', '/workspaces/domo')).toBe('app')
    expect(workspaceSubpath('/workspaces/domo/a/b', '/workspaces/domo')).toBe('a/b')
  })

  it('maps the workspace root to the whole volume', () => {
    expect(workspaceSubpath('/workspaces/domo', '/workspaces/domo')).toBe('')
  })

  it('leaves anything outside the workspace alone', () => {
    expect(workspaceSubpath('/etc/passwd', '/workspaces/domo')).toBeNull()
    // A prefix match that is not a path boundary is not ours.
    expect(workspaceSubpath('/workspaces/domo-other/x', '/workspaces/domo')).toBeNull()
  })
})

describe('rewriteContainerCreate — mounts', () => {
  it('turns a workspace bind into a volume mount with a subpath', () => {
    const result = rewriteContainerCreate(
      { HostConfig: { Binds: ['/workspaces/domo/app:/app'] } },
      scope
    )
    expect(mountsOf(result)).toEqual([
      { Type: 'volume', Source: scope.workspaceVolume, Target: '/app', ReadOnly: false, VolumeOptions: { Subpath: 'app' } }
    ])
    expect((result.spec.HostConfig as { Binds: string[] }).Binds).toEqual([])
    expect(result.requiredSubpaths).toEqual(['app'])
  })

  it('mounts the whole volume with no subpath for the workspace root', () => {
    const result = rewriteContainerCreate({ HostConfig: { Binds: ['/workspaces/domo:/src:ro'] } }, scope)
    expect(mountsOf(result)).toEqual([
      { Type: 'volume', Source: scope.workspaceVolume, Target: '/src', ReadOnly: true }
    ])
    // The root always exists, so nothing has to be created for it.
    expect(result.requiredSubpaths).toEqual([])
  })

  it('leaves binds outside the workspace and named volumes untouched', () => {
    const result = rewriteContainerCreate(
      { HostConfig: { Binds: ['/etc/hosts:/etc/hosts:ro', 'pgdata:/var/lib/postgresql/data'] } },
      scope
    )
    expect((result.spec.HostConfig as { Binds: string[] }).Binds)
      .toEqual(['/etc/hosts:/etc/hosts:ro', 'pgdata:/var/lib/postgresql/data'])
    expect(mountsOf(result)).toEqual([])
  })

  it('rewrites long-syntax bind mounts too', () => {
    const result = rewriteContainerCreate(
      { HostConfig: { Mounts: [{ Type: 'bind', Source: '/workspaces/domo/server', Target: '/srv', ReadOnly: true }] } },
      scope
    )
    expect(mountsOf(result)).toEqual([
      { Type: 'volume', Source: scope.workspaceVolume, Target: '/srv', ReadOnly: true, VolumeOptions: { Subpath: 'server' } }
    ])
    expect(result.requiredSubpaths).toEqual(['server'])
  })

  it('reports each required subpath once', () => {
    const result = rewriteContainerCreate(
      { HostConfig: { Binds: ['/workspaces/domo/app:/a', '/workspaces/domo/app:/b'] } },
      scope
    )
    expect(result.requiredSubpaths).toEqual(['app'])
  })
})

describe('rewriteContainerCreate — ports', () => {
  it('drops host publishing and reports what was asked for', () => {
    const result = rewriteContainerCreate(
      { HostConfig: { PortBindings: { '3000/tcp': [{ HostPort: '3001' }], '53/udp': [{ HostPort: '' }] } } },
      scope
    )
    expect((result.spec.HostConfig as { PortBindings: unknown }).PortBindings).toEqual({})
    expect(result.droppedPorts).toEqual([
      { containerPort: 3000, protocol: 'tcp', hostPort: 3001 },
      { containerPort: 53, protocol: 'udp', hostPort: null }
    ])
    // Written on the container, for the port scanner to forward later.
    expect(JSON.parse((result.spec.Labels as Record<string, string>)['domo.ports']!))
      .toEqual(result.droppedPorts)
  })

  it('refuses to publish all exposed ports', () => {
    const result = rewriteContainerCreate({ HostConfig: { PublishAllPorts: true } }, scope)
    expect((result.spec.HostConfig as { PublishAllPorts: boolean }).PublishAllPorts).toBe(false)
  })
})

describe('rewriteContainerCreate — identity and networks', () => {
  it('stamps the environment label alongside the caller own labels', () => {
    const result = rewriteContainerCreate({ Labels: { 'com.docker.compose.project': 'api' } }, scope)
    expect(result.spec.Labels).toEqual({ 'com.docker.compose.project': 'api', 'domo.env': 'env_abc' })
  })

  it('collects networks from both EndpointsConfig and NetworkMode', () => {
    const result = rewriteContainerCreate(
      {
        NetworkingConfig: { EndpointsConfig: { api_default: {} } },
        HostConfig: { NetworkMode: 'api_backend' }
      },
      scope
    )
    expect(result.networksToJoin).toEqual(['api_default', 'api_backend'])
  })

  it('ignores network modes that are not joinable networks', () => {
    for (const mode of ['default', 'bridge', 'host', 'none', 'container:abc']) {
      const result = rewriteContainerCreate({ HostConfig: { NetworkMode: mode } }, scope)
      expect(result.networksToJoin).toEqual([])
    }
  })

  it('survives a spec with no HostConfig at all', () => {
    const result = rewriteContainerCreate({ Image: 'alpine' }, scope)
    expect(result.spec.Image).toBe('alpine')
    expect(result.droppedPorts).toEqual([])
    expect(result.networksToJoin).toEqual([])
  })
})

describe('labelCreate', () => {
  it('adds the scope labels to a network or volume, keeping compose\'s own', () => {
    const spec = labelCreate(
      { Name: 'stack_default', Labels: { 'com.docker.compose.project': 'stack' } },
      { labels: { 'domo.env': 'env_1' } }
    )

    expect(spec).toEqual({
      Name: 'stack_default',
      Labels: { 'com.docker.compose.project': 'stack', 'domo.env': 'env_1' }
    })
  })
})

describe('labelCreate — names', () => {
  it('puts a named network or volume in the environment\'s namespace', () => {
    expect(labelCreate({ Name: 'data' }, { labels: { 'domo.env': 'env_1' } }, 'env_1-'))
      .toEqual({ Name: 'env_1-data', Labels: { 'domo.env': 'env_1' } })
  })

  it('leaves a volume with no name to the daemon\'s random one', () => {
    expect(labelCreate({}, { labels: { 'domo.env': 'env_1' } }, 'env_1-')).toEqual({ Labels: { 'domo.env': 'env_1' } })
  })
})

/** Resolution as the scope layer would do it, with every reference known and namespaced. */
const names = (name: string | null = 'web'): CreateNames => ({
  name,
  container: ref => ref === 'env-own' ? 'f'.repeat(64) : `env_abc-${ref}`,
  network: ref => `env_abc-${ref}`,
  volume: ref => `env_abc-${ref}`
})

describe('createReferences', () => {
  it('finds every container, network and volume a create names', () => {
    const refs = createReferences({
      HostConfig: {
        NetworkMode: 'container:db',
        PidMode: 'container:pid',
        IpcMode: 'container:ipc',
        Links: ['/cache:redis', 'queue'],
        VolumesFrom: ['data:ro'],
        Binds: ['pg:/var/lib/pg', '/workspaces/domo:/src', './rel:/x'],
        Mounts: [
          { Type: 'volume', Source: 'cache', Target: '/c', VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'tmpfs' } }, Labels: { a: 'b' } } },
          { Type: 'volume', Target: '/anonymous' },
          { Type: 'bind', Source: '/etc', Target: '/etc' }
        ]
      },
      NetworkingConfig: { EndpointsConfig: { backend: { Links: ['auth:a'] }, bridge: {} } }
    })
    expect(refs.containers.sort()).toEqual(['auth', 'cache', 'data', 'db', 'ipc', 'pid', 'queue'])
    expect(refs.networks).toEqual(['backend'])
    expect(refs.volumes).toEqual([
      { name: 'pg' },
      { name: 'cache', driver: 'local', driverOptions: { type: 'tmpfs' }, labels: { a: 'b' } }
    ])
  })

  it('takes a network mode that names a network, and none of the builtins', () => {
    expect(createReferences({ HostConfig: { NetworkMode: 'stack_default' } }).networks).toEqual(['stack_default'])
    for (const mode of ['default', 'bridge', 'host', 'none']) {
      expect(createReferences({ HostConfig: { NetworkMode: mode } }).networks).toEqual([])
    }
  })
})

describe('rewriteContainerCreate — names', () => {
  it('renames networks and adds the agent\'s name as an alias on each', () => {
    const result = rewriteContainerCreate({
      HostConfig: { NetworkMode: 'stack_default' },
      NetworkingConfig: { EndpointsConfig: { stack_default: { Aliases: ['web'] }, backend: {} } }
    }, scope, names('stack-web-1'))
    const endpoints = (result.spec.NetworkingConfig as any).EndpointsConfig
    expect((result.spec.HostConfig as any).NetworkMode).toBe('env_abc-stack_default')
    expect(endpoints).toEqual({
      'env_abc-stack_default': { Aliases: ['web', 'stack-web-1'] },
      'env_abc-backend': { Aliases: ['stack-web-1'] }
    })
    expect(result.networksToJoin).toEqual(['env_abc-stack_default', 'env_abc-backend'])
  })

  it('adds an endpoint for a network named only by the network mode', () => {
    const result = rewriteContainerCreate({ HostConfig: { NetworkMode: 'mine' } }, scope, names('web'))
    expect((result.spec.NetworkingConfig as any).EndpointsConfig).toEqual({ 'env_abc-mine': { Aliases: ['web'] } })
  })

  it('adds no alias on the default bridge, which refuses one', () => {
    const result = rewriteContainerCreate({
      HostConfig: { NetworkMode: 'bridge' },
      NetworkingConfig: { EndpointsConfig: { bridge: {} } }
    }, scope, names('web'))
    expect((result.spec.NetworkingConfig as any).EndpointsConfig).toEqual({ bridge: {} })
    expect(result.networksToJoin).toEqual([])
  })

  it('adds no alias for a container with a random name', () => {
    const result = rewriteContainerCreate({ HostConfig: { NetworkMode: 'mine' } }, scope, names(null))
    expect((result.spec.NetworkingConfig as any).EndpointsConfig).toEqual({ 'env_abc-mine': {} })
  })

  it('resolves container references in modes, links and volumes-from', () => {
    const result = rewriteContainerCreate({
      HostConfig: {
        NetworkMode: 'container:env-own',
        PidMode: 'container:db',
        Links: ['/cache:redis', 'queue'],
        VolumesFrom: ['data:ro', 'more']
      }
    }, scope, names())
    const hostConfig = result.spec.HostConfig as any
    expect(hostConfig.NetworkMode).toBe(`container:${'f'.repeat(64)}`)
    expect(hostConfig.PidMode).toBe('container:env_abc-db')
    // A link's alias is what the agent wrote, so DNS and the link env vars keep its name.
    expect(hostConfig.Links).toEqual(['env_abc-cache:redis', 'env_abc-queue:queue'])
    expect(hostConfig.VolumesFrom).toEqual(['env_abc-data:ro', 'env_abc-more'])
    expect(result.networksToJoin).toEqual([])
  })

  it('renames named volumes in binds and mounts, and never the workspace', () => {
    const result = rewriteContainerCreate({
      HostConfig: {
        Binds: ['pg:/var/lib/pg:rw', '/workspaces/domo/app:/app', '/etc/hosts:/etc/hosts:ro'],
        Mounts: [{ Type: 'volume', Source: 'cache', Target: '/c' }, { Type: 'volume', Target: '/anon' }]
      }
    }, scope, names())
    const hostConfig = result.spec.HostConfig as any
    expect(hostConfig.Binds).toEqual(['env_abc-pg:/var/lib/pg:rw', '/etc/hosts:/etc/hosts:ro'])
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'env_abc-cache', Target: '/c' },
      { Type: 'volume', Target: '/anon' },
      { Type: 'volume', Source: scope.workspaceVolume, Target: '/app', ReadOnly: false, VolumeOptions: { Subpath: 'app' } }
    ])
  })

  it('keeps what the client asked for on labels, for inspect to restore', () => {
    const input = {
      HostConfig: {
        Binds: ['pg:/data', '/workspaces/domo/app:/app'],
        PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
        PublishAllPorts: true
      }
    }
    const labels = rewriteContainerCreate(input, scope, names()).spec.Labels as Record<string, string>
    expect(JSON.parse(labels['domo.binds']!)).toEqual({ Binds: ['pg:/data', '/workspaces/domo/app:/app'] })
    expect(JSON.parse(labels['domo.publishing']!)).toEqual({
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
      PublishAllPorts: true
    })
  })

  it('writes no bookkeeping labels when there was nothing to keep', () => {
    const labels = rewriteContainerCreate({ Image: 'alpine' }, scope, names()).spec.Labels
    expect(labels).toEqual({ 'domo.env': 'env_abc' })
  })
})

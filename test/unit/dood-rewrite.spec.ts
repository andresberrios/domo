import { describe, expect, it } from 'vitest'

import { labelCreate, rewriteContainerCreate, routeRequest, workspaceSubpath, type DoodScope } from '../../server/lib/dood/rewrite'

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

describe('routeRequest', () => {
  it.each([
    ['POST /v1.47/containers/create?name=web HTTP/1.1', { kind: 'container-create' }],
    ['POST /containers/create HTTP/1.1', { kind: 'container-create' }],
    ['POST /v1.47/networks/create HTTP/1.1', { kind: 'label-create' }],
    ['POST /v1.47/volumes/create HTTP/1.1', { kind: 'label-create' }],
    ['DELETE /v1.47/networks/stack_default HTTP/1.1', { kind: 'network-delete', network: 'stack_default' }],
    ['DELETE /v1.47/containers/abc?force=1 HTTP/1.1', { kind: 'forward' }],
    ['POST /v1.47/containers/abc/start HTTP/1.1', { kind: 'forward' }],
    ['GET /v1.47/networks/stack_default HTTP/1.1', { kind: 'network-inspect', network: 'stack_default' }],
    ['GET /v1.47/networks?filters=%7B%7D HTTP/1.1', { kind: 'forward' }],
    ['POST /v1.47/networks/stack_default/connect HTTP/1.1', { kind: 'forward' }]
  ])('%s', (line, expected) => {
    expect(routeRequest(line)).toEqual(expected)
  })
})

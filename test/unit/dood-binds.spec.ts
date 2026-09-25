import { describe, expect, it } from 'vitest'

import {
  containingMount,
  mountTableFromInspect,
  normalizeSource,
  resolveBindSource,
  type EnvironmentMount
} from '../../server/lib/dood/binds'
import { hostModes, rewriteContainerCreate, type CreateNames, type DoodScope } from '../../server/lib/dood/rewrite'

/**
 * Binds outside the checkout and `network_mode: host`: where a path an agent
 * names really is on the shared daemon, and what `host` means for a
 * namespace when the host is the environment.
 */

const SOCKET = '/Users/me/.domo/dood/abcd1234/env_abc.sock'
const OWN_ID = 'e'.repeat(64)

/** The mount table of a real environment, as `docker inspect` reports it. */
const INSPECTED = {
  Mounts: [
    { Type: 'volume', Name: 'domo-dev-env_abc-workspace', Source: '/var/lib/docker/volumes/domo-dev-env_abc-workspace/_data', Destination: '/workspaces/app', RW: true },
    { Type: 'volume', Name: 'domo-runtime-1234', Source: '/var/lib/docker/volumes/domo-runtime-1234/_data', Destination: '/opt/domo', RW: false },
    { Type: 'volume', Name: 'caches', Source: '/var/lib/docker/volumes/caches/_data', Destination: '/home/vscode/.cache/pnpm', RW: true },
    { Type: 'bind', Source: '/Users/me/.aws', Destination: '/home/vscode/.aws', RW: true },
    { Type: 'bind', Source: '/Users/me/.ssh', Destination: '/home/vscode/.ssh-host', RW: true },
    { Type: 'bind', Source: '/Users/me/.gitconfig', Destination: '/home/vscode/.gitconfig-host', RW: false },
    { Type: 'bind', Source: '/host_mnt/Users/me/.config/gh', Destination: '/home/vscode/.config/gh', RW: true },
    { Type: 'bind', Source: '/run/host-services/ssh-auth.sock', Destination: '/run/host-services/ssh-auth.sock', RW: true },
    { Type: 'bind', Source: SOCKET, Destination: '/var/run/docker.sock', RW: true },
    { Type: 'tmpfs', Source: '', Destination: '/home/vscode/scratch', RW: true }
  ],
  HostConfig: {
    Mounts: [
      { Type: 'volume', Source: 'caches', Target: '/home/vscode/.cache/pnpm', VolumeOptions: { Subpath: 'env_abc/pnpm' } }
    ]
  }
}

const table = mountTableFromInspect(INSPECTED)
const resolve = (path: string) => resolveBindSource(path, table, { dockerSocket: SOCKET }, '/workspaces/app')

describe('mountTableFromInspect', () => {
  it('reads volumes (with their own subpath), binds and the rest out of docker inspect', () => {
    expect(table).toContainEqual({ destination: '/workspaces/app', kind: 'volume', volume: 'domo-dev-env_abc-workspace', readOnly: false })
    expect(table).toContainEqual({ destination: '/opt/domo', kind: 'volume', volume: 'domo-runtime-1234', readOnly: true })
    expect(table).toContainEqual({ destination: '/home/vscode/.cache/pnpm', kind: 'volume', volume: 'caches', subpath: 'env_abc/pnpm', readOnly: false })
    expect(table).toContainEqual({ destination: '/home/vscode/.aws', kind: 'bind', source: '/Users/me/.aws', readOnly: false })
    expect(table).toContainEqual({ destination: '/home/vscode/scratch', kind: 'other', type: 'tmpfs', readOnly: false })
  })

  it('tolerates an inspect with no mounts at all', () => {
    expect(mountTableFromInspect({})).toEqual([])
    expect(mountTableFromInspect(null)).toEqual([])
  })
})

describe('resolveBindSource', () => {
  it('picks the longest mount the path is under, never a sibling that shares a prefix', () => {
    const nested: EnvironmentMount[] = [
      { destination: '/home/vscode', kind: 'volume', volume: 'home', readOnly: false },
      { destination: '/home/vscode/.aws', kind: 'bind', source: '/Users/me/.aws', readOnly: false }
    ]
    expect(containingMount('/home/vscode/.aws/config', nested)?.destination).toBe('/home/vscode/.aws')
    expect(containingMount('/home/vscode/.aws-other', nested)?.destination).toBe('/home/vscode')
    expect(containingMount('/home/vscodex', nested)).toBeNull()
  })

  it('maps a path in the checkout to the workspace volume and a subpath', () => {
    expect(resolve('/workspaces/app/db/init')).toEqual({ kind: 'volume', volume: 'domo-dev-env_abc-workspace', subpath: 'db/init', readOnly: false })
    expect(resolve('/workspaces/app')).toEqual({ kind: 'volume', volume: 'domo-dev-env_abc-workspace', subpath: '', readOnly: false })
  })

  it('maps a path in any other volume the same way, under that mount\'s own subpath', () => {
    expect(resolve('/home/vscode/.cache/pnpm/store')).toEqual({ kind: 'volume', volume: 'caches', subpath: 'env_abc/pnpm/store', readOnly: false })
    expect(resolve('/opt/domo/node')).toEqual({ kind: 'volume', volume: 'domo-runtime-1234', subpath: 'node', readOnly: true })
  })

  it('maps a path under a bind to its source on the host, and strips Docker Desktop\'s /host_mnt', () => {
    expect(resolve('/home/vscode/.aws')).toEqual({ kind: 'bind', source: '/Users/me/.aws', readOnly: false })
    expect(resolve('/home/vscode/.aws/credentials')).toEqual({ kind: 'bind', source: '/Users/me/.aws/credentials', readOnly: false })
    expect(resolve('/home/vscode/.config/gh')).toEqual({ kind: 'bind', source: '/Users/me/.config/gh', readOnly: false })
    expect(resolve('/home/vscode/.gitconfig-host')).toEqual({ kind: 'bind', source: '/Users/me/.gitconfig', readOnly: true })
    // A mounted socket is a bind like any other.
    expect(resolve('/run/host-services/ssh-auth.sock')).toEqual({ kind: 'bind', source: '/run/host-services/ssh-auth.sock', readOnly: false })
  })

  it('gives the Docker socket, by either of its names, as this environment\'s own proxy', () => {
    expect(resolve('/var/run/docker.sock')).toEqual({ kind: 'socket', source: SOCKET })
    expect(resolve('/run/docker.sock')).toEqual({ kind: 'socket', source: SOCKET })
    // Even when the environment's own table does not have it: the host's real socket must never be what a service gets.
    expect(resolveBindSource('/var/run/docker.sock', [], { dockerSocket: SOCKET })).toEqual({ kind: 'socket', source: SOCKET })
    expect(resolveBindSource('/var/run/docker.sock', []).kind).toBe('refuse')
  })

  it('passes system paths through to the daemon\'s host', () => {
    for (const path of ['/etc/localtime', '/etc/timezone', '/usr/share/zoneinfo/Europe/Madrid', '/dev', '/dev/fuse',
      '/sys/fs/cgroup', '/proc', '/lib/modules', '/run/containerd', '/var/run/dbus', '/var/lib/docker/containers']) {
      expect(resolve(path)).toEqual({ kind: 'system', source: path })
    }
  })

  it('refuses a path that exists only inside the environment, naming it and saying why', () => {
    for (const path of ['/tmp/foo', '/home/vscode/cache', '/etc', '/etc/hosts', '/', '/var/log', '/workspaces', '/home/vscode']) {
      const resolved = resolve(path)
      expect(resolved.kind, path).toBe('refuse')
      expect((resolved as { message: string }).message).toContain(`${path} exists only inside this dev environment`)
      expect((resolved as { message: string }).message).toContain('/workspaces/app')
    }
  })

  it('points a refused home directory at the host\'s own copy when there is one beside it', () => {
    const ssh = resolve('/home/vscode/.ssh') as { message: string }
    expect(ssh.message).toContain('The host\'s own copy is mounted at /home/vscode/.ssh-host')
    expect((resolve('/home/vscode/.gitconfig') as { message: string }).message).toContain('/home/vscode/.gitconfig-host')
    expect((resolve('/tmp/foo') as { message: string }).message).not.toContain('own copy')
  })

  it('refuses a tmpfs of the environment\'s, which is its memory and nobody else\'s', () => {
    expect((resolve('/home/vscode/scratch/x') as { message: string }).message).toContain('is a tmpfs mount of this dev environment')
  })

  it('resolves `..` the way the kernel does, so ../shared lands where it really is', () => {
    expect(normalizeSource('/workspaces/app/../shared/')).toBe('/workspaces/shared')
    expect(normalizeSource('/workspaces/app/./db')).toBe('/workspaces/app/db')
    // Outside every mount: refused, by its real path.
    expect((resolve('/workspaces/app/../shared') as { message: string }).message).toMatch(/^\/workspaces\/shared exists only/)
    // Out of the checkout but into another mount: that mount's.
    expect(resolve('/workspaces/app/../../home/vscode/.aws/config'))
      .toEqual({ kind: 'bind', source: '/Users/me/.aws/config', readOnly: false })
    expect(resolve('/home/vscode/.cache/pnpm/../pnpm/store'))
      .toEqual({ kind: 'volume', volume: 'caches', subpath: 'env_abc/pnpm/store', readOnly: false })
  })
})

const scope: DoodScope = {
  workspacePath: '/workspaces/app',
  workspaceVolume: 'domo-dev-env_abc-workspace',
  labels: { 'domo.env': 'env_abc' },
  mounts: table,
  dockerSocket: SOCKET
}

const names = (environment: CreateNames['environment'] = { id: OWN_ID, ipcShareable: true }): CreateNames => ({
  name: null,
  container: ref => `env_abc-${ref}`,
  network: ref => `env_abc-${ref}`,
  volume: ref => `env_abc-${ref}`,
  environment
})

const hostConfigOf = (result: ReturnType<typeof rewriteContainerCreate>) => result.spec.HostConfig as Record<string, any>

describe('rewriteContainerCreate — binds outside the checkout', () => {
  it('translates every kind of short-syntax bind, and keeps its options', () => {
    const result = rewriteContainerCreate({
      HostConfig: {
        Binds: [
          '/home/vscode/.aws:/root/.aws:ro',
          '/home/vscode/.config/gh:/gh:rw,z',
          '/home/vscode/.cache/pnpm/store:/store',
          '/var/run/docker.sock:/var/run/docker.sock',
          '/etc/localtime:/etc/localtime:ro',
          '/workspaces/app/db:/docker-entrypoint-initdb.d:ro',
          'pgdata:/var/lib/postgresql/data'
        ]
      }
    }, scope, names())
    const hostConfig = hostConfigOf(result)
    expect(result.refusal).toBeUndefined()
    expect(hostConfig.Binds).toEqual([
      '/Users/me/.aws:/root/.aws:ro',
      '/Users/me/.config/gh:/gh:rw,z',
      `${SOCKET}:/var/run/docker.sock`,
      '/etc/localtime:/etc/localtime:ro',
      'env_abc-pgdata:/var/lib/postgresql/data'
    ])
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'caches', Target: '/store', ReadOnly: false, VolumeOptions: { Subpath: 'env_abc/pnpm/store' } },
      { Type: 'volume', Source: 'domo-dev-env_abc-workspace', Target: '/docker-entrypoint-initdb.d', ReadOnly: true, VolumeOptions: { Subpath: 'db' } }
    ])
    expect(result.requiredSubpaths).toEqual([
      { volume: 'caches', subpath: 'env_abc/pnpm/store' },
      { volume: 'domo-dev-env_abc-workspace', subpath: 'db' }
    ])
  })

  it('translates long-syntax binds, and moves the socket into Binds, where Docker Desktop accepts it', () => {
    const result = rewriteContainerCreate({
      HostConfig: {
        Mounts: [
          { Type: 'bind', Source: '/home/vscode/.aws', Target: '/root/.aws', ReadOnly: true },
          { Type: 'bind', Source: '/run/docker.sock', Target: '/var/run/docker.sock' },
          { Type: 'bind', Source: '/dev/fuse', Target: '/dev/fuse' },
          { Type: 'bind', Source: '/home/vscode/.cache/pnpm', Target: '/pnpm', BindOptions: { Propagation: 'rprivate' } },
          { Type: 'volume', Source: 'data', Target: '/data' },
          { Type: 'tmpfs', Target: '/run/cache' }
        ]
      }
    }, scope, names())
    const hostConfig = hostConfigOf(result)
    expect(hostConfig.Binds).toEqual([`${SOCKET}:/var/run/docker.sock`])
    expect(hostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/Users/me/.aws', Target: '/root/.aws', ReadOnly: true },
      { Type: 'bind', Source: '/dev/fuse', Target: '/dev/fuse' },
      { Type: 'volume', Source: 'caches', Target: '/pnpm', ReadOnly: false, VolumeOptions: { Subpath: 'env_abc/pnpm' } },
      { Type: 'volume', Source: 'env_abc-data', Target: '/data' },
      { Type: 'tmpfs', Target: '/run/cache' }
    ])
  })

  it('never makes a mount writable that the environment has read-only', () => {
    const result = rewriteContainerCreate({
      HostConfig: {
        Binds: ['/home/vscode/.gitconfig-host:/root/.gitconfig', '/opt/domo/node:/node:rw'],
        Mounts: [{ Type: 'bind', Source: '/home/vscode/.gitconfig-host', Target: '/g' }]
      }
    }, scope, names())
    const hostConfig = hostConfigOf(result)
    expect(hostConfig.Binds).toEqual(['/Users/me/.gitconfig:/root/.gitconfig:ro'])
    expect(hostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/Users/me/.gitconfig', Target: '/g', ReadOnly: true },
      { Type: 'volume', Source: 'domo-runtime-1234', Target: '/node', ReadOnly: true, VolumeOptions: { Subpath: 'node' } }
    ])
    // Nothing is created in a volume the environment could not write to either.
    expect(result.requiredSubpaths).toEqual([])
  })

  it('refuses the whole create when one source exists only in the environment, in either syntax', () => {
    expect(rewriteContainerCreate({ HostConfig: { Binds: ['/workspaces/app:/src', '/tmp/foo:/foo'] } }, scope, names()).refusal)
      .toMatch(/^\/tmp\/foo exists only inside this dev environment/)
    expect(rewriteContainerCreate({ HostConfig: { Mounts: [{ Type: 'bind', Source: '/home/vscode/cache', Target: '/c' }] } }, scope, names()).refusal)
      .toMatch(/^\/home\/vscode\/cache exists only inside this dev environment/)
  })

  it('keeps the binds exactly as asked on the label, for inspect', () => {
    const input = { HostConfig: { Binds: ['/home/vscode/.aws:/root/.aws:ro', '/var/run/docker.sock:/var/run/docker.sock'] } }
    const labels = rewriteContainerCreate(input, scope, names()).spec.Labels as Record<string, string>
    expect(JSON.parse(labels['domo.binds']!)).toEqual({ Binds: input.HostConfig.Binds })
  })
})

describe('rewriteContainerCreate — network_mode: host', () => {
  const HOST_SPEC = {
    Hostname: 'web',
    Domainname: 'example.test',
    MacAddress: '02:42:ac:11:00:02',
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: {
      NetworkMode: 'host',
      PortBindings: { '8080/tcp': [{ HostPort: '8080' }] },
      PublishAllPorts: true,
      ExtraHosts: ['api.test:10.0.0.1'],
      Dns: ['1.1.1.1'],
      DnsOptions: [],
      DnsSearch: ['example.test']
    },
    NetworkingConfig: { EndpointsConfig: { host: {} } }
  }

  it('shares the environment\'s network and drops everything Docker refuses beside it', () => {
    const result = rewriteContainerCreate(structuredClone(HOST_SPEC), scope, names())
    const hostConfig = hostConfigOf(result)
    expect(hostConfig.NetworkMode).toBe(`container:${OWN_ID}`)
    for (const field of ['ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch']) expect(hostConfig).not.toHaveProperty(field)
    expect(hostConfig.PortBindings).toEqual({})
    expect(hostConfig.PublishAllPorts).toBe(false)
    for (const field of ['Hostname', 'Domainname', 'MacAddress', 'ExposedPorts', 'NetworkingConfig']) {
      expect(result.spec).not.toHaveProperty(field)
    }
    expect(result.networksToJoin).toEqual([])
    // Nothing published, and so nothing for the publish layer to refuse as conflicting.
    expect(result.droppedPorts).toEqual([])
    const labels = result.spec.Labels as Record<string, string>
    expect(labels).not.toHaveProperty('domo.publishing')
    expect(labels).not.toHaveProperty('domo.ports')
    expect(JSON.parse(labels['domo.modes']!)).toEqual({
      NetworkMode: 'host',
      PortBindings: { '8080/tcp': [{ HostPort: '8080' }] },
      PublishAllPorts: true,
      ExtraHosts: ['api.test:10.0.0.1'],
      Dns: ['1.1.1.1'],
      DnsSearch: ['example.test']
    })
  })

  it('shares the environment\'s PID namespace for --pid host, and its IPC one when it can be joined', () => {
    const shareable = hostConfigOf(rewriteContainerCreate({ HostConfig: { PidMode: 'host', IpcMode: 'host' } }, scope, names()))
    expect(shareable.PidMode).toBe(`container:${OWN_ID}`)
    expect(shareable.IpcMode).toBe(`container:${OWN_ID}`)
    // An environment created before `--ipc shareable`: Docker would answer
    // "non-shareable IPC", so `--ipc host` keeps meaning the daemon's host.
    const legacy = rewriteContainerCreate({ HostConfig: { PidMode: 'host', IpcMode: 'host' } }, scope, names({ id: OWN_ID, ipcShareable: false }))
    expect(hostConfigOf(legacy).IpcMode).toBe('host')
    expect(JSON.parse((legacy.spec.Labels as Record<string, string>)['domo.modes']!)).toEqual({ PidMode: 'host' })
  })

  it('leaves a container: mode naming the environment itself resolved like any other reference', () => {
    const hostConfig = hostConfigOf(rewriteContainerCreate({ HostConfig: { NetworkMode: 'container:db' } }, scope, names()))
    expect(hostConfig.NetworkMode).toBe('container:env_abc-db')
  })

  it('refuses host networking when the environment\'s container cannot be found', () => {
    expect(rewriteContainerCreate(structuredClone(HOST_SPEC), scope, names(null)).refusal)
      .toMatch(/network_mode: host shares the environment's own network/)
  })

  it('is a pure decision on its own', () => {
    const spec: Record<string, unknown> = { Hostname: 'x' }
    const hostConfig: Record<string, unknown> = { NetworkMode: 'bridge', PidMode: 'host' }
    expect(hostModes(spec, hostConfig, { id: OWN_ID, ipcShareable: false })).toEqual({ requested: { PidMode: 'host' } })
    // Not host networking: the hostname stays.
    expect(spec.Hostname).toBe('x')
  })
})

describe('doodSocketPath', () => {
  it('refuses a path Docker Desktop could not forward into a container, which it would do silently', async () => {
    const { doodSocketPath } = await import('../../server/lib/dood/manager')
    const previous = process.env.NUXT_DOOD_SOCKET_DIR
    try {
      // 88 bytes connects, 89 is ECONNREFUSED inside the container (measured).
      process.env.NUXT_DOOD_SOCKET_DIR = `/${'d'.repeat(88 - '/'.length - '/env_abc.sock'.length)}`
      expect(doodSocketPath('env_abc')).toHaveLength(88)
      process.env.NUXT_DOOD_SOCKET_DIR += 'd'
      expect(() => doodSocketPath('env_abc')).toThrow(/too long for a unix socket a container can mount/)
    } finally {
      if (previous === undefined) delete process.env.NUXT_DOOD_SOCKET_DIR
      else process.env.NUXT_DOOD_SOCKET_DIR = previous
    }
  })
})

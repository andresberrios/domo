import { describe, expect, it } from 'vitest'

import type { EngineClient } from '../../server/lib/dood/engine'
import { parseRequestHead, type DoodRequest } from '../../server/lib/dood/http'
import { runLayers, type Outcome } from '../../server/lib/dood/layers'
import { namespaceFor } from '../../server/lib/dood/names'
import { scopeLayer } from '../../server/lib/dood/scope-layer'

/**
 * The scope layer's I/O decisions against a fake daemon: which requests it
 * resolves, answers, rewrites or creates things for. The daemon here holds the
 * environment's objects, another environment's, and the host's own.
 */

const ENV = 'env_abc'
const ns = namespaceFor(ENV)
const OWN_ID = 'e'.repeat(64)
const WEB_ID = 'a1'.padEnd(64, '0')
const THEIRS_ID = 'a2'.padEnd(64, '0')

function fakeEngine() {
  const calls: Array<{ method: string, path: string, body?: unknown }> = []
  const volumes = [{ Name: `${ENV}-data`, Labels: { 'domo.env': ENV } }]
  const engine: EngineClient = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.startsWith('/containers/json')) {
        // The layer asks for its own label; the daemon would filter by it.
        expect(decodeURIComponent(path)).toContain(`"domo.env=${ENV}":true`)
        return { status: 200, body: [{ Id: WEB_ID, Names: [`/${ENV}-web`] }] }
      }
      if (path === '/containers/domo-dev-env_abc/json') {
        return {
          status: 200,
          body: {
            Id: OWN_ID,
            Name: '/domo-dev-env_abc',
            HostConfig: { IpcMode: 'shareable' },
            Mounts: [
              { Type: 'volume', Name: 'domo-dev-env_abc-workspace', Destination: '/workspaces/domo', RW: true },
              { Type: 'volume', Name: 'caches', Destination: '/home/vscode/.cache', RW: true },
              { Type: 'bind', Source: '/Users/me/.aws', Destination: '/home/vscode/.aws', RW: true }
            ]
          }
        }
      }
      if (path === '/networks') {
        return {
          status: 200,
          body: [
            { Id: 'n'.repeat(64), Name: `${ENV}-stack_default`, Labels: { 'domo.env': ENV } },
            { Id: 'b'.repeat(64), Name: 'bridge', Labels: {} },
            { Id: 'o'.repeat(64), Name: 'domo_default', Labels: {} }
          ]
        }
      }
      if (path.startsWith('/volumes?')) return { status: 200, body: { Volumes: volumes } }
      if (path === '/volumes/create') return { status: 201, body: { Name: (body as any).Name } }
      if (path.startsWith('/networks/') && path.endsWith('/connect')) return { status: 200, body: null }
      return { status: 404, body: { message: 'unexpected' } }
    }
  }
  return { engine, calls }
}

function setup() {
  const { engine, calls } = fakeEngine()
  const subpaths: string[][] = []
  const volumes: string[] = []
  const layer = scopeLayer({
    ns,
    scope: {
      workspacePath: '/workspaces/domo',
      workspaceVolume: 'domo-dev-env_abc-workspace',
      labels: { 'domo.env': ENV },
      dockerSocket: '/sock/env_abc.sock'
    },
    engine,
    ownContainer: 'domo-dev-env_abc',
    ensureSubpaths: async (volume, list) => { volumes.push(volume); subpaths.push(list) }
  })
  const send = (line: string, body?: unknown): Promise<Outcome> => {
    const request = parseRequestHead(`${line} HTTP/1.1\r\nHost: docker`)!
    if (body !== undefined) request.body = Buffer.from(JSON.stringify(body))
    return runLayers([layer], request)
  }
  return { layer, calls, subpaths, volumes, send }
}

const forwarded = (outcome: Outcome): DoodRequest => {
  if (outcome.kind !== 'forward') throw new Error(`answered: ${JSON.stringify(outcome)}`)
  return outcome.request
}
const bodyOf = (request: DoodRequest) => JSON.parse(request.body!.toString())

describe('scope layer — references', () => {
  it('resolves a container name, an id prefix and the environment\'s own short id', async () => {
    const { send } = setup()
    expect(forwarded(await send('POST /v1.47/containers/web/start')).path).toBe(`/containers/${ENV}-web/start`)
    expect(forwarded(await send('GET /containers/a1/json')).path).toBe(`/containers/${WEB_ID}/json`)
    expect(forwarded(await send('GET /containers/eeeeeeeeeeee/json')).path).toBe(`/containers/${OWN_ID}/json`)
  })

  it('sends what it cannot find as a name that cannot exist, so the daemon answers its own 404', async () => {
    const { send } = setup()
    // Another environment's container, by id prefix, and the host's own, by name.
    expect(forwarded(await send('DELETE /containers/a2')).path).toBe(`/containers/${ENV}-a2`)
    expect(forwarded(await send('GET /containers/domo-postgres-1/json')).path).toBe(`/containers/${ENV}-domo-postgres-1/json`)
    expect(THEIRS_ID).not.toBe(WEB_ID)
  })

  it('refuses to stop, remove or rename the environment\'s own container', async () => {
    const { send } = setup()
    for (const line of ['POST /containers/eeeeeeeeeeee/stop', 'DELETE /containers/domo-dev-env_abc', 'POST /containers/eeee/rename?name=x']) {
      const outcome = await send(line)
      expect(outcome).toMatchObject({ kind: 'answer', status: 403 })
      expect((outcome as any).body.message).toMatch(/^Domo: .* this environment's own container/)
    }
    // Looking at it, or joining its network, is fine.
    expect((await send('GET /containers/eeeeeeeeeeee/json')).kind).toBe('forward')
  })

  it('namespaces a rename', async () => {
    const { send } = setup()
    expect(forwarded(await send('POST /containers/web/rename?name=api')).query.get('name')).toBe(`${ENV}-api`)
  })

  it('refuses swarm and a shared-cache prune loudly', async () => {
    const { send } = setup()
    expect(await send('POST /swarm/init')).toMatchObject({ kind: 'answer', status: 403 })
    expect(await send('POST /build/prune')).toMatchObject({ kind: 'answer', status: 403 })
  })
})

describe('scope layer — the legacy builder\'s network', () => {
  it('means the environment\'s own networks, containers and namespace', async () => {
    const { send } = setup()
    const mode = async (line: string) => forwarded(await send(line)).query.get('networkmode')
    expect(await mode('POST /build?networkmode=stack_default')).toBe(`${ENV}-stack_default`)
    expect(await mode('POST /build?networkmode=container:web')).toBe(`container:${ENV}-web`)
    expect(await mode('POST /build?networkmode=host')).toBe(`container:${OWN_ID}`)
    // BuildKit has no `container:` mode: its `host` stays the daemon's.
    expect(await mode('POST /build?networkmode=host&version=2')).toBe('host')
    for (const kept of ['default', 'bridge', 'none']) expect(await mode(`POST /build?networkmode=${kept}`)).toBe(kept)
    expect(await mode('POST /build?t=x')).toBeNull()
  })
})

describe('scope layer — container create', () => {
  it('names, resolves, creates the named volume first, and joins the network', async () => {
    const { send, calls, subpaths } = setup()
    const request = forwarded(await send('POST /containers/create?name=api', {
      Image: 'alpine',
      HostConfig: {
        NetworkMode: 'stack_default',
        Binds: ['data:/data', 'fresh:/fresh', '/workspaces/domo/app:/app'],
        Links: ['web:w']
      },
      NetworkingConfig: { EndpointsConfig: { stack_default: {} } }
    }))
    expect(request.query.get('name')).toBe(`${ENV}-api`)
    const spec = bodyOf(request)
    expect(spec.HostConfig.NetworkMode).toBe(`${ENV}-stack_default`)
    expect(spec.HostConfig.Binds).toEqual([`${ENV}-data:/data`, `${ENV}-fresh:/fresh`])
    expect(spec.HostConfig.Links).toEqual([`${ENV}-web:w`])
    expect(spec.NetworkingConfig.EndpointsConfig).toEqual({ [`${ENV}-stack_default`]: { Aliases: ['api'] } })
    expect(spec.Labels['domo.env']).toBe(ENV)

    // `data` exists already; `fresh` does not, and is made — labelled — first.
    const created = calls.filter(call => call.path === '/volumes/create')
    expect(created).toEqual([{ method: 'POST', path: '/volumes/create', body: { Name: `${ENV}-fresh`, Labels: { 'domo.env': ENV } } }])
    expect(calls).toContainEqual({ method: 'POST', path: `/networks/${ENV}-stack_default/connect`, body: { Container: OWN_ID } })
    expect(subpaths).toEqual([['app']])
  })

  it('resolves `container:` to the environment\'s own container by its hostname', async () => {
    const { send } = setup()
    const spec = bodyOf(forwarded(await send('POST /containers/create', { HostConfig: { NetworkMode: 'container:eeeeeeeeeeee' } })))
    expect(spec.HostConfig.NetworkMode).toBe(`container:${OWN_ID}`)
  })
})

describe('scope layer — lists and prunes', () => {
  it('narrows a container list and a prune to the environment\'s label', async () => {
    const { send } = setup()
    const list = forwarded(await send(`GET /containers/json?all=1&filters=${encodeURIComponent('{"label":{"com.docker.compose.project=s":true}}')}`))
    expect(JSON.parse(list.query.get('filters')!)).toEqual({
      label: { 'com.docker.compose.project=s': true, [`domo.env=${ENV}`]: true }
    })
    const prune = forwarded(await send('POST /volumes/prune'))
    expect(JSON.parse(prune.query.get('filters')!)).toEqual({ label: { [`domo.env=${ENV}`]: true } })
  })

  it('lists networks unnarrowed, so the builtins survive, and filters the answer', async () => {
    const { send } = setup()
    const outcome = await send('GET /networks')
    const request = forwarded(outcome)
    expect(request.query.get('filters')).toBe('{}')
    const answer = (outcome as any).response.json([
      { Name: `${ENV}-stack_default`, Labels: { 'domo.env': ENV } },
      { Name: 'bridge', Labels: {} },
      { Name: 'domo_default', Labels: {} }
    ])
    expect(answer.map((entry: any) => entry.Name)).toEqual(['stack_default', 'bridge'])
  })

  it('resolves a network before deleting it, and leaves it first', async () => {
    const { send, calls } = setup()
    expect(forwarded(await send('DELETE /networks/stack_default')).path).toBe(`/networks/${ENV}-stack_default`)
    expect(calls).toContainEqual({
      method: 'POST', path: `/networks/${'n'.repeat(64)}/disconnect`, body: { Container: OWN_ID, Force: true }
    })
  })

  it('aliases a container connected to a network by its own name', async () => {
    const { send } = setup()
    const request = forwarded(await send('POST /networks/stack_default/connect', { Container: 'web' }))
    expect(bodyOf(request)).toEqual({ Container: `${ENV}-web`, EndpointConfig: { Aliases: ['web'] } })
  })
})

describe('scope layer — binds and host namespaces', () => {
  it('resolves binds against the environment\'s own mounts, and makes subpaths in the volume they belong to', async () => {
    const { send, subpaths, volumes } = setup()
    const spec = bodyOf(forwarded(await send('POST /containers/create', {
      Image: 'alpine',
      HostConfig: {
        Binds: ['/home/vscode/.aws:/root/.aws:ro', '/home/vscode/.cache/pip:/pip', '/var/run/docker.sock:/var/run/docker.sock', '/workspaces/domo/app:/app']
      }
    })))
    expect(spec.HostConfig.Binds).toEqual(['/Users/me/.aws:/root/.aws:ro', '/sock/env_abc.sock:/var/run/docker.sock'])
    expect(spec.HostConfig.Mounts.map((mount: any) => [mount.Source, mount.VolumeOptions?.Subpath])).toEqual([
      ['caches', 'pip'],
      ['domo-dev-env_abc-workspace', 'app']
    ])
    expect(volumes).toEqual(['caches', 'domo-dev-env_abc-workspace'])
    expect(subpaths).toEqual([['pip'], ['app']])
  })

  it('answers a bind of the environment\'s own filesystem itself, loudly, and forwards nothing', async () => {
    const { send, calls } = setup()
    const outcome = await send('POST /containers/create?name=bad', {
      Image: 'alpine',
      HostConfig: { NetworkMode: 'stack_default', Binds: ['/home/vscode/cache:/cache'] }
    })
    expect(outcome).toMatchObject({ kind: 'answer', status: 400 })
    expect((outcome as any).body.message).toMatch(/^Domo: \/home\/vscode\/cache exists only inside this dev environment/)
    // Refused before anything was done on the daemon for it.
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it('puts a host-networked service in the environment\'s own namespace, by its real id', async () => {
    const { send } = setup()
    const spec = bodyOf(forwarded(await send('POST /containers/create', {
      Image: 'alpine', HostConfig: { NetworkMode: 'host', PidMode: 'host', IpcMode: 'host' }
    })))
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: `container:${OWN_ID}`, PidMode: `container:${OWN_ID}`, IpcMode: `container:${OWN_ID}`
    })
  })
})

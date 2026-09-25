import { describe, expect, it } from 'vitest'

import type { EngineClient } from '../../server/lib/dood/engine'
import { parseRequestHead, type DoodRequest } from '../../server/lib/dood/http'
import { imageLayer } from '../../server/lib/dood/image-layer'
import { privateName } from '../../server/lib/dood/images'
import { runLayers, type Outcome } from '../../server/lib/dood/layers'
import { namespaceFor } from '../../server/lib/dood/names'

/**
 * The image layer's decisions against a fake daemon holding the environment's
 * private images, another environment's, and shared ones: which name a
 * request ends up naming, what it refuses, and what it does around the
 * request (tagging for a push, retagging after a pull).
 */

const ENV = 'env_abc123'
const ns = namespaceFor(ENV)
const other = namespaceFor('env_def456')
const own = (name: string) => privateName(ns, name)!
const theirs = (name: string) => privateName(other, name)!

interface Image { Id: string, RepoTags: string[] }

function fakeEngine(initial: Image[], containers: Array<{ Id: string, ImageID: string, Labels?: Record<string, string> }> = []) {
  const images = initial.map(image => ({ ...image, RepoTags: [...image.RepoTags] }))
  const calls: string[] = []
  const find = (name: string) => images.find(image => image.RepoTags.includes(name) || image.RepoTags.includes(`${name}:latest`)
    || image.Id === name || image.Id === `sha256:${name}`)
  const decodeName = (raw: string) => raw.split('/').map(decodeURIComponent).join('/')
  const engine: EngineClient = {
    async request(method, path) {
      calls.push(`${method} ${path}`)
      const [route = '', search = ''] = path.split('?')
      const query = new URLSearchParams(search)
      if (method === 'GET' && route === '/images/json') return { status: 200, body: images }
      if (method === 'GET' && route === '/containers/json') return { status: 200, body: containers }
      let match = route.match(/^\/images\/(.+)\/json$/)
      if (method === 'GET' && match) {
        const image = find(decodeName(match[1]!))
        return image ? { status: 200, body: image } : { status: 404, body: { message: 'No such image' } }
      }
      match = route.match(/^\/images\/(.+)\/tag$/)
      if (method === 'POST' && match) {
        const image = find(decodeName(match[1]!))
        if (!image) return { status: 404, body: { message: 'No such image' } }
        const tag = `${query.get('repo')}:${query.get('tag')}`
        for (const each of images) each.RepoTags = each.RepoTags.filter(existing => existing !== tag)
        image.RepoTags.push(tag)
        return { status: 201, body: null }
      }
      match = route.match(/^\/images\/(.+)$/)
      if (method === 'DELETE' && match) {
        const name = decodeName(match[1]!)
        const image = find(name)
        if (!image) return { status: 404, body: { message: 'No such image' } }
        image.RepoTags = image.RepoTags.filter(tag => tag !== name)
        return { status: 200, body: [{ Untagged: name }] }
      }
      return { status: 404, body: { message: `unexpected ${method} ${path}` } }
    }
  }
  return { engine, calls, images }
}

const request = (line: string, body?: unknown): DoodRequest => {
  const parsed = parseRequestHead(`${line} HTTP/1.1\r\nHost: docker`)!
  if (body !== undefined) parsed.body = Buffer.from(JSON.stringify(body))
  return parsed
}

async function handle(engine: EngineClient, req: DoodRequest): Promise<Outcome> {
  return runLayers([imageLayer({ ns, engine })], req)
}

const forwarded = (outcome: Outcome) => {
  if (outcome.kind !== 'forward') throw new Error(`answered ${outcome.status}: ${JSON.stringify(outcome.body)}`)
  return outcome
}
const target = (outcome: Outcome) => {
  const { request } = forwarded(outcome)
  const query = request.query.toString()
  return `${request.method} ${decodeURIComponent(request.path)}${query ? `?${decodeURIComponent(query)}` : ''}`
}

const IMAGES: Image[] = [
  { Id: 'sha256:own', RepoTags: [own('app:dev')] },
  { Id: 'sha256:theirs', RepoTags: [theirs('app:dev')] },
  { Id: 'sha256:shared', RepoTags: ['app:dev', 'postgres:17'] },
  { Id: 'sha256:alpine', RepoTags: ['alpine:3', own('mine:1')] },
  { Id: 'sha256:mixed', RepoTags: [own('both:1'), theirs('both:1')] },
  { Id: 'sha256:foreign', RepoTags: [theirs('only:1')] },
  { Id: 'sha256:unused', RepoTags: ['unused:1'] }
]

describe('consuming a name', () => {
  it('creates a container from the environment\'s own image, and remembers what was asked for', async () => {
    const { engine } = fakeEngine(IMAGES)
    const create = forwarded(await handle(engine, request('POST /v1.47/containers/create', { Image: 'app:dev', Labels: { a: 'b' } })))
    expect(JSON.parse(create.request.body!.toString())).toEqual({ Image: own('app:dev'), Labels: { a: 'b', 'domo.image': 'app:dev' } })
    const shared = forwarded(await handle(engine, request('POST /containers/create', { Image: 'postgres:17' })))
    expect(JSON.parse(shared.request.body!.toString())).toEqual({ Image: 'postgres:17' })
  })

  it('inspects, saves and tags from its own image first, else the shared one', async () => {
    const { engine } = fakeEngine(IMAGES)
    expect(target(await handle(engine, request('GET /images/app:dev/json')))).toBe(`GET /images/${own('app:dev')}/json`)
    expect(target(await handle(engine, request('GET /images/postgres:17/json')))).toBe('GET /images/postgres:17/json')
    expect(target(await handle(engine, request('GET /images/app:dev/history')))).toBe(`GET /images/${own('app:dev')}/history`)
    expect(target(await handle(engine, request('GET /images/get?names=app:dev&names=postgres:17'))))
      .toBe(`GET /images/get?names=${own('app:dev')}&names=postgres:17`)
    const saved = forwarded(await handle(engine, request('GET /images/app:dev/get')))
    expect(saved.response?.stream).toBeTypeOf('function')
    // A registry name with a port, slashes in the path and all.
    expect(target(await handle(engine, request('GET /images/localhost:5000/team/app:1/json')))).toBe('GET /images/localhost:5000/team/app:1/json')
  })
})

describe('producing a name', () => {
  it('tags, commits, imports and builds under private names', async () => {
    const { engine } = fakeEngine(IMAGES)
    expect(target(await handle(engine, request('POST /images/app:dev/tag?repo=ghcr.io/o/app&tag=1'))))
      .toBe(`POST /images/${own('app:dev')}/tag?repo=domo-env_abc123/ghcr.io/o/app&tag=1`)
    expect(target(await handle(engine, request('POST /images/alpine:3/tag?repo=mine'))))
      .toBe('POST /images/alpine:3/tag?repo=domo-env_abc123/docker.io/library/mine&tag=latest')
    expect(target(await handle(engine, request('POST /commit?container=c1&repo=snap&tag=2'))))
      .toBe('POST /commit?container=c1&repo=domo-env_abc123/docker.io/library/snap&tag=2')
    expect(target(await handle(engine, request('POST /images/create?fromSrc=-&repo=imported:3'))))
      .toBe('POST /images/create?fromSrc=-&repo=domo-env_abc123/docker.io/library/imported&tag=3')
    expect(target(await handle(engine, request('POST /build?t=app:dev&t=localhost:5000/x&cachefrom=["app:dev","other:1"]'))))
      .toBe(`POST /build?cachefrom=["${own('app:dev')}","other:1"]&t=${own('app:dev')}&t=domo-env_abc123/localhost__5000/x:latest`)
  })

  it('refuses a name it cannot make private, loudly, rather than tagging one everyone shares', async () => {
    const { engine } = fakeEngine(IMAGES)
    const refused = await handle(engine, request('POST /images/alpine:3/tag?repo=[::1]:5000/x&tag=1'))
    expect(refused).toMatchObject({ kind: 'answer', status: 400, body: { message: expect.stringMatching(/^Domo: \[::1\]:5000\/x:1 cannot be given a name/) } })
  })

  it('loads an archive through a rewriter of its names', async () => {
    const { engine } = fakeEngine(IMAGES)
    const load = forwarded(await handle(engine, request('POST /images/load?quiet=1')))
    expect(load.requestBody).toBeDefined()
    expect(load.response?.line).toBeTypeOf('function')
  })

  it('takes the build channel over once the daemon agrees to the upgrade', async () => {
    const { engine } = fakeEngine(IMAGES)
    const upgrade = parseRequestHead('POST /grpc HTTP/1.1\r\nUpgrade: h2c\r\nConnection: Upgrade')!
    expect(forwarded(await handle(engine, upgrade)).response?.hijack).toBeTypeOf('function')
    // `/session` stays a splice.
    const session = parseRequestHead('POST /session HTTP/1.1\r\nUpgrade: h2c\r\nConnection: Upgrade')!
    expect(forwarded(await handle(engine, session)).response).toBeUndefined()
  })
})

describe('docker images', () => {
  it('applies a reference filter itself, and passes every other filter on', async () => {
    const { engine, calls } = fakeEngine(IMAGES)
    const byName = forwarded(await handle(engine, request(`GET /images/json?filters=${encodeURIComponent('{"reference":{"app":true}}')}`)))
    expect(byName.request.query.get('filters')).toBeNull()
    expect((byName.response!.json!(IMAGES) as any[]).map(image => image.Id)).toEqual(['sha256:own'])
    expect(calls).toEqual([])

    const dangling = forwarded(await handle(engine, request(`GET /images/json?filters=${encodeURIComponent('{"dangling":{"false":true},"reference":{"app":true}}')}`)))
    expect(JSON.parse(dangling.request.query.get('filters')!)).toEqual({ dangling: { false: true } })
    // Filtered by the daemon, the list may lack the private image that shadows a shared one: fetched whole, once.
    expect(calls).toEqual(['GET /images/json'])
    expect(dangling.response!.json!([IMAGES[2]])).toEqual([])
  })
})

describe('rmi', () => {
  it('removes the environment\'s own tag as asked', async () => {
    const { engine } = fakeEngine(IMAGES)
    expect(target(await handle(engine, request('DELETE /images/app:dev?force=1')))).toBe(`DELETE /images/${own('app:dev')}?force=1`)
  })

  it('removes a shared name nothing outside the environment runs on, unforced', async () => {
    const { engine } = fakeEngine(IMAGES, [{ Id: 'mine', ImageID: 'sha256:unused', Labels: { 'domo.env': ENV } }])
    expect(target(await handle(engine, request('DELETE /images/unused:1?force=1&noprune=0')))).toBe('DELETE /images/unused:1?noprune=0')
  })

  it('refuses a shared image a container outside the environment runs on, by name or by id', async () => {
    const { engine } = fakeEngine(IMAGES, [{ Id: 'hosts', ImageID: 'sha256:alpine' }, { Id: 'b', ImageID: 'sha256:alpine', Labels: { 'domo.env': 'env_def456' } }])
    for (const line of ['DELETE /images/alpine:3', 'DELETE /images/alpine:3?force=1', 'DELETE /images/sha256:alpine?force=1']) {
      expect(await handle(engine, request(line))).toMatchObject({
        kind: 'answer', status: 409, body: { message: expect.stringContaining('and 2 containers outside this environment run on it') }
      })
    }
  })

  it('by id, removes an image only the environment names, untags one another environment names too, and cannot see one it does not', async () => {
    const { engine, images } = fakeEngine(IMAGES)
    expect(target(await handle(engine, request('DELETE /images/sha256:own?force=1')))).toBe('DELETE /images/sha256:own?force=1')
    const mixed = await handle(engine, request('DELETE /images/sha256:mixed?force=1'))
    expect(mixed).toEqual({ kind: 'answer', status: 200, body: [{ Untagged: 'both:1' }] })
    expect(images.find(image => image.Id === 'sha256:mixed')!.RepoTags).toEqual([theirs('both:1')])
    expect(await handle(engine, request('DELETE /images/sha256:foreign'))).toMatchObject({ kind: 'answer', status: 404 })
    // Not there at all: the daemon's own answer.
    expect(target(await handle(engine, request('DELETE /images/nothing:1')))).toBe('DELETE /images/nothing:1')
  })
})

describe('push', () => {
  it('tags the real name for the push and takes it away after, when nothing had it', async () => {
    const { engine, images } = fakeEngine([...IMAGES, { Id: 'sha256:built', RepoTags: [own('localhost:5000/app:1')] }])
    const push = forwarded(await handle(engine, request('POST /images/localhost:5000/app/push?tag=1')))
    expect(images.find(image => image.Id === 'sha256:built')!.RepoTags).toContain('localhost:5000/app:1')
    await push.response!.after!(200)
    expect(images.find(image => image.Id === 'sha256:built')!.RepoTags).toEqual([own('localhost:5000/app:1')])
  })

  it('puts a shared tag of that name back where it was', async () => {
    const { engine, images } = fakeEngine(IMAGES)
    const push = forwarded(await handle(engine, request('POST /images/app/push?tag=dev')))
    expect(images.find(image => image.Id === 'sha256:own')!.RepoTags).toContain('app:dev')
    await push.response!.after!(200)
    expect(images.find(image => image.Id === 'sha256:shared')!.RepoTags).toContain('app:dev')
    expect(images.find(image => image.Id === 'sha256:own')!.RepoTags).toEqual([own('app:dev')])
  })

  it('pushes a shared image as it is, and refuses --all-tags of a repository the environment holds', async () => {
    const { engine } = fakeEngine(IMAGES)
    expect(target(await handle(engine, request('POST /images/postgres/push?tag=17')))).toBe('POST /images/postgres/push?tag=17')
    expect(await handle(engine, request('POST /images/app/push'))).toMatchObject({ kind: 'answer', status: 400 })
    expect(target(await handle(engine, request('POST /images/postgres/push')))).toBe('POST /images/postgres/push')
  })
})

describe('pull', () => {
  it('stays shared, and moves the environment\'s own tag of that name to what was pulled once it succeeded', async () => {
    const { engine, images } = fakeEngine(IMAGES)
    const pull = forwarded(await handle(engine, request('POST /images/create?fromImage=app&tag=dev')))
    expect(target(pull)).toBe('POST /images/create?fromImage=app&tag=dev')
    pull.response!.line!({ status: 'Pulling' })
    await pull.response!.after!(200)
    expect(images.find(image => image.Id === 'sha256:shared')!.RepoTags).toContain(own('app:dev'))
  })

  it('leaves the environment\'s own tag alone when the pull failed', async () => {
    const { engine, images } = fakeEngine(IMAGES)
    const pull = forwarded(await handle(engine, request('POST /images/create?fromImage=app&tag=dev')))
    pull.response!.line!({ errorDetail: { message: 'not found' }, error: 'not found' })
    await pull.response!.after!(200)
    expect(images.find(image => image.Id === 'sha256:own')!.RepoTags).toEqual([own('app:dev')])
  })

  it('does nothing around a pull of a name the environment never built', async () => {
    const { engine } = fakeEngine(IMAGES)
    expect(forwarded(await handle(engine, request('POST /images/create?fromImage=redis&tag=7'))).response).toBeUndefined()
  })
})

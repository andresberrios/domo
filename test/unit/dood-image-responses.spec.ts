import { describe, expect, it } from 'vitest'

import {
  archiveNamesForAgent,
  archiveNamesForDaemon,
  containerImageForAgent,
  containerListImagesForAgent,
  deepText,
  imageDeleteForAgent,
  imageEventForAgent,
  imageHistoryForAgent,
  imageInspectForAgent,
  imageListForAgent,
  systemDfImagesForAgent
} from '../../server/lib/dood/image-responses'
import { privateName, unprivateText } from '../../server/lib/dood/images'
import { namespaceFor } from '../../server/lib/dood/names'

/**
 * What an environment is shown of the daemon's images: its own private names
 * unprefixed, everyone else's gone, the shared ones as they are.
 */

const ns = namespaceFor('env_abc123')
const other = namespaceFor('env_def456')
const own = (name: string) => privateName(ns, name)!
const theirs = (name: string) => privateName(other, name)!

const images = [
  { Id: 'sha256:1', RepoTags: [own('app:dev')], RepoDigests: [] },
  { Id: 'sha256:2', RepoTags: [theirs('app:dev')], RepoDigests: [] },
  // A shared image with the same name as the environment's own: the agent's `app:dev` is its own build.
  { Id: 'sha256:3', RepoTags: ['app:dev'], RepoDigests: ['app@sha256:aa'] },
  { Id: 'sha256:4', RepoTags: ['alpine:3', own('mine:1'), theirs('theirs:1')], RepoDigests: ['alpine@sha256:bb'] },
  // Dangling: nobody's name, shown as it is.
  { Id: 'sha256:5', RepoTags: [], RepoDigests: [] },
  { Id: 'sha256:6', RepoTags: ['<none>:<none>'], RepoDigests: ['<none>@<none>'] }
]

describe('image lists', () => {
  it('shows the environment\'s own names, hides another\'s and a shared namesake, and keeps dangling images', () => {
    const out = imageListForAgent(ns, images, {}) as any[]
    expect(out.map(image => [image.Id, image.RepoTags])).toEqual([
      ['sha256:1', ['app:dev']],
      ['sha256:4', ['alpine:3', 'mine:1']],
      ['sha256:5', []],
      ['sha256:6', ['<none>:<none>']]
    ])
  })

  it('filters by reference itself, narrowing the names and digests it lists as the daemon does', () => {
    const byName = imageListForAgent(ns, images, { references: ['mine'] }) as any[]
    expect(byName).toEqual([{ Id: 'sha256:4', RepoTags: ['mine:1'], RepoDigests: [] }])
    const byGlob = imageListForAgent(ns, images, { references: ['a*'] }) as any[]
    expect(byGlob.map(image => [image.Id, image.RepoTags, image.RepoDigests]))
      .toEqual([['sha256:1', ['app:dev'], []], ['sha256:4', ['alpine:3'], ['alpine@sha256:bb']]])
  })

  it('takes the shadowed names from outside when the list itself was filtered', () => {
    const out = imageListForAgent(ns, [images[2]], { shadowed: new Set(['app:dev']) }) as any[]
    expect(out).toEqual([])
  })

  it('does the same inside system df, in both its shapes', () => {
    const legacy = systemDfImagesForAgent(ns, { Images: images, LayersSize: 1 }) as any
    expect(legacy.Images.map((image: any) => image.Id)).toEqual(['sha256:1', 'sha256:4', 'sha256:5', 'sha256:6'])
    const current = systemDfImagesForAgent(ns, { ImageUsage: { TotalCount: 6, Items: images } }) as any
    expect(current.ImageUsage.Items.map((image: any) => image.Id)).toEqual(['sha256:1', 'sha256:4', 'sha256:5', 'sha256:6'])
    expect(current.ImageUsage.TotalCount).toBe(6)
  })
})

describe('one image', () => {
  it('inspects under the names the environment knows', () => {
    const body = { Id: 'sha256:4', RepoTags: images[3]!.RepoTags, RepoDigests: [`${own("mine").replace(/:latest$/, "")}@sha256:cc`, "alpine@sha256:bb", `${theirs("x").replace(/:latest$/, "")}@sha256:dd`] }
    expect(imageInspectForAgent(ns, body)).toEqual({ Id: 'sha256:4', RepoTags: ['alpine:3', 'mine:1'], RepoDigests: ['mine@sha256:cc', 'alpine@sha256:bb'] })
  })

  it('shows history tags and removal reports the same way', () => {
    expect(imageHistoryForAgent(ns, [{ Id: 'x', Tags: [own('app:dev'), theirs('app:dev')] }, { Id: 'y', Tags: null }]))
      .toEqual([{ Id: 'x', Tags: ['app:dev'] }, { Id: 'y', Tags: null }])
    expect(imageDeleteForAgent(ns, [{ Untagged: own('app:dev') }, { Untagged: theirs('app:dev') }, { Deleted: 'sha256:1' }]))
      .toEqual([{ Untagged: 'app:dev' }, { Deleted: 'sha256:1' }])
    expect(imageDeleteForAgent(ns, { ImagesDeleted: [{ Untagged: own('x:1') }], SpaceReclaimed: 3 }))
      .toEqual({ ImagesDeleted: [{ Untagged: 'x:1' }], SpaceReclaimed: 3 })
  })
})

describe('containers', () => {
  it('report the image they were created from as the client asked for it', () => {
    const inspect = { Id: 'c', Config: { Image: own('app:dev'), Labels: { 'domo.image': 'app:dev' } } }
    expect((containerImageForAgent(ns, inspect) as any).Config.Image).toBe('app:dev')
    // No label (created before this change, or by name of a shared image): the name is still put back.
    expect((containerImageForAgent(ns, { Config: { Image: own('app:dev') } }) as any).Config.Image).toBe('app:dev')
    expect(containerListImagesForAgent(ns, [{ Image: own('app:dev'), Labels: { 'domo.image': 'app' } }, { Image: 'sha256:9' }]))
      .toEqual([{ Image: 'app', Labels: { 'domo.image': 'app' } }, { Image: 'sha256:9' }])
  })
})

describe('events', () => {
  it('drops another environment\'s image events and unprefixes the environment\'s own', () => {
    expect(imageEventForAgent(ns, { Type: 'image', Action: 'tag', Actor: { ID: 'sha256:1', Attributes: { name: theirs('app:dev') } } })).toBeNull()
    expect(imageEventForAgent(ns, { Type: 'image', Action: 'tag', Actor: { ID: 'sha256:1', Attributes: { name: own('app:dev') } } }))
      .toEqual({ Type: 'image', Action: 'tag', Actor: { ID: 'sha256:1', Attributes: { name: 'app:dev' } } })
    const pull = { Type: 'image', Action: 'pull', id: 'alpine:3', Actor: { ID: 'alpine:3', Attributes: { name: 'alpine' } } }
    expect(imageEventForAgent(ns, pull)).toEqual(pull)
  })

  it('names a container\'s image as it was asked for', () => {
    const event = { Type: 'container', Action: 'create', from: own('app:dev'), Actor: { ID: 'c', Attributes: { image: own('app:dev'), 'domo.image': 'app:dev', name: 'x' } } }
    expect(imageEventForAgent(ns, event)).toMatchObject({ from: 'app:dev', Actor: { Attributes: { image: 'app:dev', name: 'x' } } })
    const network = { Type: 'network', Action: 'connect', Actor: { ID: 'n', Attributes: {} } }
    expect(imageEventForAgent(ns, network)).toBe(network)
  })
})

describe('image archives', () => {
  it('saves the environment\'s names as the agent used them, and none of another\'s', () => {
    const names = archiveNamesForAgent(ns)
    expect(names.rewrite('manifest.json', [{ RepoTags: [own('app:dev'), theirs('x:1'), 'alpine:3'] }]))
      .toEqual([{ RepoTags: ['app:dev', 'alpine:3'] }])
    expect(names.rewrite('index.json', {
      manifests: [
        { annotations: { 'io.containerd.image.name': `docker.io/${own('app:dev')}`, 'org.opencontainers.image.ref.name': 'dev' } },
        { annotations: { 'io.containerd.image.name': `docker.io/${theirs('app:dev')}` } },
        { digest: 'x' }
      ]
    })).toEqual({
      manifests: [
        { annotations: { 'io.containerd.image.name': 'docker.io/library/app:dev', 'org.opencontainers.image.ref.name': 'dev' } },
        { annotations: {} },
        { digest: 'x' }
      ]
    })
    expect(names.rewrite('repositories', { [own('app').split(':')[0]!]: { latest: 'a' }, alpine: { 3: 'b' } }))
      .toEqual({ app: { latest: 'a' }, alpine: { 3: 'b' } })
  })

  it('loads every name as the environment\'s own, and reports one it cannot make private', () => {
    const unnamed: string[] = []
    const names = archiveNamesForDaemon(ns, name => unnamed.push(name))
    expect(names.rewrite('manifest.json', [{ RepoTags: ['app:dev', 'ghcr.io/o/a:1', '[::1]:5000/x:1'] }]))
      .toEqual([{ RepoTags: [own('app:dev'), own('ghcr.io/o/a:1'), '[::1]:5000/x:1'] }])
    expect(unnamed).toEqual(['[::1]:5000/x:1'])
    expect(names.rewrite('index.json', {
      manifests: [{ annotations: { 'io.containerd.image.name': 'docker.io/library/app:dev', 'org.opencontainers.image.ref.name': 'app:dev' } }]
    })).toEqual({
      manifests: [{ annotations: { 'io.containerd.image.name': `docker.io/${own('app:dev')}`, 'org.opencontainers.image.ref.name': `docker.io/${own('app:dev')}` } }]
    })
    expect(names.rewrite('repositories', { app: { dev: 'a' } })).toEqual({ 'domo-env_abc123/docker.io/library/app': { dev: 'a' } })
  })
})

it('rewrites every string of a progress message', () => {
  expect(deepText({ stream: `Loaded image: ${own('app:dev')}\n`, aux: { ID: 'sha256:1' }, n: 3 }, text => unprivateText(ns, text)))
    .toEqual({ stream: 'Loaded image: app:dev\n', aux: { ID: 'sha256:1' }, n: 3 })
})

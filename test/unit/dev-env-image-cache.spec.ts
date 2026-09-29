import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An environment whose definition built an image before is tagged from that
 * image instead of built. The daemon is a fake that keeps its images, so what
 * is asserted is what a real one would then hold.
 */

const images = new Map<string, { id: string, created: string }>()
let builds = 0

const run = vi.fn(async (program: string, args: string[]) => {
  const fail = () => ({ stdout: '', stderr: 'No such image' })
  if (program === process.execPath) {
    builds++
    images.set(args[args.indexOf('--image-name') + 1]!, { id: `sha256:built${builds}`, created: new Date().toISOString() })
    return { stdout: '{"outcome":"success"}', stderr: '' }
  }
  if (args[0] === 'image' && args[1] === 'inspect') {
    const image = images.get(args.at(-1)!)
    if (!image) return fail()
    return { stdout: args[3] === '{{.Id}}' ? image.id : image.created, stderr: '' }
  }
  if (args[0] === 'tag') {
    images.set(args[2]!, images.get(args[1]!)!)
    return { stdout: '', stderr: '' }
  }
  if (args[0] === 'image' && args[1] === 'ls') {
    return { stdout: [...images.keys()].filter(name => name.startsWith('domo-dev-image-')).join('\n'), stderr: '' }
  }
  if (args[0] === 'image' && args[1] === 'rm') {
    images.delete(args[2]!)
    return { stdout: '', stderr: '' }
  }
  throw new Error(`unexpected ${program} ${args.join(' ')}`)
})

vi.mock('../../server/lib/dev-env/docker', () => ({ run, resourcePrefix: () => 'domo-dev-' }))

const { defaultEnvironmentConfig } = await import('../../server/lib/dev-env/config')
const { buildEnvironmentImage, collectCachedImages, CACHED_IMAGE_MAX_AGE_MS } = await import('../../server/lib/dev-env/image')

const config = defaultEnvironmentConfig()
const create = (environmentId: string, overrides = {}) =>
  buildEnvironmentImage({ config: { ...config, ...overrides }, environmentId, name: environmentId, repoPath: '/repo' })
const cached = () => [...images.keys()].filter(name => name.startsWith('domo-dev-image-'))

beforeEach(() => {
  images.clear()
  images.set(config.image!, { id: 'sha256:base', created: new Date().toISOString() })
  builds = 0
  run.mockClear()
})

describe('buildEnvironmentImage', () => {
  it('builds a definition once, and tags every later environment with it from that image', async () => {
    await expect(create('env_1')).resolves.toBe('domo-dev-env_1')
    await expect(create('env_2')).resolves.toBe('domo-dev-env_2')

    expect(builds).toBe(1)
    expect(images.get('domo-dev-env_2')).toEqual(images.get('domo-dev-env_1'))
    expect(cached()).toHaveLength(1)
  })

  it('builds again for another definition, a newer base, or a cached image past its age', async () => {
    await create('env_1')
    await create('env_2', { features: { 'ghcr.io/devcontainers/features/python:1': {} } })
    expect(builds).toBe(2)

    images.set(config.image!, { id: 'sha256:newer-base', created: new Date().toISOString() })
    await create('env_3')
    expect(builds).toBe(3)

    for (const name of cached()) {
      images.set(name, { ...images.get(name)!, created: new Date(Date.now() - CACHED_IMAGE_MAX_AGE_MS - 1000).toISOString() })
    }
    await create('env_4')
    expect(builds).toBe(4)
  })

  it('always builds from a Dockerfile, whose context can change with nothing in the definition changing', async () => {
    const build = { image: undefined, build: { dockerfile: 'Dockerfile', context: '.' } }
    await create('env_1', build)
    await create('env_2', build)

    expect(builds).toBe(2)
    expect(cached()).toEqual([])
  })
})

describe('collectCachedImages', () => {
  it('untags cached images past their age, and leaves the rest', async () => {
    await create('env_1')
    await create('env_2', { features: {} })
    const [old] = cached()
    images.set(old!, { ...images.get(old!)!, created: new Date(Date.now() - CACHED_IMAGE_MAX_AGE_MS - 1000).toISOString() })

    await collectCachedImages()

    expect(cached()).toHaveLength(1)
    expect(cached()).not.toContain(old)
    // The environment built from it keeps its own tag.
    expect(images.has('domo-dev-env_1')).toBe(true)
  })
})

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildFeatures,
  DEFAULT_IMAGE,
  defaultEnvironmentConfig,
  DIND_FEATURE,
  DOMO_CONFIG_FILE,
  parseForwardPort,
  resolveEnvironmentConfig,
  resolveForwardPorts
} from '../../server/lib/dev-env/config'

/**
 * `.domo.json` is the only environment definition Domo reads. A project's
 * `.devcontainer/devcontainer.json` is not consulted at all, and anything in
 * `devEnvironment` that Domo does not implement is an error rather than something
 * silently dropped — a config that looks honoured but is not is worse than a refusal.
 */

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'domo-dev-env-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function write(relativePath: string, contents: string) {
  const path = join(workspace, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents, 'utf8')
  return path
}

async function domoJson(devEnvironment: unknown) {
  await write(DOMO_CONFIG_FILE, JSON.stringify({ devEnvironment }))
  return resolveEnvironmentConfig(workspace)
}

describe('the default configuration', () => {
  it('is what a project with no .domo.json gets', async () => {
    await expect(resolveEnvironmentConfig(workspace)).resolves.toEqual({
      source: 'default',
      path: null,
      displayPath: null,
      config: {
        image: DEFAULT_IMAGE,
        features: {
          'ghcr.io/devcontainers/features/node:1': { version: '22' },
          'ghcr.io/devcontainers/features/github-cli:1': { version: 'latest' }
        },
        docker: true,
        containerEnv: {},
        forwardPorts: [],
        portsAttributes: {}
      }
    })
  })

  it('is also what a .domo.json about something else entirely gets', async () => {
    await write(DOMO_CONFIG_FILE, '{ "somethingElse": true }')

    await expect(resolveEnvironmentConfig(workspace)).resolves.toMatchObject({ source: 'default' })
  })

  it('does not read a project\'s own devcontainer.json', async () => {
    await write('.devcontainer/devcontainer.json', '{ "image": "node:22" }')
    await write('.devcontainer.json', '{ "image": "node:18" }')

    await expect(resolveEnvironmentConfig(workspace)).resolves.toMatchObject({
      source: 'default',
      config: { image: DEFAULT_IMAGE }
    })
  })
})

describe('resolveEnvironmentConfig', () => {
  it('takes a .domo.json exactly as written', async () => {
    const resolved = await domoJson({
      image: '  ghcr.io/acme/dev:latest  ',
      features: { 'ghcr.io/devcontainers/features/python:1': {} },
      remoteUser: 'dev',
      containerEnv: { API_URL: 'http://localhost:3000' },
      forwardPorts: [3000, '5432/tcp'],
      portsAttributes: { 3000: { label: 'web', protocol: 'http' } },
      postCreateCommand: 'pnpm install'
    })

    expect(resolved).toEqual({
      source: 'domo',
      path: join(workspace, DOMO_CONFIG_FILE),
      displayPath: DOMO_CONFIG_FILE,
      config: {
        image: 'ghcr.io/acme/dev:latest',
        features: { 'ghcr.io/devcontainers/features/python:1': {} },
        // Nothing is injected: a project that wrote a config gets that config.
        docker: false,
        remoteUser: 'dev',
        containerEnv: { API_URL: 'http://localhost:3000' },
        forwardPorts: [3000, '5432/tcp'],
        portsAttributes: { 3000: { label: 'web', protocol: 'http' } },
        postCreateCommand: 'pnpm install'
      }
    })
  })

  it('fills in the build context and keeps args and target', async () => {
    const resolved = await domoJson({
      build: { dockerfile: 'Dockerfile.dev', args: { MARK: 'yes' }, target: 'dev' }
    })

    expect(resolved.config.build).toEqual({
      dockerfile: 'Dockerfile.dev',
      context: '.',
      args: { MARK: 'yes' },
      target: 'dev'
    })
  })

  it('reads JSONC: comments and trailing commas', async () => {
    await write(DOMO_CONFIG_FILE, `{
      // the image the team uses
      "devEnvironment": {
        "image": "node:22",
        /* block comments too */
        "forwardPorts": [3000,],
      },
    }`)

    const resolved = await resolveEnvironmentConfig(workspace)

    expect(resolved.config).toMatchObject({ image: 'node:22', forwardPorts: [3000] })
  })

  it('names the offending file when the JSON is broken', async () => {
    await write(DOMO_CONFIG_FILE, '{ "devEnvironment": }')

    await expect(resolveEnvironmentConfig(workspace)).rejects.toThrow(/Invalid JSONC in .*\.domo\.json/)
  })

  it('rejects a file that is not a JSON object', async () => {
    await write(DOMO_CONFIG_FILE, '["node:22"]')

    await expect(resolveEnvironmentConfig(workspace)).rejects.toThrow(/must contain a JSON object/)
  })
})

describe('validation', () => {
  it('names every unsupported key, and lists the ones that exist', async () => {
    const failure = domoJson({ image: 'node:22', mounts: [], runArgs: ['--gpus=all'] })

    await expect(failure).rejects.toThrow(/does not support "mounts", "runArgs"/)
    await expect(failure).rejects.toThrow(/Supported keys are: image, build, features, docker, remoteUser/)
  })

  it.each([
    ['neither image nor build', {}],
    ['both image and build', { image: 'node:22', build: { dockerfile: 'Dockerfile' } }]
  ])('refuses %s', async (_label, config) => {
    await expect(domoJson(config)).rejects.toThrow(/needs exactly one of "image" or "build"/)
  })

  it.each([
    ['image', { image: 42 }, /image must be a non-empty string/],
    ['image', { image: '  ' }, /image must be a non-empty string/],
    ['build', { build: 'Dockerfile' }, /build must be an object/],
    ['build.dockerfile', { build: {} }, /build\.dockerfile must be a non-empty string/],
    ['build', { build: { dockerfile: 'D', cacheFrom: 'x' } }, /build does not support "cacheFrom"/],
    ['build.args', { build: { dockerfile: 'D', args: { A: 1 } } }, /build\.args\.A must be a string/],
    ['features', { image: 'i', features: [] }, /features must be an object/],
    ['docker', { image: 'i', docker: 'yes' }, /docker must be true or false/],
    ['remoteUser', { image: 'i', remoteUser: '' }, /remoteUser must be a non-empty string/],
    ['containerEnv', { image: 'i', containerEnv: { A: 1 } }, /containerEnv\.A must be a string/],
    ['forwardPorts', { image: 'i', forwardPorts: 3000 }, /forwardPorts must be an array/],
    ['forwardPorts', { image: 'i', forwardPorts: [{}] }, /forwardPorts may only contain numbers and strings/],
    ['portsAttributes', { image: 'i', portsAttributes: { 3000: 'web' } }, /portsAttributes\.3000 must be an object/],
    ['postCreateCommand', { image: 'i', postCreateCommand: 7 }, /postCreateCommand must be a string/]
  ])('refuses a bad %s', async (_field, config, message) => {
    await expect(domoJson(config)).rejects.toThrow(message)
  })

  it.each([
    ['..', { dockerfile: '../evil/Dockerfile' }],
    ['an absolute path', { dockerfile: '/etc/Dockerfile' }],
    ['a context outside the project', { dockerfile: 'Dockerfile', context: '../..' }]
  ])('refuses a build path that escapes the project through %s', async (_label, build) => {
    await expect(domoJson({ build })).rejects.toThrow(/must stay inside the project/)
  })
})

describe('buildFeatures', () => {
  it('injects docker-in-docker when the environment asked for Docker', () => {
    const features = buildFeatures({ ...defaultEnvironmentConfig(), docker: true })

    expect(features).toHaveProperty(DIND_FEATURE)
  })

  it('leaves the Features alone when it did not', () => {
    const features = buildFeatures({ ...defaultEnvironmentConfig(), docker: false })

    expect(Object.keys(features)).toEqual([
      'ghcr.io/devcontainers/features/node:1',
      'ghcr.io/devcontainers/features/github-cli:1'
    ])
  })

  it('does not add a second one when the project pinned its own', () => {
    const own = { 'ghcr.io/devcontainers/features/docker-in-docker:2': { moby: false } }
    const features = buildFeatures({ ...defaultEnvironmentConfig(), docker: true, features: own })

    expect(features).toEqual(own)
  })
})

describe('parseForwardPort', () => {
  it('accepts a plain port number', () => {
    expect(parseForwardPort(3000)).toEqual({ innerPort: 3000, protocol: 'tcp' })
  })

  it('takes the container side of a host:container string', () => {
    expect(parseForwardPort('127.0.0.1:8080:3000')).toEqual({ innerPort: 3000, protocol: 'tcp' })
  })

  it('reads the protocol suffix', () => {
    expect(parseForwardPort('5353/udp')).toEqual({ innerPort: 5353, protocol: 'udp' })
    expect(parseForwardPort('5353/UDP')).toEqual({ innerPort: 5353, protocol: 'udp' })
    expect(parseForwardPort('5353/sctp')).toEqual({ innerPort: 5353, protocol: 'tcp' })
  })

  it('rejects anything that is not a usable port', () => {
    expect(parseForwardPort(0)).toBeNull()
    expect(parseForwardPort(70000)).toBeNull()
    expect(parseForwardPort(3000.5)).toBeNull()
    expect(parseForwardPort('web')).toBeNull()
    expect(parseForwardPort('')).toBeNull()
  })
})

describe('resolveForwardPorts', () => {
  it('drops unusable entries and de-duplicates the rest', () => {
    const ports = resolveForwardPorts({ forwardPorts: [3000, '3000', 'nope', 0, 5432], portsAttributes: {} })

    expect(ports.map(port => port.innerPort)).toEqual([3000, 5432])
  })

  it('matches port attributes by the raw entry or by the port number', () => {
    const ports = resolveForwardPorts({
      forwardPorts: ['127.0.0.1:8080:3000', 5432],
      portsAttributes: {
        '127.0.0.1:8080:3000': { label: 'Web app', protocol: 'https' },
        '5432': { label: 'Postgres' }
      }
    })

    expect(ports).toEqual([
      { innerPort: 3000, protocol: 'tcp', appProtocol: 'https', label: 'Web app' },
      { innerPort: 5432, protocol: 'tcp', appProtocol: 'tcp', label: 'Postgres' }
    ])
  })

  it('falls back to the transport protocol when the attribute is not a protocol', () => {
    const ports = resolveForwardPorts({
      forwardPorts: ['5353/udp'],
      portsAttributes: { 5353: { protocol: 'dns' } }
    })

    expect(ports[0]).toMatchObject({ protocol: 'udp', appProtocol: 'udp' })
  })

  it('is empty when nothing is declared', () => {
    expect(resolveForwardPorts({ forwardPorts: [], portsAttributes: {} })).toEqual([])
  })
})

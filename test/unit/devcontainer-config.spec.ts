import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_IMAGE,
  DOMO_CONFIG_FILE,
  parseForwardPort,
  resolveDevcontainerConfig,
  resolveForwardPorts
} from '../../server/lib/devcontainer/config'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'domo-devcontainer-'))
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

describe('resolveDevcontainerConfig', () => {
  it('prefers .devcontainer/devcontainer.json', async () => {
    const path = await write('.devcontainer/devcontainer.json', '{ "image": "node:22" }')
    await write('.devcontainer.json', '{ "image": "node:18" }')
    await write(DOMO_CONFIG_FILE, '{ "devEnvironment": { "image": "node:16" } }')

    const resolved = await resolveDevcontainerConfig(workspace, 'api')

    expect(resolved).toMatchObject({
      source: 'devcontainer',
      path,
      displayPath: '.devcontainer/devcontainer.json',
      config: { image: 'node:22' }
    })
  })

  it('falls back to a root .devcontainer.json', async () => {
    await write('.devcontainer.json', '{ "image": "node:18" }')

    await expect(resolveDevcontainerConfig(workspace, 'api')).resolves.toMatchObject({
      source: 'devcontainer',
      displayPath: '.devcontainer.json'
    })
  })

  it('reads JSONC: comments and trailing commas are normal in devcontainer.json', async () => {
    await write('.devcontainer/devcontainer.json', `{
      // the image the team uses
      "image": "node:22",
      /* block comments too */
      "forwardPorts": [3000,],
    }`)

    const resolved = await resolveDevcontainerConfig(workspace, 'api')

    expect(resolved.config).toMatchObject({ image: 'node:22', forwardPorts: [3000] })
  })

  it('names the offending file when the JSON is broken', async () => {
    await write('.devcontainer/devcontainer.json', '{ "image": }')

    await expect(resolveDevcontainerConfig(workspace, 'api')).rejects.toThrow(/Invalid JSONC in .*devcontainer\.json/)
  })

  it('rejects a file that is not a JSON object', async () => {
    await write('.devcontainer/devcontainer.json', '["node:22"]')

    await expect(resolveDevcontainerConfig(workspace, 'api')).rejects.toThrow(/must contain a JSON object/)
  })

  it('builds a config from .domo.json for repos that only pick an image', async () => {
    await write(DOMO_CONFIG_FILE, JSON.stringify({
      devEnvironment: {
        image: '  ghcr.io/acme/dev:latest  ',
        remoteUser: 'vscode',
        forwardPorts: [3000],
        portsAttributes: { 3000: { label: 'Web app', protocol: 'http' } }
      }
    }))

    const resolved = await resolveDevcontainerConfig(workspace, 'acme api')

    expect(resolved).toMatchObject({
      source: 'domo',
      displayPath: DOMO_CONFIG_FILE,
      config: {
        name: 'acme api',
        image: 'ghcr.io/acme/dev:latest',
        remoteUser: 'vscode',
        forwardPorts: [3000]
      }
    })
  })

  it('refuses a .domo.json devEnvironment without an image', async () => {
    await write(DOMO_CONFIG_FILE, '{ "devEnvironment": { "remoteUser": "vscode" } }')

    await expect(resolveDevcontainerConfig(workspace, 'api')).rejects.toThrow(/must define devEnvironment\.image/)
  })

  it('ignores a .domo.json that is about something else entirely', async () => {
    await write(DOMO_CONFIG_FILE, '{ "somethingElse": true }')

    await expect(resolveDevcontainerConfig(workspace, 'api')).resolves.toMatchObject({ source: 'default' })
  })

  it('falls back to the built-in Ubuntu definition', async () => {
    const resolved = await resolveDevcontainerConfig(workspace, 'api')

    expect(resolved).toEqual({
      source: 'default',
      path: null,
      displayPath: null,
      config: {
        name: 'api',
        image: DEFAULT_IMAGE,
        remoteUser: 'vscode',
        forwardPorts: [],
        portsAttributes: {}
      }
    })
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
    const ports = resolveForwardPorts({ forwardPorts: [3000, '3000', 'nope', 0, 5432] })

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
    expect(resolveForwardPorts({})).toEqual([])
  })
})

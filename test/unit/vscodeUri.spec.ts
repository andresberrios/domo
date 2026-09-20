import { describe, expect, it } from 'vitest'

import { vscodeAttachUri } from '../../app/utils/vscodeUri'

const PREFIX = 'vscode://vscode-remote/attached-container+'

function parse(uri: string): { target: any, path: string } {
  expect(uri.startsWith(PREFIX)).toBe(true)
  const rest = uri.slice(PREFIX.length)
  const hex = rest.slice(0, rest.indexOf('/'))
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)))
  return { target: JSON.parse(new TextDecoder().decode(bytes)), path: rest.slice(hex.length) }
}

describe('vscodeAttachUri', () => {
  it('encodes the container name and the folder to open', () => {
    const { target, path } = parse(vscodeAttachUri({ containerName: 'domo-env', workspacePath: '/workspaces/repo' }))

    expect(target).toEqual({ containerName: '/domo-env' })
    expect(path).toBe('/workspaces/repo')
  })

  it('matches the hex the documented example produces', () => {
    const uri = vscodeAttachUri({ containerName: 'test', workspacePath: '/home/user/myproject' })

    expect(uri).toBe(`${PREFIX}7b22636f6e7461696e65724e616d65223a222f74657374227d/home/user/myproject`)
  })

  it('gives the container name exactly one leading slash however it arrives', () => {
    for (const name of ['env', '/env', '///env']) {
      expect(parse(vscodeAttachUri({ containerName: name, workspacePath: '/w' })).target.containerName).toBe('/env')
    }
  })

  it('encodes each path segment without eating the slashes', () => {
    const { path } = parse(vscodeAttachUri({ containerName: 'env', workspacePath: '/work spaces/día ☕/repo' }))

    expect(path).toBe('/work%20spaces/d%C3%ADa%20%E2%98%95/repo')
    expect(decodeURIComponent(path)).toBe('/work spaces/día ☕/repo')
  })

  it('hex-encodes the UTF-8 bytes of a non-ASCII container name', () => {
    const { target } = parse(vscodeAttachUri({ containerName: 'café', workspacePath: '/w' }))

    expect(target.containerName).toBe('/café')
  })

  it('refuses a relative workspace path', () => {
    expect(() => vscodeAttachUri({ containerName: 'env', workspacePath: 'workspaces/repo' })).toThrow(/absolute/)
  })

  it('refuses an empty container name', () => {
    expect(() => vscodeAttachUri({ containerName: ' / ', workspacePath: '/w' })).toThrow(/container name/)
  })

  it.each([
    ['you@server', 'ssh://you@server'],
    ['server', 'ssh://server'],
    ['ssh://you@server', 'ssh://you@server'],
    ['  you@server  ', 'ssh://you@server']
  ])('normalises the ssh host %s', (input, expected) => {
    const { target } = parse(vscodeAttachUri({ containerName: 'env', workspacePath: '/w', sshHost: input }))

    expect(target).toEqual({ containerName: '/env', settings: { host: expected } })
  })

  it.each([undefined, '', '   '])('leaves out the settings key for a local docker (%s)', (sshHost) => {
    const { target } = parse(vscodeAttachUri({ containerName: 'env', workspacePath: '/w', sshHost }))

    expect(target).toEqual({ containerName: '/env' })
    expect('settings' in target).toBe(false)
  })
})

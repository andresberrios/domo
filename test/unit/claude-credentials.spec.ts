import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  homeCredentialsPath,
  syncedCredentialsPath,
  writeSyncedCredentials
} from '../../server/lib/claude-credentials'

/**
 * Nothing here reads the Keychain. `security find-generic-password` prompts the
 * user the first time a given binary asks, and a default `pnpm test` that opens
 * a GUI dialog and waits is not a test suite. The live agent layer is what
 * exercises the read; what is covered here is everything the container depends
 * on — where the file goes, who may read it, and that a rewrite keeps the inode
 * the bind mount is pinned to.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'domo-cred-'))
  process.env.NUXT_DATA_DIR = dir
})

afterEach(async () => {
  delete process.env.NUXT_DATA_DIR
  delete process.env.NUXT_CLAUDE_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('syncedCredentialsPath', () => {
  it('is a fixed path under the data dir, because it is a bind-mount source', () => {
    expect(syncedCredentialsPath()).toBe(join(dir, 'claude', '.credentials.json'))
  })
})

describe('homeCredentialsPath', () => {
  it('points at the configured Claude directory when there is one', () => {
    process.env.NUXT_CLAUDE_CONFIG_DIR = '/elsewhere/.claude'

    expect(homeCredentialsPath()).toBe('/elsewhere/.claude/.credentials.json')
  })

  it('falls back to ~/.claude', () => {
    expect(homeCredentialsPath({ HOME: '/home/me' })).toBe('/home/me/.claude/.credentials.json')
  })

  it('is null with no home to look in', () => {
    expect(homeCredentialsPath({})).toBeNull()
  })
})

describe('writeSyncedCredentials', () => {
  it('writes a file only the owner can read, in a directory only the owner can enter', async () => {
    const path = await writeSyncedCredentials('{"claudeAiOauth":{"accessToken":"x"}}')

    expect(path).toBe(syncedCredentialsPath())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'claude'))).mode & 0o777).toBe(0o700)
    expect(await readFile(path, 'utf8')).toBe('{"claudeAiOauth":{"accessToken":"x"}}')
  })

  it('rewrites in place, keeping the inode the bind mount is pinned to', async () => {
    // A rename would change the inode, and the container would go on reading the
    // old, unlinked file for as long as it runs — a token that never refreshes.
    const first = await stat(await writeSyncedCredentials('{"claudeAiOauth":{"accessToken":"one"}}'))
    const path = await writeSyncedCredentials('{"claudeAiOauth":{"accessToken":"two"}}')

    expect((await stat(path)).ino).toBe(first.ino)
    expect(await readFile(path, 'utf8')).toContain('two')
  })

  it('truncates, so a shorter payload leaves no tail of the longer one', async () => {
    await writeSyncedCredentials(`{"claudeAiOauth":{"accessToken":"${'x'.repeat(200)}"}}`)
    const path = await writeSyncedCredentials('{"claudeAiOauth":{}}')

    expect(await readFile(path, 'utf8')).toBe('{"claudeAiOauth":{}}')
  })
})

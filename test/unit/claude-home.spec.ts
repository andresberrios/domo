import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CLAUDE_HOME_ALLOWLIST,
  claudeConfigSource,
  presentEntries
} from '../../server/lib/dev-env/claude-home'
import { homeCredentialsPath } from '../../server/lib/claude-credentials'

/**
 * The allow-list is the security boundary, so it is asserted as a property —
 * "these and nothing else" — rather than by listing the same five strings twice.
 * Nothing here reads a Keychain: `security find-generic-password` opens a GUI
 * prompt the first time a binary asks, and a default `pnpm test` that blocks on
 * a dialog is not a test suite.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'domo-claude-home-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('CLAUDE_HOME_ALLOWLIST', () => {
  it('carries the config a user expects to follow them', () => {
    expect(CLAUDE_HOME_ALLOWLIST).toEqual(['CLAUDE.md', 'settings.json', 'skills', 'commands', 'agents'])
  })

  it('carries nothing that is a credential or a transcript', () => {
    // `.credentials.json` is a refresh chain that must not be forked; the rest
    // are records of everything the developer has ever asked Claude Code.
    for (const forbidden of [
      '.credentials.json', 'projects', 'todos', 'history', 'history.jsonl',
      'plugins', 'statsig', 'sessions', '.claude.json'
    ]) {
      expect(CLAUDE_HOME_ALLOWLIST).not.toContain(forbidden)
    }
  })
})

describe('presentEntries', () => {
  it('returns only the allow-listed entries that exist, and never anything else', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# global\n')
    await writeFile(join(dir, 'settings.json'), '{}')
    await mkdir(join(dir, 'skills'))
    // Everything below is deliberately present and must not come back.
    await writeFile(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}')
    await writeFile(join(dir, 'history.jsonl'), 'secrets\n')
    await mkdir(join(dir, 'projects'))
    await mkdir(join(dir, 'todos'))

    expect(await presentEntries(dir)).toEqual(['CLAUDE.md', 'settings.json', 'skills'])
  })

  it('is empty for a directory with none of them', async () => {
    await writeFile(join(dir, '.credentials.json'), '{}')

    expect(await presentEntries(dir)).toEqual([])
  })
})

describe('claudeConfigSource', () => {
  it('prefers the configured directory', async () => {
    expect(await claudeConfigSource({ NUXT_CLAUDE_CONFIG_DIR: dir, HOME: '/home/me' })).toBe(dir)
  })

  it('falls back to ~/.claude', async () => {
    await mkdir(join(dir, '.claude'))

    expect(await claudeConfigSource({ HOME: dir })).toBe(join(dir, '.claude'))
  })

  it('is null when there is nothing there', async () => {
    expect(await claudeConfigSource({ HOME: join(dir, 'nope') })).toBeNull()
    expect(await claudeConfigSource({})).toBeNull()
  })
})

describe('homeCredentialsPath', () => {
  it('points at the file Claude Code itself reads, for the host precedence check', () => {
    expect(homeCredentialsPath({ HOME: '/home/me' })).toBe('/home/me/.claude/.credentials.json')
    expect(homeCredentialsPath({ NUXT_CLAUDE_CONFIG_DIR: '/elsewhere' })).toBe('/elsewhere/.credentials.json')
    expect(homeCredentialsPath({})).toBeNull()
  })
})

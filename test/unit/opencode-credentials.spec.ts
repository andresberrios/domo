import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  opencodeApiKey,
  opencodeDatabasePath,
  openCodeCredentialState,
  parseCredential,
  readOpenCodeLogin,
  resolveOpenCodeApiKey
} from '../../server/lib/opencode-credentials'

/**
 * The store OpenCode 2 writes, reproduced from its own `create table` text.
 * The columns matter: this is the one file Domo reads and never writes.
 */
function writeStore(path: string, rows: Array<Record<string, unknown>>): void {
  const database = new DatabaseSync(path)
  database.exec(`create table credential (
    id text primary key,
    integration_id text,
    label text not null,
    value text not null,
    connector_id text,
    method_id text,
    active integer,
    time_created integer not null,
    time_updated integer not null
  )`)
  const insert = database.prepare(
    'insert into credential (id, integration_id, label, value, active, time_created, time_updated)'
    + ' values (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const row of rows) {
    insert.run(
      row.id as string, row.integration_id as string, 'Default',
      row.value as string, row.active as number, 1, row.time_updated as number
    )
  }
  database.close()
}

/** What `opencode auth login` leaves behind for an OpenCode Go subscription. */
const goLogin = JSON.stringify({
  type: 'oauth',
  methodID: 'device',
  refresh: 'refresh-secret',
  access: 'access-secret',
  expires: 1792699505386,
  metadata: {
    server: 'https://opencode.ai/console',
    accountID: 'acc_1',
    email: 'dev@example.com',
    orgID: 'org_1',
    orgName: 'Default'
  }
})

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'domo-opencode-store-'))
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('the OpenCode 2 login store', () => {
  it('is the sqlite database beside the data directory, not the v1 auth.json', () => {
    expect(opencodeDatabasePath({ HOME: '/home/dev' }))
      .toBe('/home/dev/.local/share/opencode/opencode.db')
    expect(opencodeDatabasePath({ HOME: '/home/dev', XDG_DATA_HOME: '/data' }))
      .toBe('/data/opencode/opencode.db')
    expect(opencodeDatabasePath({ OPENCODE_DB: '/elsewhere/store.db', HOME: '/home/dev' }))
      .toBe('/elsewhere/store.db')
    expect(opencodeDatabasePath({})).toBeNull()
  })

  it('reads the active console login and leaves the refresh token behind', async () => {
    writeStore(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
      { id: 'cred_openai', integration_id: 'openai', value: '{"type":"oauth","access":"other"}', active: 1, time_updated: 2 },
      { id: 'cred_go', integration_id: 'opencode', value: goLogin, active: 1, time_updated: 3 }
    ])

    const credential = await readOpenCodeLogin({ HOME: home })

    expect(credential).toEqual({
      token: 'access-secret',
      type: 'oauth',
      expires: 1792699505386,
      server: 'https://opencode.ai/console',
      orgId: 'org_1',
      email: 'dev@example.com'
    })
    // Nothing that could be used to rotate the developer's own login comes back.
    expect(JSON.stringify(credential)).not.toContain('refresh-secret')
  })

  it('ignores a logged-out row and a store that is not there', async () => {
    writeStore(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
      { id: 'cred_go', integration_id: 'opencode', value: goLogin, active: 0, time_updated: 3 }
    ])

    await expect(readOpenCodeLogin({ HOME: home })).resolves.toBeNull()
    await expect(readOpenCodeLogin({ HOME: join(home, 'nowhere') })).resolves.toBeNull()
  })

  it('reads the console key from the environment first, then from Settings', async () => {
    const stored = async () => 'key-from-settings'

    expect(opencodeApiKey({ NUXT_OPENCODE_API_KEY: 'key-1', OPENCODE_API_KEY: 'key-2' })).toBe('key-1')
    await expect(resolveOpenCodeApiKey({ NUXT_OPENCODE_API_KEY: 'key-1' }, stored)).resolves.toBe('key-1')
    await expect(resolveOpenCodeApiKey({ OPENCODE_API_KEY: 'key-2' }, stored)).resolves.toBe('key-2')
    await expect(resolveOpenCodeApiKey({}, stored)).resolves.toBe('key-from-settings')
    await expect(resolveOpenCodeApiKey({}, async () => null)).resolves.toBeNull()
  })

  it('keeps the key and the host login as separate answers', async () => {
    // One says nothing about the other: the key is what a container session and
    // the usage poll use, the login is what a host session runs on.
    writeStore(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
      { id: 'cred_go', integration_id: 'opencode', value: goLogin, active: 1, time_updated: 3 }
    ])

    await expect(openCodeCredentialState({ HOME: home }, async () => null))
      .resolves.toEqual({ key: false, hostLogin: true })
    await expect(openCodeCredentialState({ HOME: home, OPENCODE_API_KEY: 'k' }, async () => null))
      .resolves.toEqual({ key: true, hostLogin: true })
    await expect(openCodeCredentialState({ HOME: join(home, 'nowhere') }, async () => 'k'))
      .resolves.toEqual({ key: true, hostLogin: false })
  })

  it('takes the Go integration\'s key when the console account is not connected', async () => {
    writeStore(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
      { id: 'cred_go_key', integration_id: 'opencode-go', value: '{"type":"api","key":"oc_sk_go"}', active: 1, time_updated: 9 }
    ])

    await expect(readOpenCodeLogin({ HOME: home })).resolves.toMatchObject({ token: 'oc_sk_go', type: 'api' })
  })

  it('prefers the console account, which is what the console API authenticates', async () => {
    writeStore(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
      { id: 'cred_go_key', integration_id: 'opencode-go', value: '{"type":"api","key":"oc_sk_go"}', active: 1, time_updated: 9 },
      { id: 'cred_console', integration_id: 'opencode', value: goLogin, active: 1, time_updated: 1 }
    ])

    await expect(readOpenCodeLogin({ HOME: home })).resolves.toMatchObject({ token: 'access-secret' })
  })

  it('takes a service-account key row as well as a device login', () => {
    expect(parseCredential('{"type":"api","key":"oc_live_1"}'))
      .toMatchObject({ token: 'oc_live_1', type: 'api' })
    expect(parseCredential('not json')).toBeNull()
    expect(parseCredential('{"type":"oauth"}')).toBeNull()
  })
})

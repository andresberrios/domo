import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../server/lib/db', () => ({ query }))

const {
  DEFAULTS,
  DEFAULT_SYSTEM_INSTRUCTION,
  getSettings,
  patchSettings
} = await import('../../server/lib/settings')

function stored(rows: Record<string, unknown>) {
  query.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value: { v: value } })))
}

describe('getSettings', () => {
  beforeEach(() => {
    query.mockReset()
    stored({})
  })

  it('returns the defaults for a fresh install', async () => {
    await expect(getSettings()).resolves.toEqual(DEFAULTS)
  })

  it('lets stored values win over the defaults', async () => {
    stored({ voiceName: 'Charon', autoApprovePermissions: true })

    const settings = await getSettings()

    expect(settings.voiceName).toBe('Charon')
    expect(settings.autoApprovePermissions).toBe(true)
    expect(settings.liveModel).toBe(DEFAULTS.liveModel)
  })

  it('defaults the VS Code SSH host to empty, meaning docker is local', async () => {
    expect(DEFAULTS.vscodeSshHost).toBe('')
    await expect(getSettings()).resolves.toMatchObject({ vscodeSshHost: '' })
  })

  it('defaults the home mounts to the login state a developer has', async () => {
    // `.docker` is deliberately not among them: Docker Desktop's config names a
    // credential helper that exists on the host only, and every `docker pull`
    // inside an environment would fail on it.
    expect(DEFAULTS.homeMounts).toEqual(['.ssh', '.gitconfig', '.config/gh', '.config/gcloud', '.aws', '.kube'])
    expect(DEFAULTS.homeMounts).not.toContain('.docker')
    await expect(getSettings()).resolves.toMatchObject({ homeMounts: DEFAULTS.homeMounts })
  })

  it('keeps a stored home mount list, including an empty one', async () => {
    stored({ homeMounts: [] })

    await expect(getSettings()).resolves.toMatchObject({ homeMounts: [] })
  })

  it('keeps a stored VS Code SSH host', async () => {
    stored({ vscodeSshHost: 'you@server' })

    await expect(getSettings()).resolves.toMatchObject({ vscodeSshHost: 'you@server' })
  })

  /**
   * The permission mode is per adapter because the two adapters share no mode
   * id at all. One string could only ever have been right for one of them, and
   * it was: `defaultAgentMode` was a Claude Code id, silently ignored by Codex.
   */
  it('defaults each adapter to its own starting mode', async () => {
    expect(DEFAULTS.defaultAgentModes).toEqual({ 'claude-code': 'default', codex: 'agent' })
    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'default', codex: 'agent' }
    })
  })

  it('keeps a stored per-adapter choice', async () => {
    stored({ defaultAgentModes: { 'claude-code': 'plan', codex: 'read-only' } })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'read-only' }
    })
  })

  it('reads the old single-mode key as the Claude Code choice', async () => {
    // What every install that predates the split has stored.
    stored({ defaultAgentMode: 'acceptEdits' })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'acceptEdits', codex: 'agent' }
    })
  })

  it('lets the new key win over the old one once it has been saved', async () => {
    stored({
      defaultAgentMode: 'acceptEdits',
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent-full-access' }
    })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent-full-access' }
    })
  })

  it('keeps an adapter the stored object does not mention on its own default', async () => {
    stored({ defaultAgentModes: { 'claude-code': 'plan' } })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent' }
    })
  })

  it('reads values that were stored unwrapped', async () => {
    // Older rows hold the bare value instead of `{ v: … }`.
    query.mockResolvedValue([{ key: 'voiceName', value: 'Kore' }])

    await expect(getSettings()).resolves.toMatchObject({ voiceName: 'Kore' })
  })

  it('keeps a system instruction the user actually wrote', async () => {
    stored({ systemInstruction: 'Be terse. Speak Spanish.' })

    await expect(getSettings()).resolves.toMatchObject({ systemInstruction: 'Be terse. Speak Spanish.' })
  })

  it('keeps the current default when it is what is stored', async () => {
    stored({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })

    await expect(getSettings()).resolves.toMatchObject({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })
  })
})

/**
 * The settings page saves the whole form on every submit, so a naive patch
 * would write `systemInstruction` back on every save — including ones where
 * the user never touched it — and freeze the row at whatever the default
 * happened to be that day. A value equal to the current default must never be
 * written, or a fresh install could never follow a change to
 * `DEFAULT_SYSTEM_INSTRUCTION` again.
 */
describe('patchSettings systemInstruction', () => {
  beforeEach(() => {
    query.mockReset()
    query.mockResolvedValue([])
  })

  function writes(key: string) {
    return query.mock.calls.filter(([, params]) => params?.[0] === key)
  }

  it('never persists a system instruction equal to the current default', async () => {
    await patchSettings({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION, voiceName: 'Kore' })

    expect(writes('systemInstruction').some(([sql]) => /insert into settings/.test(sql))).toBe(false)
    expect(writes('voiceName').some(([sql]) => /insert into settings/.test(sql))).toBe(true)
  })

  it('deletes a stored customisation edited back to match the current default', async () => {
    await patchSettings({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })

    expect(writes('systemInstruction').some(([sql]) => /delete from settings/.test(sql))).toBe(true)
  })

  it('persists a system instruction that differs from the default', async () => {
    await patchSettings({ systemInstruction: 'Be terse. Speak Spanish.' })

    expect(writes('systemInstruction').some(([sql]) => /insert into settings/.test(sql))).toBe(true)
  })
})

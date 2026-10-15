import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../server/lib/db', () => ({ query }))

const { DEFAULTS, getSettings } = await import('../../server/lib/settings')

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
    stored({ vscodeSshHost: 'mac', browserTools: false })

    const settings = await getSettings()

    expect(settings.vscodeSshHost).toBe('mac')
    expect(settings.browserTools).toBe(false)
    expect(settings.homeMounts).toEqual(DEFAULTS.homeMounts)
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
    expect(DEFAULTS.defaultAgentModes).toEqual({ 'claude-code': 'default', codex: 'agent', opencode: 'build', copilot: 'https://agentclientprotocol.com/protocol/session-modes#agent' })
    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'default', codex: 'agent', opencode: 'build', copilot: 'https://agentclientprotocol.com/protocol/session-modes#agent' }
    })
  })

  it('keeps a stored per-adapter choice', async () => {
    stored({ defaultAgentModes: { 'claude-code': 'plan', codex: 'read-only' } })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'read-only', opencode: 'build', copilot: 'https://agentclientprotocol.com/protocol/session-modes#agent' }
    })
  })

  it('reads the old single-mode key as the Claude Code choice', async () => {
    // What every install that predates the split has stored.
    stored({ defaultAgentMode: 'acceptEdits' })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'acceptEdits', codex: 'agent', opencode: 'build', copilot: 'https://agentclientprotocol.com/protocol/session-modes#agent' }
    })
  })

  it('lets the new key win over the old one once it has been saved', async () => {
    stored({
      defaultAgentMode: 'acceptEdits',
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent-full-access', opencode: 'build' }
    })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent-full-access' }
    })
  })

  it('keeps an adapter the stored object does not mention on its own default', async () => {
    stored({ defaultAgentModes: { 'claude-code': 'plan' } })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModes: { 'claude-code': 'plan', codex: 'agent', opencode: 'build', copilot: 'https://agentclientprotocol.com/protocol/session-modes#agent' }
    })
  })

  /**
   * The default model is per adapter for the same reason the mode is: the ids
   * are the adapter's own, and there is none Domo could name that is right for
   * every account — so the empty default means "whatever the adapter starts
   * on", and the environment pin still answers underneath it.
   */
  it('leaves every adapter\'s default model empty until one is chosen', async () => {
    expect(DEFAULTS.defaultAgentModels).toEqual({ 'claude-code': '', codex: '', opencode: '', copilot: '' })
    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModels: { 'claude-code': '', codex: '', opencode: '', copilot: '' }
    })
  })

  it('keeps a stored default model, and only for the adapter it was stored against', async () => {
    stored({ defaultAgentModels: { 'claude-code': 'haiku', codex: 7 } })

    await expect(getSettings()).resolves.toMatchObject({
      defaultAgentModels: { 'claude-code': 'haiku', codex: '', opencode: '', copilot: '' }
    })
  })

  it('reads values that were stored unwrapped', async () => {
    // Older rows hold the bare value instead of `{ v: … }`.
    query.mockResolvedValue([{ key: 'vscodeSshHost', value: 'mac' }])

    await expect(getSettings()).resolves.toMatchObject({ vscodeSshHost: 'mac' })
  })
})

describe('agentVoice', () => {
  beforeEach(() => {
    query.mockReset()
    stored({})
  })

  it('keeps the defaults for a fresh install and for a stored row missing fields', async () => {
    stored({ agentVoice: { speaker: 'local' } })

    const settings = await getSettings()

    expect(settings.agentVoice.speaker).toBe('local')
    expect(settings.agentVoice.transcriber).toBe(DEFAULTS.agentVoice.transcriber)
    expect(settings.agentVoice.localVoice).toBe(DEFAULTS.agentVoice.localVoice)
  })

  it('drops an engine it does not know and a blank model id', async () => {
    stored({ agentVoice: { transcriber: 'elevenlabs', localTranscribeModel: '  ', kyutaiUrl: ' ws://gpu:8080 ' } })

    const settings = await getSettings()

    expect(settings.agentVoice.transcriber).toBe(DEFAULTS.agentVoice.transcriber)
    expect(settings.agentVoice.localTranscribeModel).toBe(DEFAULTS.agentVoice.localTranscribeModel)
    expect(settings.agentVoice.kyutaiUrl).toBe('ws://gpu:8080')
  })

  it('checks the turn detector and keeps the silence within reason', async () => {
    stored({ agentVoice: { turnDetector: 'silence', silenceSeconds: 2 } })
    expect((await getSettings()).agentVoice).toMatchObject({ turnDetector: 'silence', silenceSeconds: 2 })

    stored({ agentVoice: { turnDetector: 'psychic', silenceSeconds: 0 } })
    expect((await getSettings()).agentVoice).toMatchObject({
      turnDetector: DEFAULTS.agentVoice.turnDetector,
      silenceSeconds: DEFAULTS.agentVoice.silenceSeconds
    })
  })

  it('keeps each sound\'s volume within 0..1, and the defaults for the rest', async () => {
    stored({ agentVoice: { volumes: { sent: 0.4, speech: 0, turn: 3, nothing: 'loud' } } })
    const { volumes } = (await getSettings()).agentVoice
    expect(volumes).toMatchObject({ sent: 0.4, speech: 0, turn: DEFAULTS.agentVoice.volumes.turn, nothing: DEFAULTS.agentVoice.volumes.nothing })
    expect(DEFAULTS.agentVoice.volumes.sent).toBe(0.1)
    // Read into a copy: an edit to one read never reaches the defaults.
    volumes.record = 1
    expect(DEFAULTS.agentVoice.volumes.record).toBe(0.1)
  })
})

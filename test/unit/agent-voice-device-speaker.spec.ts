import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'

let stored: any = null
const patchSettings = vi.fn(async () => ({}))
vi.mock('../../server/lib/db', () => ({ query: async () => stored ? [{ value: { v: stored } }] : [] }))
vi.mock('../../server/lib/settings', () => ({
  // The stored "browser" no longer reads as a speaker, so Settings show the default.
  getSettings: async () => ({ agentVoice: { ...DEFAULT_AGENT_VOICE, ...stored, speaker: DEFAULT_AGENT_VOICE.speaker } }),
  patchSettings
}))
vi.mock('../../server/lib/agent-voice/assistant-voice', () => ({ freeSpeaker: () => 'pocket' }))

const { migrateDeviceSpeaker } = await import('../../server/lib/agent-voice/device-speaker')

/** The device's own voices are gone: whoever had them gets a free voice, and is told once. */
describe('migrateDeviceSpeaker', () => {
  beforeEach(() => {
    patchSettings.mockClear()
  })

  it('moves the device\'s speaker to the closest free voice, keeping everything else, with a notice', async () => {
    stored = { ...DEFAULT_AGENT_VOICE, speaker: 'browser', transcriber: 'browser', language: 'es' }
    await migrateDeviceSpeaker()
    expect(patchSettings).toHaveBeenCalledTimes(1)
    const patch = (patchSettings.mock.calls[0] as any)[0]
    expect(patch.agentVoice).toMatchObject({ speaker: 'pocket', transcriber: 'browser', language: 'es' })
    expect(patch.agentVoiceNotice).toMatch(/Pocket TTS reads them now/)
  })

  it('leaves any other speaker, and an install with no voice settings, alone', async () => {
    stored = { ...DEFAULT_AGENT_VOICE, speaker: 'local' }
    await migrateDeviceSpeaker()
    stored = null
    await migrateDeviceSpeaker()
    expect(patchSettings).not.toHaveBeenCalled()
  })
})

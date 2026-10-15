import { SPEAKERS } from '../../../shared/agent-voice'
import { query } from '../db'
import { getSettings, patchSettings } from '../settings'
import { freeSpeaker } from './assistant-voice'

/**
 * "This device" no longer speaks: the device's own voices never play through
 * the page, so the echo canceller cannot hear them. An install that had them
 * gets the closest free voice here, and the voice settings say so once.
 */
export async function migrateDeviceSpeaker(): Promise<void> {
  const rows = await query<{ value: any }>(`select value from settings where key = 'agentVoice'`)
  const stored = rows[0]?.value?.v ?? rows[0]?.value
  if (stored?.speaker !== 'browser') return
  const { agentVoice } = await getSettings()
  const speaker = freeSpeaker(agentVoice) ?? 'local'
  const label = SPEAKERS.find(entry => entry.id === speaker)?.label ?? speaker
  await patchSettings({
    agentVoice: { ...agentVoice, speaker },
    agentVoiceNotice: `The device's own voices can no longer read replies: the echo canceller could not hear them, so the agent heard itself. ${label} reads them now; pick any voice below.`
  })
  console.log(`[agent-voice] the device's own voices are gone; the voice bar speaks with ${speaker}`)
}

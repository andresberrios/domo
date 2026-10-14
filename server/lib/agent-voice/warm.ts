import { getSettings } from '../settings'
import { requestLocalModel } from './local-models'
import { warmPocket } from './pocket-speech'

/**
 * Fetch, ahead of the first spoken turn, what the engines Settings chose will
 * need: the first use otherwise waits minutes for a download. Only what is
 * chosen — the defaults are cloud engines, for which nothing but the 8 MB
 * turn model is fetched. Each failure is a log line, never an error: a
 * machine that is offline at boot gets the download on first use as before.
 * The open models are asked of the worker that will run them (`turn.ts` is
 * the worker's; importing it here would fold the server into its bundle).
 */
export async function warmAgentVoice(log: (line: string) => void = line => console.log(line)): Promise<void> {
  const { agentVoice } = await getSettings()
  const jobs: Array<[string, Promise<unknown>]> = []
  if (agentVoice.turnDetector === 'smart-turn') jobs.push(['the turn model', requestLocalModel({ op: 'turn-model' })])
  if (agentVoice.transcriber === 'local') {
    jobs.push([`the transcriber ${agentVoice.localTranscribeModel}`, requestLocalModel({ op: 'transcriber', model: agentVoice.localTranscribeModel })])
  }
  if (agentVoice.speaker === 'local') jobs.push(['the local speech model', requestLocalModel({ op: 'speaker' })])
  if (agentVoice.speaker === 'pocket') jobs.push(['Pocket TTS', warmPocket(agentVoice.pocketUrl)])
  await Promise.all(jobs.map(([what, job]) => job.then(
    () => log(`[agent-voice] ${what} is ready`),
    error => log(`[agent-voice] could not fetch ${what} ahead of time: ${error instanceof Error ? error.message : String(error)}`)
  )))
}

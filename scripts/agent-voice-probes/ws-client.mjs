// Drive the agent voice socket the way the browser would, from PCM fixtures.
import { readFileSync } from 'node:fs'

const [origin, agentSessionId, ...steps] = process.argv.slice(2)
const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/agent-voice/ws?agentSessionId=${agentSessionId}`)
const t0 = Date.now()
let audioBytes = 0, audioChunks = 0, firstAudioAt = null
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a)
ws.addEventListener('message', (ev) => { const raw = ev.data;
  const m = JSON.parse(raw.toString())
  if (m.type === 'audio') { audioChunks++; audioBytes += m.data.length; if (!firstAudioAt) { firstAudioAt = Date.now(); log('first audio chunk, rate', m.sampleRate) } return }
  log(m.type, JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'type'))).slice(0, 200))
})
const send = (m) => ws.send(JSON.stringify(m))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function stream(file) {
  const pcm = readFileSync(file)
  const frame = 2048 * 2
  for (let i = 0; i < pcm.length; i += frame) { send({ type: 'audio', data: pcm.subarray(i, i + frame).toString('base64') }); await sleep(20) }
}
ws.addEventListener('open', async () => {
  log('open')
  for (const step of steps) {
    const [op, arg] = step.split('=')
    if (op === 'say') { await stream(arg); log('streamed', arg) }
    else if (op === 'end') send({ type: 'segment-end', final: arg === 'final' })
    else if (op === 'wait') await sleep(Number(arg))
    else send({ type: op })
  }
  log('done; audio chunks', audioChunks, 'b64 bytes', audioBytes)
  ws.close()
})
ws.addEventListener('error', e => log('error', e.message ?? 'ws error'))

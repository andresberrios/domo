import { readFileSync } from 'node:fs'
const { endOfTurn } = await import('../../server/lib/agent-voice/turn.ts')
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f); const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1)
  const t = Date.now(); const p = await endOfTurn(pcm); console.log(f, (pcm.length / 16000).toFixed(1) + 's', 'p(complete)=', p?.toFixed(3), Date.now() - t, 'ms')
}

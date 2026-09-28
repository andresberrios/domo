import { readFileSync } from 'node:fs'
const { endOfTurn } = await import('../../server/lib/agent-voice/turn.ts')
const load = f => { const b = readFileSync(f); return new Int16Array(b.buffer, b.byteOffset, b.length >> 1) }
const a = load('/tmp/fx-hf1.pcm'), b = load('/tmp/fx-hf2.pcm')
const gap = new Int16Array(16000 * 0.6)
const both = new Int16Array(a.length + gap.length + b.length); both.set(a); both.set(gap, a.length); both.set(b, a.length + gap.length)
console.log('hf1+gap+hf2', (both.length / 16000).toFixed(1) + 's', 'p=', (await endOfTurn(both)).toFixed(3))
const noOver = both.subarray(0, both.length - 16000 * 1.1)
console.log('same, minus the "Over." tail', (noOver.length / 16000).toFixed(1) + 's', 'p=', (await endOfTurn(noOver)).toFixed(3))

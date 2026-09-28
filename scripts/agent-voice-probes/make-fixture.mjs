// Make a 16 kHz PCM16 "microphone" fixture by having Gemini TTS say the text.
import { writeFileSync } from 'node:fs'
const [key, out, text] = process.argv.slice(2)
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${key}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } })
})
const json = await res.json()
const inline = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData
if (!inline) throw new Error(JSON.stringify(json).slice(0, 300))
const bytes = Buffer.from(inline.data, 'base64')
const rate = Number(/rate=(\d+)/.exec(inline.mimeType)?.[1] ?? 24000)
const at = inline.mimeType.includes('wav') ? bytes.indexOf('data', 12, 'ascii') + 8 : 0
const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + at, (bytes.length - at) >> 1)
const ratio = rate / 16000, len = Math.floor(pcm.length / ratio), outPcm = new Int16Array(len)
for (let i = 0; i < len; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; const a = pcm[j] ?? 0, b = pcm[j + 1] ?? a; outPcm[i] = Math.round(a + (b - a) * f) }
writeFileSync(out, Buffer.from(outPcm.buffer))
console.log(out, 'rate', rate, 'seconds', (len / 16000).toFixed(2))

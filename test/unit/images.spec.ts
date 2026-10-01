import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { avatarDataUrl, dataUrlBytes, imageType } from '../../server/lib/images/resize'
import { generateImage } from '../../server/lib/images/generate'

const solid = (format: 'png' | 'jpeg' | 'webp' | 'tiff', width = 1200, height = 800) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })[format]().toBuffer()

describe('images', () => {
  it('knows a picture by its bytes, whatever it is called', async () => {
    expect(imageType(await solid('png'))).toBe('image/png')
    expect(imageType(await solid('jpeg'))).toBe('image/jpeg')
    expect(imageType(await solid('webp'))).toBe('image/webp')
    expect(imageType(await solid('tiff'))).toBe('image/tiff')
    expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageType(Buffer.from('%PDF-1.7'))).toBeNull()
  })

  it('makes any picture a small square WebP', async () => {
    for (const format of ['png', 'jpeg', 'tiff'] as const) {
      const url = await avatarDataUrl(await solid(format))
      expect(url.startsWith('data:image/webp;base64,')).toBe(true)
      const meta = await sharp(dataUrlBytes(url)!).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256])
      expect(url.length).toBeLessThan(20_000)
    }
  })

  it('refuses what is not a picture', async () => {
    await expect(avatarDataUrl(Buffer.from('hello'))).rejects.toThrow('not an image')
  })
})

/** A `codex exec` that does what the real one does: says its thread, writes the image under CODEX_HOME. */
function fakeCodex(home: string, behaviour: { image?: Buffer, message?: string }) {
  const calls: Array<{ args: string[], env: NodeJS.ProcessEnv }> = []
  const spawn = ((_command: string, args: string[], options: any) => {
    calls.push({ args, env: options.env })
    const child = new EventEmitter() as any
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const thread = 'thread_1'
    setTimeout(async () => {
      child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`)
      if (behaviour.image) {
        await mkdir(join(home, 'generated_images', thread), { recursive: true })
        await writeFile(join(home, 'generated_images', thread, 'exec-1.png'), behaviour.image)
      }
      child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: behaviour.message ?? 'DONE' } })}\n`)
      child.stdout.end()
      child.emit('exit', 0)
    }, 5)
    return child
  }) as any
  return { spawn, calls }
}

async function codexHome(authMode: 'chatgpt' | 'apikey' | null) {
  const home = await mkdtemp(join(tmpdir(), 'domo-codex-home-'))
  if (authMode) await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: authMode, tokens: authMode === 'chatgpt' ? { id_token: 'x' } : null }))
  return home
}

describe('generateImage', () => {
  it('runs Codex on the ChatGPT login only, with every API key taken out, and cleans up after itself', async () => {
    const home = await codexHome('chatgpt')
    const png = await solid('png', 64, 64)
    const codex = fakeCodex(home, { image: png })
    process.env.OPENAI_API_KEY = 'sk-should-not-reach-codex'
    process.env.NUXT_CODEX_API_KEY = 'sk-nor-this'
    try {
      const image = await generateImage('an owl', { spawn: codex.spawn, home })
      expect(image.mimeType).toBe('image/png')
      expect(image.bytes.equals(png)).toBe(true)
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.NUXT_CODEX_API_KEY
    }
    const { args, env } = codex.calls[0]!
    expect(args).toContain('exec')
    expect(args.at(-1)).toContain('an owl')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
    expect(env.DEFAULT_AUTH_REQUEST).toBeUndefined()
    expect(env.CODEX_HOME).toBe(home)
    await expect(readdir(join(home, 'generated_images'))).resolves.toEqual([])
  })

  it('refuses without a ChatGPT login rather than falling back to an API key', async () => {
    for (const mode of [null, 'apikey'] as const) {
      const home = await codexHome(mode)
      const codex = fakeCodex(home, { image: await solid('png', 8, 8) })
      await expect(generateImage('an owl', { spawn: codex.spawn, home })).rejects.toThrow('logged in with ChatGPT')
      expect(codex.calls).toHaveLength(0)
    }
  })

  it('says why when Codex made nothing', async () => {
    const home = await codexHome('chatgpt')
    const codex = fakeCodex(home, { message: 'UNAVAILABLE: image_gen is disabled' })
    await expect(generateImage('an owl', { spawn: codex.spawn, home })).rejects.toThrow('UNAVAILABLE: image_gen is disabled')
  })
})

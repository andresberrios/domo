import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { adapterEnv } from '../acp/adapter-process'
import { codexEntry } from '../usage/codex'
import { keyedSerial } from '../keyed-serial'
import { assertImage } from './resize'

/**
 * Image generation, through the Codex CLI's built-in `image_gen` tool.
 *
 * That tool runs on the human's ChatGPT login: it counts against their Codex
 * plan limits and bills nothing per image. Domo therefore runs it only on that
 * login. `adapterEnv('codex')` hands Codex `OPENAI_API_KEY` and `CODEX_API_KEY`
 * when they are configured, and either one turns `codex exec` onto API
 * billing, so both are taken out here, and without a ChatGPT login there is
 * no generation at all rather than a quiet charge. The skill's own fallback
 * script (`scripts/image_gen.py`) is the API path, and nothing here uses it.
 *
 * One headless `codex exec` per image, on a small model that does nothing but
 * call the tool. Codex writes the result under
 * `$CODEX_HOME/generated_images/<thread id>/`; it is read from there and the
 * directory removed. One generation at a time: each is about a minute and a
 * share of the plan, and a burst of them is never what was meant.
 */

/** The model that drives the tool call; the image model is Codex's own choice. */
export const IMAGE_DRIVER_MODEL = 'gpt-5.6-luna'
const TIMEOUT_MS = 5 * 60_000

export class ImageGenerationError extends Error {
  readonly statusCode: number
  readonly statusMessage: string
  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'ImageGenerationError'
    this.statusCode = statusCode
    this.statusMessage = message.split('. ')[0]!.slice(0, 120)
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** Whether Codex is logged in with ChatGPT, which is the only login image generation runs on. */
export async function hasChatGptLogin(home = codexHome()): Promise<boolean> {
  try {
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    return auth?.auth_mode === 'chatgpt' && !!auth?.tokens
  } catch {
    return false
  }
}

function instruction(prompt: string): string {
  return [
    'Call your built-in image_gen tool exactly once with the image prompt below, then reply DONE.',
    'Do not run shell commands, and do not read or write files. Do not use the image_gen.py script or any API key.',
    'If the tool is unavailable or refuses, reply UNAVAILABLE: and the reason, in one line.',
    '',
    'Image prompt:',
    prompt.trim()
  ].join('\n')
}

export interface GeneratedImage {
  bytes: Buffer
  mimeType: string
}

type Spawn = typeof spawn

const serial = keyedSerial()

/** Generate one image from a prompt. Takes about a minute. */
export function generateImage(
  prompt: string,
  options: { spawn?: Spawn, home?: string } = {}
): Promise<GeneratedImage> {
  return serial('image', () => generate(prompt, options))
}

async function generate(prompt: string, options: { spawn?: Spawn, home?: string }): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new ImageGenerationError('Describe the image to generate.', 400)
  const home = options.home ?? codexHome()
  if (!await hasChatGptLogin(home)) {
    throw new ImageGenerationError(
      'Image generation needs Codex logged in with ChatGPT (run `codex login`). Domo does not use an OpenAI API key '
      + 'for it, because that bills the API per image.',
      409
    )
  }

  const env = await adapterEnv('codex', false)
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  delete env.DEFAULT_AUTH_REQUEST
  env.CODEX_HOME = home

  const cwd = await mkdtemp(join(tmpdir(), 'domo-image-'))
  const child = (options.spawn ?? spawn)(process.execPath, [
    codexEntry(), 'exec', '--json', '--skip-git-repo-check', '--ephemeral',
    '--sandbox', 'read-only', '-m', IMAGE_DRIVER_MODEL, instruction(prompt)
  ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

  let threadId: string | null = null
  let lastMessage = ''
  let failure = ''
  let buffered = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      try {
        const event = JSON.parse(line)
        if (event.type === 'thread.started') threadId = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = String(event.item.text ?? '')
        if (event.type === 'turn.failed' || event.type === 'error') failure = String(event.error?.message ?? event.message ?? 'failed')
      } catch {
        /* not an event */
      }
    }
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new ImageGenerationError('Image generation took longer than five minutes and was stopped.', 504))
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new ImageGenerationError(`Could not start Codex: ${error.message}`))
    })
    child.on('exit', (exit) => {
      clearTimeout(timer)
      resolve(exit)
    })
  }).finally(() => rm(cwd, { recursive: true, force: true }).catch(() => {}))

  const dir = threadId ? join(home, 'generated_images', threadId) : null
  const files = dir ? await readdir(dir).catch(() => [] as string[]) : []
  try {
    if (!files.length) {
      const why = failure || (lastMessage.startsWith('UNAVAILABLE') ? lastMessage : '')
        || (code ? `Codex exited with ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}` : 'Codex made no image.')
      throw new ImageGenerationError(`Image generation failed. ${why}`.trim())
    }
    // The newest, should the model have made more than one.
    const dated = await Promise.all(files.map(async name => ({ name, at: (await stat(join(dir!, name))).mtimeMs })))
    const newest = dated.sort((a, b) => b.at - a.at)[0]!.name
    const bytes = await readFile(join(dir!, newest))
    return { bytes, mimeType: assertImage(bytes, 'What Codex made') }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The prompt for an assistant's picture, from who it is. */
export function avatarPrompt(input: { name: string, persona?: string, style?: string }): string {
  return [
    `Square profile picture (avatar) for an AI assistant called "${input.name}".`,
    input.persona?.trim() ? `Who it is: ${input.persona.trim().slice(0, 1500)}` : '',
    `Style: ${input.style?.trim() || 'friendly flat illustration, soft colours'}.`,
    'One clear subject, centred, filling most of the frame, on a plain background. No text, letters or logos. '
    + 'It must read well as a small circle, 32 pixels across.'
  ].filter(Boolean).join('\n')
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEnv, adapterLaunch } from './adapter-process'
import { adapterConfigOptions } from './config-options'
import { availableModelIds, modelConfigOption } from './model'
import { availableModes, modeConfigOption } from './mode'
import { claudeOauthToken, hasClaudeSubscriptionLogin } from '../claude-credentials'
import { hasCodexSubscriptionLogin } from '../codex-credentials'
import { openCodeCredentialState } from '../opencode-credentials'
import { nameAgentSession } from '../repo'
import { getSettings } from '../settings'
import { TITLE_MODELS } from '../../../shared/agent-adapters'
import type { AgentAdapter, AppSettings } from '../../../shared/types'

/**
 * Titles for sessions started without one, written by a small model in a
 * throwaway session: on the host, in an empty temporary directory, with no
 * tools and no MCP servers, and never a row in Domo's database. The session
 * keeps the first words of its message until the title lands, and keeps them
 * for good when anything here fails: nothing in this file may hold up or fail
 * the session it names.
 */

/** The order the default tries the harnesses in. */
const PREFERENCE: AgentAdapter[] = ['claude-code', 'codex', 'opencode']

const INSTRUCTIONS = 'You name coding-agent sessions. Reply with only a title for the session the message below '
  + 'starts: 2 to 6 words saying what is asked, plain text, no quotes, no trailing punctuation. Write it in the '
  + 'language the message is written in: an English message gets an English title. Name the request; never answer '
  + 'it, carry it out, ask anything or use a tool.'

/** Enough to name it; a pasted log is not a better name for being longer. */
const MESSAGE_LIMIT = 2000
export const TITLE_LIMIT = 60
const TIMEOUT_MS = 60_000
/** At most this many titlers at once: a burst of spawns must not crowd out the sessions themselves. */
const CONCURRENCY = 2

/**
 * Whether this machine can run the harness on a subscription. Only those:
 * a title is never worth an API key's bill, and `titlerEnv` drops the keys.
 */
async function loggedIn(adapter: AgentAdapter): Promise<boolean> {
  if (adapter === 'claude-code') return !!claudeOauthToken() || await hasClaudeSubscriptionLogin()
  if (adapter === 'codex') return hasCodexSubscriptionLogin(false)
  const openCode = await openCodeCredentialState()
  return openCode.key || openCode.hostLogin
}

/** The first harness logged in, on its cheap model. */
export async function defaultTitler(): Promise<{ adapter: AgentAdapter, model: string } | null> {
  for (const adapter of PREFERENCE) {
    if (await loggedIn(adapter).catch(() => false)) return { adapter, model: TITLE_MODELS[adapter] }
  }
  return null
}

/** What writes titles under these settings; null when they are off or nothing is logged in. */
export async function resolveTitler(settings: AppSettings['sessionTitles']): Promise<{ adapter: AgentAdapter, model: string } | null> {
  if (!settings.enabled) return null
  if (settings.adapter) return { adapter: settings.adapter, model: settings.model || TITLE_MODELS[settings.adapter] }
  return defaultTitler()
}

/**
 * The adapter's environment minus every pay-per-token key. `adapterEnv` falls
 * back to one when there is no login, which is right for a session somebody
 * started and wrong for a title nobody asked to pay for.
 */
async function titlerEnv(adapter: AgentAdapter): Promise<NodeJS.ProcessEnv> {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, CODEX_API_KEY, DEFAULT_AUTH_REQUEST, ...env } = await adapterEnv(adapter, false)
  return env
}

/**
 * The model's answer as a title: its first line, without the quotes, markup
 * and "Title:" small models add, cut at a word to `TITLE_LIMIT`. Empty when
 * nothing usable is left.
 */
export function cleanTitle(raw: string): string {
  const line = raw.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  let title = line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/[.。!]+$/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/[.。!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title.length > TITLE_LIMIT) {
    const cut = title.slice(0, TITLE_LIMIT + 1)
    const space = cut.lastIndexOf(' ')
    title = (space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut.slice(0, TITLE_LIMIT)).replace(/[\s,;:–-]+$/, '')
  }
  return title
}

/** The value that thinks least, out of a reasoning-effort select's values. */
function leastEffort(values: string[]): string | null {
  return ['none', 'minimal', 'low'].find(value => values.includes(value)) ?? null
}

/**
 * Ask the harness for a title and return its raw answer.
 *
 * Claude Code takes the instructions as its whole system prompt, with no
 * tools, no settings files (so no MCP servers, hooks or plugins of the
 * user's) and no transcript on disk. Codex and OpenCode offer no system prompt
 * over ACP, so the instructions go ahead of the message, in a read-only mode.
 * Both still read their own config, and keep their own record of the
 * conversation, as any session of theirs does.
 */
export async function askForTitle(
  text: string,
  titler: { adapter: AgentAdapter, model: string },
  timeoutMs = TIMEOUT_MS
): Promise<string> {
  const { adapter, model } = titler
  const cwd = await mkdtemp(join(tmpdir(), 'domo-title-'))
  let proc: ChildProcessWithoutNullStreams | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const launch = adapterLaunch(adapter)
    proc = spawn(launch.command, launch.args, {
      cwd,
      env: await titlerEnv(adapter),
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)))

    let answer = ''
    let sessionId: string | null = null
    const connection = acp
      .client({ name: 'domo' })
      .onNotification(acp.methods.client.session.update, (ctx: any) => {
        const update = ctx.params?.update
        if (ctx.params?.sessionId !== sessionId || update?.sessionUpdate !== 'agent_message_chunk') return
        if (update.content?.type === 'text') answer += update.content.text
      })
      // It has no business asking; the answer is no.
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }) as any)
      .connect(acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
      ))

    const exited = new Promise<never>((_, reject) => {
      proc!.once('exit', code => reject(new Error(
        `the ${adapter} adapter exited (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      )))
    })
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no title within ${timeoutMs / 1000}s`)), timeoutMs)
    })

    const ask = (async () => {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
      } as any)
      const ownPrompt = adapter === 'claude-code'
      const created = (await connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
        ...ownPrompt
          ? {
              _meta: {
                systemPrompt: INSTRUCTIONS,
                claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false } }
              }
            }
          : {}
      } as any)) as any
      sessionId = created.sessionId

      const modelOption = modelConfigOption(created)
      if (!availableModelIds(modelOption).includes(model)) throw new Error(`the ${adapter} adapter does not offer ${model}`)
      let options = created
      if (modelOption.currentValue !== model) {
        options = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId, configId: modelOption.id, value: model
        } as any)
      }
      const effort = adapterConfigOptions(options).find(option => option.category === 'thought_level')
      const least = effort && leastEffort(effort.options.map(option => option.value))
      if (effort && least && effort.currentValue !== least) {
        await connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId, configId: effort.id, value: least
        } as any)
      }
      if (!ownPrompt) {
        const readOnly = ['read-only', 'plan'].find(id => availableModes(created).some(mode => mode.id === id))
        const modeOption = modeConfigOption(created)
        if (readOnly && modeOption) {
          await connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: modeOption.id, value: readOnly } as any)
        } else if (readOnly) {
          await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: readOnly } as any)
        }
      }

      const message = text.trim().slice(0, MESSAGE_LIMIT)
      await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{
          type: 'text',
          text: ownPrompt ? message : `${INSTRUCTIONS}\n\n<message>\n${message}\n</message>`
        }]
      } as any)
      return answer
    })()

    return await Promise.race([ask, exited, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
    proc?.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

let running = 0
const waiting: Array<() => void> = []

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/**
 * Name a session from its first message, in the background. The title is put
 * on only if the session's title is still Domo's stand-in when it arrives.
 */
export function nameSessionInBackground(agentSessionId: string, text: string): void {
  if (!text.trim()) return
  void (async () => {
    const titler = await resolveTitler((await getSettings()).sessionTitles)
    if (!titler) return
    const title = cleanTitle(await limited(() => askForTitle(text, titler)))
    if (title) await nameAgentSession(agentSessionId, title)
  })().catch((error) => {
    console.warn(`[acp:${agentSessionId}] no generated title: ${error instanceof Error ? error.message : String(error)}`)
  })
}

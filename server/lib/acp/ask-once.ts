import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterLaunch } from './adapter-process'
import { adapterConfigOptions } from './config-options'
import { availableModelIds, currentModel, modelConfigOption } from './model'
import { availableModes, modeConfigOption } from './mode'
import type { AgentAdapter } from '../../../shared/types'

/**
 * One question to a harness in a throwaway session that nothing records: on
 * the host, in an empty temporary directory, with no tools and no MCP servers,
 * on the least thinking the model offers. What the session titler and the
 * setup guide's live check both are.
 */
export interface AskOnce {
  adapter: AgentAdapter
  /** A model id, or how to pick one from what the adapter offers. */
  model: string | ((offered: string[], current: string | null) => string | null)
  /** What the model is to do, as Claude Code's whole system prompt; the others get it ahead of the message. */
  instructions: string
  message: string
  /** The adapter's environment, which decides what it signs in with. */
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** What a timeout says. */
  timeoutMessage: string
}

/** The value that thinks least, out of a reasoning-effort select's values. */
function leastEffort(values: string[]): string | null {
  return ['none', 'minimal', 'low'].find(value => values.includes(value)) ?? null
}

/**
 * Ask, and return the raw answer and the model that gave it.
 *
 * Claude Code takes the instructions as its whole system prompt, with no
 * tools, no settings files (so no MCP servers, hooks or plugins of the
 * user's) and no transcript on disk. Codex and OpenCode offer no system prompt
 * over ACP, so the instructions go ahead of the message, in a read-only mode.
 * Both still read their own config, and keep their own record of the
 * conversation, as any session of theirs does.
 */
export async function askOnce(ask: AskOnce): Promise<{ answer: string, model: string }> {
  const { adapter } = ask
  const cwd = await mkdtemp(join(tmpdir(), 'domo-ask-'))
  let proc: ChildProcessWithoutNullStreams | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const launch = adapterLaunch(adapter)
    proc = spawn(launch.command, launch.args, {
      cwd,
      env: ask.env,
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
      timer = setTimeout(() => reject(new Error(ask.timeoutMessage)), ask.timeoutMs)
    })

    const asking = (async () => {
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
                systemPrompt: ask.instructions,
                claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false } }
              }
            }
          : {}
      } as any)) as any
      sessionId = created.sessionId

      const modelOption = modelConfigOption(created)
      const offered = availableModelIds(modelOption)
      const model = typeof ask.model === 'string'
        ? ask.model
        : ask.model(offered, currentModel(modelOption)?.value ?? null)
      if (!model || !offered.includes(model)) throw new Error(`the ${adapter} adapter does not offer ${model ?? 'a model to use'}`)
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

      await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{
          type: 'text',
          text: ownPrompt ? ask.message : `${ask.instructions}\n\n<message>\n${ask.message}\n</message>`
        }]
      } as any)
      return { answer, model }
    })()

    return await Promise.race([asking, exited, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
    proc?.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

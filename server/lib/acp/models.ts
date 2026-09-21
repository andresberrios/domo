import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEntry, adapterEnv } from './adapter-process'
import { availableModelOptions, currentModel, modelConfigOption } from './model'
import type { AgentAdapter } from '../../../shared/types'

export interface AdapterModels {
  models: Array<{ id: string, name: string }>
  current: string | null
}

/**
 * Long enough for a cold adapter start, short enough that a request cannot hang.
 * Read per call, not at import: a module-level constant cannot be changed by a
 * test without resetting the registry, which then leaks into the next one.
 */
function probeTimeoutMs(): number {
  return Number(process.env.NUXT_ACP_MODEL_PROBE_MS) || 30_000
}
/** The list only moves when the adapter is upgraded or an account changes plan. */
const CACHE_TTL_MS = 60 * 60 * 1000

const cache = new Map<AgentAdapter, { at: number, value: AdapterModels }>()
const inFlight = new Map<AgentAdapter, Promise<AdapterModels>>()

/**
 * What an adapter offers, asked by starting a throwaway session and reading the
 * `configOptions` it answers with.
 *
 * There is no cheaper way: an adapter only reports its models in a `session/new`
 * response, and the list depends on the account. Always probed on the **host** —
 * the runtime volume installs the identical adapter versions, so the list is the
 * same, and a container is minutes of environment lifecycle for an answer that
 * does not differ.
 *
 * Cached for an hour and de-duplicated, so a modal opening twice is one spawn.
 */
export async function listAdapterModels(adapter: AgentAdapter): Promise<AdapterModels> {
  const hit = cache.get(adapter)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const existing = inFlight.get(adapter)
  if (existing) return existing

  const probing = probe(adapter)
    .then((value) => {
      cache.set(adapter, { at: Date.now(), value })
      return value
    })
    .finally(() => inFlight.delete(adapter))
  inFlight.set(adapter, probing)
  return probing
}

/** Test seam, and what an adapter upgrade would want. */
export function clearAdapterModelCache(): void {
  cache.clear()
}

const ADAPTER_NAMES: Record<AgentAdapter, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

export interface AdapterCatalogEntry {
  id: AgentAdapter
  name: string
  models: Array<{ id: string, name: string }>
  /** What a session gets when it asks for no model in particular. */
  default: string | null
  /** Why this adapter could not be asked, when it could not be. */
  error?: string
}

/**
 * Every harness Domo can run and the models each offers, for an agent that has
 * to turn "the cheap OpenAI one" into an id that exists.
 *
 * One adapter failing — not logged in, not installed — is reported on its own
 * entry rather than failing the call: the other adapter's list is still the
 * answer to most of the question.
 */
export async function listAdapterCatalog(only?: AgentAdapter): Promise<{ adapters: AdapterCatalogEntry[] }> {
  const wanted: AgentAdapter[] = only ? [only] : ['claude-code', 'codex']
  const adapters = await Promise.all(wanted.map(async (id): Promise<AdapterCatalogEntry> => {
    try {
      const { models, current } = await listAdapterModels(id)
      return { id, name: ADAPTER_NAMES[id], models, default: current }
    } catch (error) {
      return {
        id,
        name: ADAPTER_NAMES[id],
        models: [],
        default: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }))
  return { adapters }
}

async function probe(adapter: AgentAdapter): Promise<AdapterModels> {
  const cwd = await mkdtemp(join(tmpdir(), 'domo-models-'))
  let proc: ChildProcessWithoutNullStreams | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const env = await adapterEnv(adapter, false)
    proc = spawn(process.execPath, [adapterEntry(adapter)], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    // The adapter's own diagnostics are the only clue when a probe fails, so
    // they are kept and surfaced rather than dropped.
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => (stderr += chunk))

    const connection = acp
      .client({ name: 'domo' })
      .connect(acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
      ))

    const exited = new Promise<never>((_, reject) => {
      proc!.once('exit', code => reject(new Error(
        `the ${adapter} adapter exited (code ${code}) before answering${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      )))
    })
    const timeout = probeTimeoutMs()
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the ${adapter} adapter did not answer within ${timeout / 1000}s`)),
        timeout
      )
    })

    const ask = (async () => {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
      } as any)
      // No MCP servers: this session exists only to be asked what it could run on.
      return (await connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: []
      } as any)) as any
    })()

    const created = await Promise.race([ask, exited, timedOut])
    const option = modelConfigOption(created)
    return {
      models: availableModelOptions(option),
      current: currentModel(option)?.value ?? null
    }
  } finally {
    if (timer) clearTimeout(timer)
    proc?.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

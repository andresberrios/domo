import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEnv, adapterLaunch } from './adapter-process'
import { adapterConfigOptions } from './config-options'
import { availableModelOptions, currentModel, modelConfigOption } from './model'
import { availableModes, currentModeId } from './mode'
import type { AgentAdapter, SessionConfigOptionInfo, SessionModeInfo } from '../../../shared/types'

/**
 * What one `session/new` probe answered with. Modes ride along with the models
 * because they come from the same response and cost the same spawn — and
 * because they are the same kind of thing: a list only the adapter knows.
 */
export interface AdapterModels {
  models: Array<{ id: string, name: string }>
  current: string | null
  modes: SessionModeInfo[]
  currentMode: string | null
  /**
   * The adapter's own settings, as offered to a session on its *default*
   * model. That caveat is the whole reason this is not simply "the adapter's
   * options": adapters may publish reasoning effort per model, so a model
   * with no effort levels has no effort option at all, and the levels
   * themselves differ. Good enough for the Settings page, which is choosing a
   * default rather than describing a session — a live session reads its own
   * `configOptions` off its row instead.
   */
  configOptions: SessionConfigOptionInfo[]
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
 * What an adapter offers — models and permission modes — asked by starting a
 * throwaway session and reading the `configOptions` and `modes` it answers
 * with.
 *
 * There is no cheaper way: an adapter only reports either list in a
 * `session/new` response, and the models depend on the account. Always probed
 * on the **host** — the runtime volume installs the identical adapter versions,
 * so the lists are the same, and a container is minutes of environment
 * lifecycle for an answer that does not differ.
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
  codex: 'Codex',
  opencode: 'OpenCode'
}

export interface AdapterCatalogEntry {
  id: AgentAdapter
  name: string
  models: Array<{ id: string, name: string }>
  /** What a session gets when it asks for no model in particular. */
  default: string | null
  /** The session modes this adapter offers, with adapter-specific semantics. */
  modes: SessionModeInfo[]
  /** The mode a session starts in when it asks for none. */
  defaultMode: string | null
  /** The adapter's own settings on its default model; see `AdapterModels`. */
  configOptions: SessionConfigOptionInfo[]
  /** Why this adapter could not be asked, when it could not be. */
  error?: string
}

/**
 * Every harness Domo can run, with the models and the session modes each
 * offers — for an agent that has to turn "the cheap OpenAI one" into an id that
 * exists, and for the Settings page, which cannot hard-code either list because
 * their mode ids and semantics are not shared.
 *
 * One adapter failing — not logged in, not installed — is reported on its own
 * entry rather than failing the call: the other adapter's list is still the
 * answer to most of the question.
 */
export async function listAdapterCatalog(only?: AgentAdapter): Promise<{ adapters: AdapterCatalogEntry[] }> {
  const wanted: AgentAdapter[] = only ? [only] : ['claude-code', 'codex', 'opencode']
  const adapters = await Promise.all(wanted.map(async (id): Promise<AdapterCatalogEntry> => {
    try {
      const { models, current, modes, currentMode, configOptions } = await listAdapterModels(id)
      return { id, name: ADAPTER_NAMES[id], models, default: current, modes, defaultMode: currentMode, configOptions }
    } catch (error) {
      return {
        id,
        name: ADAPTER_NAMES[id],
        models: [],
        default: null,
        modes: [],
        defaultMode: null,
        configOptions: [],
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
    const launch = adapterLaunch(adapter)
    proc = spawn(launch.command, launch.args, {
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
      current: currentModel(option)?.value ?? null,
      modes: availableModes(created),
      currentMode: currentModeId(created),
      configOptions: adapterConfigOptions(created)
    }
  } finally {
    if (timer) clearTimeout(timer)
    proc?.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

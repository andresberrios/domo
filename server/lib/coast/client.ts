/**
 * Coast adapter — typed HTTP/SSE/WS client for coastd's `/api/v1/*` surface.
 *
 * coastd ships an HTTP API at `http://localhost:31415/api/v1/` (the same
 * surface Coastguard, Coast's own web UI, consumes). Three transports:
 *
 *   1. REST for snapshots + lifecycle (`/ls`, `/ports`, `/ps`, `/stop`,
 *      `/start`, `/rm`, `/checkout`, `/secrets`, `/files/*`).
 *   2. SSE under `/api/v1/stream/*` for long ops (`build`, `run`, `assign`,
 *      `unassign`, `rm-build`). Each emits `progress` / `complete` / `error`
 *      event frames.
 *   3. WebSocket at `/api/v1/events` broadcasting the typed `CoastEvent`
 *      enum (instance lifecycle, build/service state, port health, docker
 *      connectivity).
 *
 * This module wraps all three. Each REST helper validates the response
 * against the Zod schema in `./types.ts`, surfacing schema drift as a
 * `CoastError` rather than letting it crash deep in the UI. SSE and WS
 * helpers expose async iterators / event emitters so callers can pipe
 * progress into the chat or update the left-rail tree reactively.
 */
import type {
  BuildProgressEvent,
  CoastEvent,
  LookupResponse,
  LsResponse,
  PortsResponse,
  PsResponse,
} from './types'
import {
  CoastEvent as CoastEventSchema,
  LookupResponse as LookupResponseSchema,
  LsResponse as LsResponseSchema,
  PortsResponse as PortsResponseSchema,
  PsResponse as PsResponseSchema,
} from './types'

/** Coastd's standard error body. */
export class CoastError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'CoastError'
  }
}

interface ClientOptions {
  /** Base URL for coastd. Default `http://127.0.0.1:31415`. */
  baseUrl?: string
}

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/api/v1${path}`
}

async function parseJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({ error: 'invalid json' }))
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `coastd HTTP ${res.status}`
    throw new CoastError(msg, res.status, body)
  }
  return body as T
}

export function createCoastClient(opts: ClientOptions = {}) {
  const base = opts.baseUrl ?? 'http://127.0.0.1:31415'

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(url(base, path))
    return parseJson<T>(res)
  }

  async function post<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
    const res = await fetch(url(base, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return parseJson<TRes>(res)
  }

  // --- REST: snapshots ---

  async function ls(project?: string): Promise<LsResponse> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : ''
    const raw = await get<unknown>(`/ls${qs}`)
    return LsResponseSchema.parse(raw)
  }

  async function lookup(opts: { project?: string; workingDir?: string } = {}): Promise<LookupResponse> {
    const qs = new URLSearchParams()
    if (opts.project) qs.set('project', opts.project)
    if (opts.workingDir) qs.set('working_dir', opts.workingDir)
    const raw = await get<unknown>(`/lookup${qs.size ? `?${qs}` : ''}`)
    return LookupResponseSchema.parse(raw)
  }

  async function ports(name: string, project: string): Promise<PortsResponse> {
    const raw = await post<{ action: string; name: string; project: string }, unknown>(
      '/ports',
      { action: 'List', name, project },
    )
    return PortsResponseSchema.parse(raw)
  }

  async function ps(name: string, project: string): Promise<PsResponse> {
    const raw = await post<{ name: string; project: string }, unknown>('/ps', { name, project })
    return PsResponseSchema.parse(raw)
  }

  // --- REST: lifecycle ---

  async function stop(name: string, project: string): Promise<unknown> {
    return post('/stop', { name, project })
  }

  async function start(name: string, project: string): Promise<unknown> {
    return post('/start', { name, project })
  }

  async function rm(name: string, project: string): Promise<unknown> {
    return post('/rm', { name, project })
  }

  /** Pass `name: null` to release (Coast's `--none` flag). */
  async function checkout(project: string, name: string | null): Promise<unknown> {
    return post('/checkout', { name, project })
  }

  // --- SSE: long-running operations ---

  /**
   * Consume coastd's `progress` / `complete` / `error` SSE stream. Resolves
   * once the stream emits `complete` or `error`; `onProgress` fires for
   * every `progress` event. Matches `coast-guard/src/api/sse.ts`.
   */
  async function consumeSse<TProgress = BuildProgressEvent, TComplete = unknown>(
    path: string,
    body: unknown,
    onProgress?: (e: TProgress) => void,
  ): Promise<{ complete?: TComplete; error?: { error: string } }> {
    const res = await fetch(url(base, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => 'unknown error')
      throw new CoastError(text, res.status, text)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent: string | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ') && currentEvent) {
          const payload = line.slice(6)
          if (currentEvent === 'progress' && onProgress) {
            try { onProgress(JSON.parse(payload) as TProgress) } catch { /* swallow */ }
          } else if (currentEvent === 'complete') {
            return { complete: JSON.parse(payload) as TComplete }
          } else if (currentEvent === 'error') {
            return { error: JSON.parse(payload) as { error: string } }
          }
          currentEvent = null
        } else if (line === '') {
          currentEvent = null
        }
      }
    }
    return { error: { error: 'stream ended without a response' } }
  }

  function build(
    coastfilePath: string,
    opts: { refresh?: boolean; onProgress?: (e: BuildProgressEvent) => void } = {},
  ) {
    return consumeSse<BuildProgressEvent>(
      '/stream/build',
      { coastfile_path: coastfilePath, refresh: opts.refresh ?? false },
      opts.onProgress,
    )
  }

  function run(
    project: string,
    name: string,
    opts: {
      worktree?: string
      branch?: string | null
      buildId?: string
      coastfileType?: string | null
      forceRemoveDangling?: boolean
      onProgress?: (e: BuildProgressEvent) => void
    } = {},
  ) {
    return consumeSse<BuildProgressEvent>(
      '/stream/run',
      {
        name,
        project,
        worktree: opts.worktree,
        branch: opts.branch ?? undefined,
        build_id: opts.buildId,
        coastfile_type: opts.coastfileType,
        force_remove_dangling: opts.forceRemoveDangling ?? false,
      },
      opts.onProgress,
    )
  }

  function assign(
    project: string,
    name: string,
    worktree: string,
    opts: { commitSha?: string; onProgress?: (e: BuildProgressEvent) => void } = {},
  ) {
    return consumeSse<BuildProgressEvent>(
      '/stream/assign',
      { name, project, worktree, commit_sha: opts.commitSha },
      opts.onProgress,
    )
  }

  // --- WebSocket: live state ---

  interface EventSubscription {
    readonly url: string
    close(): void
    onEvent(handler: (e: CoastEvent) => void): () => void
    onClose(handler: () => void): () => void
    onError(handler: (err: unknown) => void): () => void
  }

  /**
   * Subscribe to coastd's `/api/v1/events` WebSocket. Returns a subscription
   * with handler-registration methods and a `close()` for tear-down. Each
   * incoming frame is parsed + validated against `CoastEvent`; malformed
   * frames are dropped silently (logged at debug level by callers).
   */
  function subscribeEvents(): EventSubscription {
    const wsUrl = url(base, '/events').replace(/^http/, 'ws')
    // Lazy import so this file stays usable from the client too if needed.
    // Nitro/Node 22 has a global WebSocket.
    const ws = new WebSocket(wsUrl)
    const eventHandlers = new Set<(e: CoastEvent) => void>()
    const closeHandlers = new Set<() => void>()
    const errorHandlers = new Set<(err: unknown) => void>()

    ws.addEventListener('message', (msg) => {
      let raw: unknown
      try { raw = JSON.parse(String((msg as MessageEvent).data)) } catch { return }
      const parsed = CoastEventSchema.safeParse(raw)
      if (!parsed.success) return
      for (const h of eventHandlers) h(parsed.data)
    })
    ws.addEventListener('close', () => { for (const h of closeHandlers) h() })
    ws.addEventListener('error', (e) => { for (const h of errorHandlers) h(e) })

    return {
      url: wsUrl,
      close() { ws.close() },
      onEvent(h) { eventHandlers.add(h); return () => eventHandlers.delete(h) },
      onClose(h) { closeHandlers.add(h); return () => closeHandlers.delete(h) },
      onError(h) { errorHandlers.add(h); return () => errorHandlers.delete(h) },
    }
  }

  // --- Health / version ---

  /**
   * Smoke-probe coastd reachability. Returns true if `/ls` answers (it's
   * the simplest no-arg GET on the API), false otherwise. Use at server
   * startup to surface a "Coast daemon not running" error to the user
   * before the UI tries to render anything that depends on it.
   */
  async function ping(): Promise<boolean> {
    try { await ls(); return true } catch { return false }
  }

  return {
    baseUrl: base,
    // REST snapshots
    ls,
    lookup,
    ports,
    ps,
    // REST lifecycle
    stop,
    start,
    rm,
    checkout,
    // SSE
    build,
    run,
    assign,
    consumeSse,
    // WS
    subscribeEvents,
    // Health
    ping,
  }
}

export type CoastClient = ReturnType<typeof createCoastClient>

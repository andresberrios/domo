/**
 * Shared consumer for coastd's `BuildProgressEvent` SSE stream
 * (`coast-core/src/protocol/build.rs`):
 *   { step, detail?, status, step_number?, total_steps?, plan? }
 *   status ∈ "plan" | "started" | "ok" | "warn" | "fail" | "skip"
 *
 * Both `/api/projects/build` and `/api/envs/run` are pass-throughs for the
 * same coastd channel (`mpsc::channel::<BuildProgressEvent>` →
 * `event: progress` / `event: complete` / `event: error`), so the parsing
 * is identical. A single step emits a `started` AND a terminal
 * (`ok`/`skip`/…) event, plus per-item events carrying only `detail` — so
 * we fold by step name into a checklist instead of printing one line per
 * raw event (the old AddEnvModal bug: a flat `p.message ?? p.step ??
 * JSON.stringify(p)` list).
 */
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'warn' | 'failed'

export interface BuildStep {
  name: string
  state: StepState
  number?: number
  total?: number
  items: string[]
}

const STATE_BY_STATUS: Record<string, StepState> = {
  started: 'running',
  ok: 'done',
  skip: 'skipped',
  warn: 'warn',
  fail: 'failed',
}

export function useBuildProgress() {
  const steps = ref<BuildStep[]>([])

  function reset() {
    steps.value = []
  }

  function stepFor(name: string): BuildStep {
    let s = steps.value.find((x) => x.name === name)
    if (!s) {
      s = { name, state: 'pending', items: [] }
      steps.value.push(s)
    }
    return s
  }

  function applyProgress(p: Record<string, unknown>) {
    const status = String(p.status ?? '')
    if (status === 'plan' && Array.isArray(p.plan)) {
      if (steps.value.length === 0) {
        steps.value = (p.plan as string[]).map((name) => ({ name, state: 'pending', items: [] }))
      }
      return
    }
    const name = typeof p.step === 'string' ? p.step : ''
    if (!name) return
    const s = stepFor(name)
    if (typeof p.step_number === 'number') s.number = p.step_number
    if (typeof p.total_steps === 'number') s.total = p.total_steps
    const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null
    if (detail && s.items[s.items.length - 1] !== detail) s.items.push(detail)
    const next = STATE_BY_STATUS[status]
    // Don't let a per-item "started" downgrade a step already marked done.
    if (next && !(next === 'running' && (s.state === 'done' || s.state === 'skipped'))) {
      s.state = next
    }
  }

  function finalize() {
    for (const s of steps.value) {
      if (s.state === 'running' || s.state === 'pending') s.state = 'done'
    }
  }

  function failRunning() {
    for (const s of steps.value) if (s.state === 'running') s.state = 'failed'
  }

  /**
   * Drain an SSE response body to completion, folding `progress` frames
   * into `steps`. On natural stream end (no `error` seen) any leftover
   * running/pending step is promoted to `done`. Returns when the stream
   * closes (or `signal` aborts the underlying fetch — caller owns that).
   */
  async function consume(
    body: ReadableStream<Uint8Array>,
    handlers: {
      onComplete?: (data: Record<string, unknown> | null) => void
      onError?: (msg: string) => void
    } = {},
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let currentEvent: string | null = null
    let errored = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const partials = buf.split('\n')
      buf = partials.pop() ?? ''
      for (const line of partials) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ') && currentEvent) {
          const payload = line.slice(6)
          if (currentEvent === 'progress') {
            try { applyProgress(JSON.parse(payload)) } catch { /* skip malformed frame */ }
          } else if (currentEvent === 'complete') {
            finalize()
            let data: Record<string, unknown> | null = null
            try { data = JSON.parse(payload) } catch { /* no summary */ }
            handlers.onComplete?.(data)
          } else if (currentEvent === 'error') {
            errored = true
            failRunning()
            let msg = payload
            try { msg = JSON.parse(payload).error ?? payload } catch { /* raw payload */ }
            handlers.onError?.(msg)
          }
          currentEvent = null
        } else if (line === '') {
          currentEvent = null
        }
      }
    }
    if (!errored) finalize()
  }

  return { steps, reset, consume }
}

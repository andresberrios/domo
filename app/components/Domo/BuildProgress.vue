<script setup lang="ts">
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ done: []; cancelled: [] }>()

/**
 * coastd streams `BuildProgressEvent`s (coast-core/src/protocol/build.rs):
 *   { step, detail?, status, step_number?, total_steps?, plan? }
 *   status ∈ "plan" | "started" | "ok" | "warn" | "fail" | "skip"
 * A single step emits a `started` AND a terminal (`ok`/`skip`/…) event,
 * plus per-item events carrying only `detail` — so we fold by step name
 * into a checklist instead of printing one line per raw event.
 */
type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'warn' | 'failed'
interface Step {
  name: string
  state: StepState
  number?: number
  total?: number
  items: string[]
}

const steps = ref<Step[]>([])
const phase = ref<'streaming' | 'complete' | 'error'>('streaming')
const errMsg = ref<string | null>(null)
const imagesCached = ref<number | null>(null)

let abort: AbortController | null = null

function stepFor(name: string): Step {
  let s = steps.value.find((x) => x.name === name)
  if (!s) {
    s = { name, state: 'pending', items: [] }
    steps.value.push(s)
  }
  return s
}

const STATE_BY_STATUS: Record<string, StepState> = {
  started: 'running',
  ok: 'done',
  skip: 'skipped',
  warn: 'warn',
  fail: 'failed',
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

async function run() {
  abort = new AbortController()
  let res: Response
  try {
    res = await fetch('/api/projects/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: props.projectId }),
      signal: abort.signal,
    })
  } catch (e) {
    phase.value = 'error'
    errMsg.value = (e as Error).message
    return
  }
  if (!res.ok || !res.body) {
    phase.value = 'error'
    errMsg.value = `Build request failed (${res.status})`
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let currentEvent: string | null = null
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
          phase.value = 'complete'
          finalize()
          try { imagesCached.value = JSON.parse(payload).images_cached ?? null } catch { /* no summary */ }
        } else if (currentEvent === 'error') {
          phase.value = 'error'
          try { errMsg.value = JSON.parse(payload).error ?? payload } catch { errMsg.value = payload }
          for (const s of steps.value) if (s.state === 'running') s.state = 'failed'
        }
        currentEvent = null
      } else if (line === '') {
        currentEvent = null
      }
    }
  }
}

onMounted(() => { run() })
onBeforeUnmount(() => { abort?.abort() })

function close() {
  if (phase.value === 'streaming') {
    abort?.abort()
    emit('cancelled')
  } else {
    emit('done')
  }
}

const ICON: Record<StepState, { name: string; class: string; spin?: boolean }> = {
  pending: { name: 'i-lucide-circle', class: 'text-muted' },
  running: { name: 'i-lucide-loader-circle', class: 'text-primary', spin: true },
  done: { name: 'i-lucide-circle-check', class: 'text-success' },
  skipped: { name: 'i-lucide-circle-minus', class: 'text-muted' },
  warn: { name: 'i-lucide-circle-alert', class: 'text-warning' },
  failed: { name: 'i-lucide-circle-x', class: 'text-error' },
}
</script>

<template>
  <div class="space-y-3">
    <!-- Terminal banner -->
    <div class="flex items-center gap-2 text-sm font-medium">
      <template v-if="phase === 'streaming'">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
        <span>Building project… <span class="text-muted font-normal">first build can take 20+ seconds</span></span>
      </template>
      <template v-else-if="phase === 'complete'">
        <UIcon name="i-lucide-circle-check" class="size-4 text-success" />
        <span class="text-success">Build complete</span>
        <span v-if="imagesCached != null" class="text-muted font-normal">· {{ imagesCached }} image{{ imagesCached === 1 ? '' : 's' }} cached</span>
      </template>
      <template v-else>
        <UIcon name="i-lucide-circle-x" class="size-4 text-error" />
        <span class="text-error">Build failed</span>
      </template>
    </div>

    <!-- Step checklist -->
    <div class="rounded-md bg-elevated/40 text-sm p-3 max-h-72 overflow-auto border border-default space-y-1">
      <div v-if="steps.length === 0" class="text-muted text-xs">
        Waiting for coastd…
      </div>
      <div v-for="s in steps" :key="s.name">
        <div class="flex items-center gap-2">
          <UIcon
            :name="ICON[s.state].name"
            :class="[ICON[s.state].class, ICON[s.state].spin ? 'animate-spin' : '', 'size-4 shrink-0']"
          />
          <span :class="s.state === 'pending' ? 'text-muted' : ''">{{ s.name }}</span>
          <span
            v-if="s.number && s.total"
            class="text-xs text-muted ml-auto tabular-nums"
          >{{ s.number }}/{{ s.total }}</span>
        </div>
        <div
          v-if="s.items.length"
          class="ml-6 mt-0.5 font-mono text-xs text-muted space-y-0.5"
        >
          <div v-for="(it, i) in s.items" :key="i" class="truncate">
            {{ it }}
          </div>
        </div>
      </div>
    </div>

    <p v-if="errMsg" class="text-sm text-error">
      {{ errMsg }}
    </p>

    <div class="flex items-center justify-between gap-2">
      <p v-if="phase === 'streaming'" class="text-xs text-muted">
        Safe to close — the build keeps running and finishes in the background.
      </p>
      <span v-else />
      <UButton
        size="sm"
        :color="phase === 'error' ? 'neutral' : 'primary'"
        :variant="phase === 'streaming' ? 'ghost' : 'solid'"
        @click="close"
      >
        {{ phase === 'streaming' ? 'Close' : 'Done' }}
      </UButton>
    </div>
  </div>
</template>

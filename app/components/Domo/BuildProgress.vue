<script setup lang="ts">
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ done: []; cancelled: [] }>()

const lines = ref<string[]>([])
const phase = ref<'streaming' | 'complete' | 'error'>('streaming')
const errMsg = ref<string | null>(null)

let abort: AbortController | null = null

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
          try {
            const parsed = JSON.parse(payload)
            const msg = typeof parsed === 'string'
              ? parsed
              : (parsed.message ?? parsed.step ?? JSON.stringify(parsed))
            lines.value.push(msg)
          } catch {
            lines.value.push(payload)
          }
        } else if (currentEvent === 'complete') {
          phase.value = 'complete'
        } else if (currentEvent === 'error') {
          phase.value = 'error'
          try { errMsg.value = JSON.parse(payload).error ?? payload } catch { errMsg.value = payload }
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
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-muted">
      <UIcon
        v-if="phase === 'streaming'"
        name="i-lucide-loader-circle"
        class="size-3.5 animate-spin inline mr-1.5"
      />
      <UIcon v-else-if="phase === 'complete'" name="i-lucide-check" class="size-3.5 inline mr-1.5 text-success" />
      <UIcon v-else name="i-lucide-x" class="size-3.5 inline mr-1.5 text-error" />
      Running <code>coast build</code> — this can take 20+ seconds with cold caches.
    </p>

    <div
      class="rounded-md bg-elevated/40 font-mono text-xs p-2 max-h-72 overflow-auto border border-default"
    >
      <div v-for="(line, i) in lines" :key="i" class="whitespace-pre-wrap">
        {{ line }}
      </div>
      <div v-if="lines.length === 0 && phase === 'streaming'" class="text-muted">
        Waiting for coast build…
      </div>
    </div>

    <p v-if="errMsg" class="text-sm text-error">
      {{ errMsg }}
    </p>

    <div class="flex justify-end">
      <UButton
        size="sm"
        :color="phase === 'error' ? 'neutral' : 'primary'"
        :variant="phase === 'streaming' ? 'ghost' : 'solid'"
        @click="close"
      >
        {{ phase === 'streaming' ? 'Cancel' : 'Close' }}
      </UButton>
    </div>
  </div>
</template>

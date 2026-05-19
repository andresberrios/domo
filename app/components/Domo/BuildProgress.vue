<script setup lang="ts">
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ done: []; cancelled: [] }>()

const { steps, consume } = useBuildProgress()
const phase = ref<'streaming' | 'complete' | 'error'>('streaming')
const errMsg = ref<string | null>(null)
const imagesCached = ref<number | null>(null)

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
  await consume(res.body, {
    onComplete: (data) => {
      phase.value = 'complete'
      const n = data?.images_cached
      imagesCached.value = typeof n === 'number' ? n : null
    },
    onError: (msg) => {
      phase.value = 'error'
      errMsg.value = msg
    },
  })
  // Stream ended cleanly without an explicit `complete` frame.
  if (phase.value === 'streaming') phase.value = 'complete'
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

    <DomoBuildSteps :steps="steps" />

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

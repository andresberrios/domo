<script setup lang="ts">
/**
 * Center-area chat session. The route param is the Domo session id; we
 * resolve its row to confirm it exists (and render not-found / error
 * states) and hand off to `<DomoChat>`, which subscribes to the durable
 * stream keyed by the session id. Live transcript + sending are the
 * component's job.
 */
type Session = Awaited<ReturnType<typeof apiClient.sessions.get.call>>

const route = useRoute()
const sessionId = computed(() => String(route.params.session ?? ''))

const session = ref<Session | null>(null)
const loading = ref(false)
const errMsg = ref<string | null>(null)

async function load() {
  if (!sessionId.value) return
  loading.value = true
  errMsg.value = null
  try {
    session.value = await apiClient.sessions.get.call({ id: sessionId.value })
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
    session.value = null
  } finally {
    loading.value = false
  }
}
watch(sessionId, load, { immediate: true })
</script>

<template>
  <div class="h-full min-h-0">
    <div v-if="loading" class="p-6 text-muted text-sm">
      Loading session…
    </div>
    <div v-else-if="errMsg" class="p-6 text-error text-sm">
      {{ errMsg }}
    </div>
    <div v-else-if="!session" class="p-6 text-muted text-sm">
      Session not found.
    </div>
    <DomoChat
      v-else
      :key="session.id"
      :session-id="session.id"
    />
  </div>
</template>

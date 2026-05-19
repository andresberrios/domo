<script setup lang="ts">
/**
 * Approve / reject one parked agent edit. Sourced from the entity's
 * **durable** `pendingDiffs` collection (via `useSessionStream`), so it is
 * inherently cross-device and survives a client *or* server restart: the
 * row replays from the stream, this card re-renders, and the decision
 * still applies (the procedure resolves the parked promise if the turn is
 * live, else the entity applies it from the durable row on its next wake).
 *
 * The full diff is shown inline (reuses `DomoDiffView`); the link opens
 * the same diff full-screen in the workspace surface.
 */
import type { PendingDiffRow } from '~/utils/sessionStreamTypes'
import { languageFromPath } from '~/utils/language'

const props = defineProps<{
  sessionId: string
  diff: PendingDiffRow
}>()

const route = useRoute()
const submitting = ref(false)
const errMsg = ref<string | null>(null)

const language = computed(() => languageFromPath(props.diff.path))
const fullDiffTo = computed(() => {
  const project = route.params.project
  const env = route.params.env
  if (!project || !env) return null
  const q = new URLSearchParams({
    diff: 'pending',
    sid: props.sessionId,
    callId: props.diff.callId,
  })
  return `/p/${project}/e/${env}/f/${props.diff.path}?${q}`
})

async function decide(decision: 'accept' | 'reject') {
  if (submitting.value) return
  submitting.value = true
  errMsg.value = null
  try {
    await apiClient.sessions.diffDecision.call({
      id: props.sessionId,
      callId: props.diff.callId,
      decision,
    })
    // The card disappears when the durable row flips off `pending`.
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="rounded-lg border border-warning/50 bg-warning/5 overflow-hidden">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-warning/30">
      <UIcon name="i-lucide-file-pen" class="size-4 text-warning shrink-0" />
      <span class="text-sm font-medium truncate">{{ diff.tabName }}</span>
      <span class="text-xs font-mono text-muted truncate">{{ diff.path }}</span>
      <NuxtLink
        v-if="fullDiffTo"
        :to="fullDiffTo"
        class="ml-auto text-xs text-muted hover:text-default shrink-0"
      >
        Open full diff →
      </NuxtLink>
    </div>

    <DomoDiffView
      :original="diff.before"
      :modified="diff.after"
      :language="language"
      inline
      class="max-h-80 border-b border-warning/30"
    />

    <div class="flex items-center gap-2 px-3 py-2">
      <UButton
        color="primary"
        size="xs"
        icon="i-lucide-check"
        :loading="submitting"
        @click="decide('accept')"
      >
        Accept
      </UButton>
      <UButton
        color="neutral"
        variant="subtle"
        size="xs"
        icon="i-lucide-x"
        :disabled="submitting"
        @click="decide('reject')"
      >
        Reject
      </UButton>
      <span class="text-xs text-muted">Agent is waiting for your review</span>
      <span v-if="errMsg" class="ml-auto text-xs text-error">{{ errMsg }}</span>
    </div>
  </div>
</template>

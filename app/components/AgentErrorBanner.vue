<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * The agent's *current* trouble, and what to do about it.
 *
 * Keyed on `status`, never on `lastError`: the field is history — a failed boot
 * or a failed turn writes it, a turn starting clears it — and the transcript
 * already shows the same error at the point in time it happened. A banner that
 * followed the field outlived the thing it described (a session-limit error
 * stayed at the top of the page long after the limit had reset and the
 * conversation had moved on). A session that is in `error` *now* is the only
 * case where the user still has to act, so that is the only case shown.
 */
const props = defineProps<{ session: AgentSession }>()
const emit = defineEmits<{ retried: [] }>()

const toast = useToast()
const retrying = ref(false)

const shown = computed(() => props.session.status === 'error')

/** The same restart the navbar and the session menu use. */
async function retry() {
  retrying.value = true
  try {
    await $fetch(`/api/agents/${props.session.id}/start`, { method: 'POST' })
    emit('retried')
  } catch (error: any) {
    toast.add({
      title: 'Could not start the adapter',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <UAlert
    v-if="shown"
    color="error"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    title="This agent stopped on an error"
    :description="session.lastError ?? 'The adapter reported no details.'"
    class="mb-3"
    :actions="[{
      label: 'Retry',
      icon: 'i-lucide-rotate-ccw',
      color: 'neutral',
      variant: 'subtle',
      loading: retrying,
      onClick: retry
    }]"
  />
</template>

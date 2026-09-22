<script setup lang="ts">
import { REVIVAL_CAVEAT, revivalState } from '~~/shared/retention'
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * What a retired session says about itself, above its own transcript.
 *
 * It is the whole of the read-only story on this page: the composer and the
 * start button are gone, so without this the page would be a transcript that
 * silently could not be added to. It says why the session ended, and either
 * offers the way back or explains why there is not one — the same rule the
 * server enforces (`shared/retention.ts`), so the button is never offered for
 * something `POST /revive` would refuse.
 */
const props = defineProps<{
  session: AgentSession
  /** The environment it ran in, deleted or not; null for a host session. */
  environment: DevEnvironment | null
}>()

const emit = defineEmits<{ revived: [] }>()

const toast = useToast()
const busy = ref(false)
const confirming = ref(false)

const revival = computed(() => revivalState(props.session, props.environment))

const why = computed(() => {
  switch (props.session.retiredReason) {
    case 'environment-deleted':
      return `The development environment${props.environment ? ` "${props.environment.name}"` : ''} it ran in was deleted.`
    case 'project-deleted':
      return 'The project it ran in was deleted, along with its development environments.'
    default:
      return 'It was retired.'
  }
})

const caveat = REVIVAL_CAVEAT

async function revive() {
  confirming.value = false
  busy.value = true
  try {
    await $fetch(`/api/agents/${props.session.id}/revive`, { method: 'POST' })
    toast.add({ title: 'Session revived', description: 'It is stopped; press Start to bring the adapter up.', color: 'neutral' })
    emit('revived')
  } catch (error: any) {
    toast.add({
      title: 'Could not revive the session',
      description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl shrink-0 py-2">
    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-archive"
      title="Retired — read-only"
    >
      <template #description>
        <p>
          {{ why }} {{ relativeTime(session.retiredAt) }}. The transcript below is kept and stays
          readable; nothing can be sent to this session.
        </p>
        <p v-if="!revival.revivable" class="mt-1 text-dimmed">
          It cannot be brought back. {{ revival.reason }}
        </p>
      </template>

      <template v-if="revival.revivable" #actions>
        <UButton
          label="Revive"
          icon="i-lucide-rotate-ccw"
          size="xs"
          color="neutral"
          variant="solid"
          :loading="busy"
          @click="confirming = true"
        />
      </template>
    </UAlert>

    <ConfirmModal
      v-model:open="confirming"
      :title="`Revive ${session.title}?`"
      :description="`It comes back stopped, and starting it is a separate step. ${caveat}`"
      confirm-label="Revive session"
      confirm-color="primary"
      :loading="busy"
      @confirm="revive"
    />
  </div>
</template>

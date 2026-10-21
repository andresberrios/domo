<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'

/** What the human has changed and not sent, with the one button that sends it all. */
const props = defineProps<{ state: BoardState, busy?: boolean }>()
const count = computed(() => props.state.pendingCount.value)
</script>

<template>
  <Transition name="swap">
    <div v-if="count" class="flex items-center gap-2 border-t border-default bg-elevated/60 px-3 py-2">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">
          {{ count }} {{ count === 1 ? 'change' : 'changes' }} not sent
        </p>
        <p v-if="busy" class="truncate text-xs text-muted">
          The agent gets them when its turn ends.
        </p>
      </div>
      <UButton label="Discard" color="neutral" variant="ghost" size="sm" :disabled="state.submitting.value" @click="state.discard()" />
      <UButton label="Submit" icon="i-lucide-send" size="sm" :loading="state.submitting.value" @click="state.submit()" />
    </div>
  </Transition>
</template>

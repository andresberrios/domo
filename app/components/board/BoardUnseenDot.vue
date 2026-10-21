<script setup lang="ts">
/** A dot on a sidebar row while the agent has changed its status board since you last looked. */
const props = defineProps<{ ownerId: string | null | undefined }>()
const unseen = useUnseenBoards()
const show = computed(() => !!props.ownerId && unseen.value.has(props.ownerId))
</script>

<template>
  <UTooltip v-if="show" text="Its status board changed">
    <span class="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Its status board changed" role="img" />
  </UTooltip>
</template>

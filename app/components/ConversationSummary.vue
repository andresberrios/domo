<script setup lang="ts">
/**
 * What Domo still remembers of the part of the conversation it no longer
 * replays word for word.
 *
 * The transcript above it is complete — nothing is ever deleted — but what the
 * model is handed on a reconnect is this summary plus the recent tail, so it is
 * worth being able to read it. If Domo has forgotten something, this is where
 * it will show.
 */
defineProps<{
  summary: string
  folded: number
  updatedAt?: string | null
}>()
</script>

<template>
  <UCollapsible class="w-full">
    <UButton
      color="neutral"
      variant="subtle"
      size="sm"
      block
      icon="i-lucide-archive"
      trailing-icon="i-lucide-chevron-down"
      :label="folded
        ? `Earlier context summarised (${folded} message${folded === 1 ? '' : 's'})`
        : 'Earlier context summarised'"
      :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
    />

    <template #content>
      <div class="mt-2 rounded-md border border-default px-3 py-2">
        <p class="text-xs text-dimmed">
          What Domo carries into a reconnect, instead of the messages above
          <template v-if="updatedAt">
            · updated {{ relativeTime(updatedAt) }}
          </template>
        </p>
        <p class="mt-1 text-sm whitespace-pre-wrap text-muted">{{ summary }}</p>
      </div>
    </template>
  </UCollapsible>
</template>

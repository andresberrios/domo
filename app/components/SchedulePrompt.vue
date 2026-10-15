<script setup lang="ts">
import { useClipboard } from '@vueuse/core'

/** A scheduled task's whole prompt, rendered as the transcript renders it, with a copy button. */
const props = defineProps<{ text: string }>()

const { copy, copied } = useClipboard({ copiedDuring: 1500 })
</script>

<template>
  <div class="relative rounded-md border border-default bg-elevated/50 py-2 ps-3 pe-9 text-sm">
    <div class="max-h-72 overflow-y-auto">
      <MarkdownView :text="props.text" />
    </div>
    <UTooltip :text="copied ? 'Copied' : 'Copy prompt'">
      <UButton
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        color="neutral"
        variant="ghost"
        size="xs"
        class="absolute end-1 top-1"
        :aria-label="copied ? 'Copied' : 'Copy prompt'"
        @click="copy(props.text)"
      />
    </UTooltip>
  </div>
</template>

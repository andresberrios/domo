<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import type { BoardElementContent } from '~~/shared/types/board'

/** Where the results are. A web address opens; a file, branch or commit is copied. */
defineProps<{ content: Extract<BoardElementContent, { kind: 'links' }> }>()

const ICON: Record<string, string> = {
  url: 'i-lucide-external-link',
  file: 'i-lucide-file',
  branch: 'i-lucide-git-branch',
  pr: 'i-lucide-git-pull-request',
  commit: 'i-lucide-git-commit-horizontal',
  other: 'i-lucide-link'
}
const { copy, copied, text: copiedText } = useClipboard({ copiedDuring: 1500 })
const opens = (target: string) => /^https?:\/\//.test(target)
</script>

<template>
  <ul class="mt-2 flex flex-col gap-1">
    <li v-for="item in content.items" :key="item.id" class="min-w-0">
      <UButton
        v-if="opens(item.target)"
        :to="item.target"
        target="_blank"
        :icon="ICON[item.kind]"
        :label="item.label"
        color="neutral"
        variant="link"
        size="sm"
        class="max-w-full px-0"
        :ui="{ label: 'truncate' }"
      />
      <UTooltip v-else :text="copied && copiedText === item.target ? 'Copied' : `Copy ${item.target}`">
        <UButton
          :icon="ICON[item.kind]"
          color="neutral"
          variant="link"
          size="sm"
          class="max-w-full px-0"
          @click="copy(item.target)"
        >
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.label !== item.target" class="truncate font-mono text-xs text-dimmed">{{ item.target }}</span>
        </UButton>
      </UTooltip>
    </li>
  </ul>
</template>

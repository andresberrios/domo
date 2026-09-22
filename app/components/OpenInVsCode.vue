<script setup lang="ts">
import type { DevEnvironment } from '~~/shared/types'

const props = defineProps<{ environment: DevEnvironment }>()

const { href, tooltip } = useVsCodeHref(() => props.environment)
</script>

<template>
  <UTooltip :text="tooltip">
    <UButton
      :to="href"
      :disabled="!href"
      label="Open in VS Code"
      icon="i-lucide-code-xml"
      size="xs"
      color="neutral"
      variant="soft"
    />
  </UTooltip>
</template>

<script setup lang="ts">
import type { DevEnvironment } from '~~/shared/types'

const props = defineProps<{ environment: DevEnvironment }>()

// Keyed so every environment on the page shares one request.
const { data: settings } = await useFetch('/api/settings', { key: 'settings', lazy: true })

const ready = computed(() => props.environment.status === 'running' && !!props.environment.containerName?.trim())

const href = computed(() => {
  if (!ready.value) return undefined
  try {
    return vscodeAttachUri({
      containerName: props.environment.containerName,
      workspacePath: props.environment.workspacePath,
      sshHost: settings.value?.vscodeSshHost
    })
  } catch {
    // A workspace path that is not absolute is a broken environment, not a crash.
    return undefined
  }
})

const tooltip = computed(() => ready.value
  ? 'Attaches VS Code to the container. Needs the "Dev Containers" extension.'
  : 'Start the environment first — VS Code attaches to a running container.')
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

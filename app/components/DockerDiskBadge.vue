<script setup lang="ts">
/**
 * The sidebar's one line about the disk under Docker: shown only when it is
 * running low, before builds and installs in environments start failing.
 */
defineProps<{ collapsed: boolean }>()
const { disk, headline } = useDockerDisk()
</script>

<template>
  <UButton
    v-if="headline"
    to="/settings/environments#docker-disk"
    icon="i-lucide-hard-drive"
    :label="collapsed ? undefined : headline"
    :aria-label="headline"
    :color="disk?.level === 'critical' ? 'error' : 'warning'"
    variant="ghost"
    size="sm"
    :block="!collapsed"
    class="justify-start"
  />
</template>

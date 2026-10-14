<script setup lang="ts">
/**
 * The sidebar's one line about updates: how far behind the channel this
 * install is, or what the updater is doing. Nothing when up to date, and
 * nothing on a development server.
 */
defineProps<{ collapsed: boolean }>()
const { update, headline } = useAppUpdate()
const color = computed(() => {
  switch (update.value?.state) {
    case 'failed': return 'error' as const
    case 'ready': case 'building': case 'restarting': return 'primary' as const
    default: return 'neutral' as const
  }
})
const icon = computed(() => {
  switch (update.value?.state) {
    case 'failed': return 'i-lucide-triangle-alert'
    case 'building': case 'restarting': return 'i-lucide-loader-circle'
    case 'ready': return 'i-lucide-rotate-cw'
    default: return 'i-lucide-arrow-down-to-line'
  }
})
</script>

<template>
  <UButton
    v-if="headline"
    to="/settings/updates"
    :icon="icon"
    :label="collapsed ? undefined : headline"
    :aria-label="headline"
    :color="color"
    variant="ghost"
    size="sm"
    :block="!collapsed"
    class="justify-start"
    :ui="{ leadingIcon: update?.state === 'building' || update?.state === 'restarting' ? 'animate-spin' : '' }"
  />
</template>

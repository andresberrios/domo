<script setup lang="ts">
defineEmits<{ 'toggle-right': [] }>()

const route = useRoute()
const projectName = computed(() => (route.params.project as string) || null)
const envName = computed(() => (route.params.env as string) || null)
const title = computed(() =>
  projectName.value
    ? `${projectName.value}${envName.value ? ` / ${envName.value}` : ''}`
    : 'Domo',
)
const terminalTo = computed(() =>
  projectName.value && envName.value
    ? `/p/${projectName.value}/e/${envName.value}/terminal`
    : null,
)
</script>

<template>
  <UDashboardNavbar :title="title">
    <template #leading>
      <UDashboardSidebarCollapse />
    </template>
    <template #right>
      <UColorModeButton size="xs" />
      <UTooltip v-if="terminalTo" text="Terminal">
        <UButton
          :to="terminalTo"
          size="xs"
          variant="ghost"
          icon="i-lucide-terminal"
          aria-label="Open terminal"
          active-variant="soft"
        />
      </UTooltip>
      <UTooltip text="Toggle workspace panel" :kbds="['meta', 'B']">
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-panel-right"
          aria-label="Toggle workspace panel"
          @click="$emit('toggle-right')"
        />
      </UTooltip>
    </template>
  </UDashboardNavbar>
</template>

<script setup lang="ts">
defineEmits<{ 'toggle-right': []; 'toggle-bottom': [] }>()

const route = useRoute()
const projectName = computed(() => (route.params.project as string) || null)
const envName = computed(() => (route.params.env as string) || null)
const title = computed(() =>
  projectName.value
    ? `${projectName.value}${envName.value ? ` / ${envName.value}` : ''}`
    : 'Domo',
)
</script>

<template>
  <UDashboardNavbar :title="title">
    <template #right>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-terminal"
        title="Toggle terminal"
        @click="$emit('toggle-bottom')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-panel-right"
        title="Toggle right panel"
        @click="$emit('toggle-right')"
      />
    </template>
  </UDashboardNavbar>
</template>

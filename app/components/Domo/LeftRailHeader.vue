<script setup lang="ts">
const showAddProject = useState('leftRail:showAddProject', () => false)
</script>

<template>
  <UDashboardSidebarCollapse />
  <div class="flex-1 flex items-center justify-between gap-2 pl-2">
    <span class="text-sm font-semibold">Domo</span>
    <UButton
      size="xs"
      color="primary"
      icon="i-lucide-plus"
      @click="showAddProject = true"
    >
      Project
    </UButton>
  </div>
</template>

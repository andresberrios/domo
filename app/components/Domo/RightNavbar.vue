<script setup lang="ts">
defineEmits<{ close: [] }>()
</script>

<template>
  <UDashboardNavbar :toggle="false" title="Workspace">
    <template #right>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-x"
        @click="$emit('close')"
      />
    </template>
  </UDashboardNavbar>
</template>

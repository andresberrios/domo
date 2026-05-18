<script setup lang="ts">
const showAddProject = useState('leftRail:showAddProject', () => false)
</script>

<template>
  <div class="flex-1 flex items-center justify-between gap-2">
    <span class="flex items-center gap-2 min-w-0">
      <img
        src="/image/logo.png"
        alt="Domo"
        class="size-6 rounded-full object-cover shrink-0"
      >
      <span class="text-sm font-semibold truncate">Domo</span>
    </span>
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

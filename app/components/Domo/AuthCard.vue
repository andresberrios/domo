<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6 bg-muted">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-2">
          <img
            src="/image/logo.png"
            alt="Domo"
            class="size-7 rounded-full object-cover"
          >
          <span class="font-semibold">Domo</span>
        </div>
      </template>

      <div class="space-y-1 mb-4">
        <h1 class="text-lg font-semibold">
          {{ title }}
        </h1>
        <p v-if="subtitle" class="text-sm text-muted">
          {{ subtitle }}
        </p>
      </div>

      <slot />

      <template v-if="$slots.footer" #footer>
        <slot name="footer" />
      </template>
    </UCard>
  </div>
</template>

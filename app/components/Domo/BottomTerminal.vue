<script setup lang="ts">
defineEmits<{ close: [] }>()

const { envId, projectName, envName } = useSelectedEnv()
</script>

<template>
  <div class="flex flex-col h-64 min-h-0 border-t border-default">
    <div class="flex items-center justify-between border-b border-default px-2 py-1">
      <span class="text-xs text-muted">
        <template v-if="envId">
          Terminal — {{ projectName }} / {{ envName }} (coast exec)
        </template>
        <template v-else>
          Terminal — select an environment
        </template>
      </span>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-chevrons-down"
        @click="$emit('close')"
      />
    </div>
    <div class="flex-1 min-h-0">
      <DomoTerminal v-if="envId" :key="envId" :env-id="envId" />
      <div v-else class="p-3 text-xs text-muted">
        No environment selected. Open an env from the left rail to get a
        shell inside its Coast instance.
      </div>
    </div>
  </div>
</template>

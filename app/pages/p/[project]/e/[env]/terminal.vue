<script setup lang="ts">
/**
 * Center-area terminal. A peer of the chat (`s/[session]`) and file
 * (`f/[...path]`) routes — the terminal is a primary working surface, not
 * a "bottom panel" (the dashboard group is a horizontal flex row, so a
 * stacked bottom panel never fit the primitive; it's a center view).
 * It's the one workspace surface that crosses into the Coast container
 * (coastd `exec`), so it needs a live env.
 */
const { envId, projectName, envName } = useSelectedEnv()
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center gap-2 border-b border-default px-4 py-2 shrink-0">
      <UIcon name="i-lucide-terminal" class="size-4 text-muted shrink-0" />
      <span class="text-sm font-mono truncate">
        <template v-if="envId">{{ projectName }} / {{ envName }}</template>
        <template v-else>Terminal</template>
      </span>
      <span class="text-xs text-muted">(coast exec)</span>
    </div>

    <div class="flex-1 min-h-0">
      <DomoTerminal v-if="envId" :key="envId" :env-id="envId" />
      <div v-else class="p-6 text-sm text-muted">
        No environment selected. Open an env from the left rail to get a
        shell inside its Coast instance.
      </div>
    </div>
  </div>
</template>

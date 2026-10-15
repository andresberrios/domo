<script setup lang="ts">
/**
 * A command to type in a terminal, with a button that copies it. On a phone
 * the terminal is on another computer, so the copy is for whoever reads this
 * there; the command stays selectable either way.
 */
const props = defineProps<{ command: string }>()

const copied = ref(false)
let reset: ReturnType<typeof setTimeout> | null = null
async function copy() {
  try {
    await navigator.clipboard.writeText(props.command)
    copied.value = true
    if (reset) clearTimeout(reset)
    reset = setTimeout(() => (copied.value = false), 2000)
  } catch {
    useToast().add({ title: 'Could not copy', description: 'Select the command and copy it yourself.', color: 'warning' })
  }
}
onBeforeUnmount(() => reset && clearTimeout(reset))
</script>

<template>
  <div class="flex items-center gap-1 rounded-md border border-default bg-elevated/50 py-1 ps-3 pe-1">
    <code class="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-sm">{{ command }}</code>
    <UButton
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      :color="copied ? 'success' : 'neutral'"
      variant="ghost"
      size="sm"
      :aria-label="copied ? 'Copied' : `Copy ${command}`"
      @click="copy"
    />
  </div>
</template>

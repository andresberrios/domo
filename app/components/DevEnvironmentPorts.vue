<script setup lang="ts">
import type { DevEnvironment, DevEnvironmentPort } from '~~/shared/types'

const props = defineProps<{ environment: DevEnvironment }>()
const toast = useToast()
const ports = ref<DevEnvironmentPort[]>([])
const loading = ref(false)
const busy = reactive<Record<number, boolean>>({})
const visiblePorts = computed(() => ports.value.filter(port =>
  port.source === 'declared' || port.listening || port.forwarded
))
let timer: ReturnType<typeof setInterval> | null = null

async function refresh() {
  if (props.environment.status !== 'running' || loading.value) return
  loading.value = true
  try {
    ports.value = await $fetch(`/api/dev-environments/${props.environment.id}/ports`)
  } catch {
    // A poll can race with stop/delete; the environment controls surface real errors.
  } finally {
    loading.value = false
  }
}

async function forward(port: DevEnvironmentPort) {
  busy[port.innerPort] = true
  try {
    await $fetch(`/api/dev-environments/${props.environment.id}/ports/${port.innerPort}/forward`, {
      method: 'POST'
    })
    await refresh()
  } catch (error: any) {
    toast.add({
      title: `Could not forward port ${port.innerPort}`,
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    busy[port.innerPort] = false
  }
}

async function unforward(port: DevEnvironmentPort) {
  busy[port.innerPort] = true
  try {
    await $fetch(`/api/dev-environments/${props.environment.id}/ports/${port.innerPort}/forward`, {
      method: 'DELETE'
    })
    await refresh()
  } finally {
    busy[port.innerPort] = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(refresh, 5000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

watch(() => props.environment.status, status => status === 'running' && void refresh())
</script>

<template>
  <div v-if="environment.status === 'running'" class="mt-2 border-t border-default/70 pt-2">
    <div class="mb-1 flex items-center gap-2 text-xs text-muted">
      <UIcon name="i-lucide-radio-tower" class="size-3.5" />
      <span>Ports</span>
      <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-3 animate-spin" />
    </div>
    <div v-if="visiblePorts.length" class="flex flex-wrap gap-2">
      <div
        v-for="port in visiblePorts"
        :key="`${port.innerPort}-${port.protocol}`"
        class="flex items-center gap-1.5 rounded-md border border-default bg-default px-2 py-1 text-xs"
      >
        <span class="font-medium">{{ port.label || port.innerPort }}</span>
        <span v-if="port.label" class="font-mono text-dimmed">:{{ port.innerPort }}</span>
        <UBadge size="sm" color="neutral" variant="subtle" :label="port.source" />
        <UButton
          v-if="port.url"
          :to="port.url"
          target="_blank"
          label="Open"
          icon="i-lucide-external-link"
          size="xs"
          color="primary"
          variant="soft"
        />
        <UButton
          v-else
          label="Forward"
          icon="i-lucide-forward"
          size="xs"
          color="neutral"
          variant="soft"
          :loading="busy[port.innerPort]"
          :disabled="!port.listening || port.protocol !== 'tcp'"
          @click="forward(port)"
        />
        <UButton
          v-if="port.source === 'detected' && port.forwarded"
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="busy[port.innerPort]"
          @click="unforward(port)"
        />
      </div>
    </div>
    <p v-else class="text-xs text-dimmed">Listening ports will appear here automatically.</p>
  </div>
</template>

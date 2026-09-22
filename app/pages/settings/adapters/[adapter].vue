<script setup lang="ts">
import type { AppSettings, SessionConfigOptionInfo, SessionModeInfo } from '~~/shared/types'
import { agentAdapterInfo, isAgentAdapter } from '~~/shared/agent-adapters'

const route = useRoute()
const toast = useToast()
const adapterId = computed(() => String(route.params.adapter))
if (!isAgentAdapter(adapterId.value)) {
  throw createError({ statusCode: 404, statusMessage: 'Unknown ACP adapter' })
}
const adapter = computed(() => agentAdapterInfo(adapterId.value as any))

const { data: settings, refresh: refreshSettings } = await useFetch<AppSettings>('/api/settings')
const { data: probe, status: probeStatus, error: probeError, refresh: refreshProbe } = await useFetch<{
  models: Array<{ id: string, name: string }>
  current: string | null
  modes: SessionModeInfo[]
  currentMode: string | null
  configOptions: SessionConfigOptionInfo[]
}>('/api/adapters/models', {
  query: computed(() => ({ adapter: adapterId.value })),
  watch: [adapterId]
})

const mode = ref('')
const typedModes = ref<string[]>([])
const config = ref<Record<string, string>>({})

watch([settings, adapterId], () => {
  if (!settings.value || !isAgentAdapter(adapterId.value)) return
  mode.value = settings.value.defaultAgentModes[adapterId.value] ?? adapter.value.defaultMode
  config.value = { ...(settings.value.defaultAgentConfig?.[adapterId.value] ?? {}) }
  typedModes.value = []
}, { immediate: true })

const modeItems = computed(() => {
  const items = (probe.value?.modes ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  for (const id of [mode.value, ...typedModes.value]) {
    if (id && !items.some(item => item.value === id)) items.push({ label: id, value: id })
  }
  return items
})

const ADAPTER_DEFAULT = 'adapter-default'
function configItems(option: SessionConfigOptionInfo) {
  return [
    { label: 'Adapter default', value: ADAPTER_DEFAULT },
    ...option.options.map(entry => ({ label: entry.name, value: entry.value }))
  ]
}
function configValue(option: SessionConfigOptionInfo) {
  return config.value[option.id] || ADAPTER_DEFAULT
}
function setConfigValue(option: SessionConfigOptionInfo, value: string) {
  config.value = value === ADAPTER_DEFAULT
    ? Object.fromEntries(Object.entries(config.value).filter(([id]) => id !== option.id))
    : { ...config.value, [option.id]: value }
}

const saving = ref(false)
async function save() {
  if (!settings.value || !isAgentAdapter(adapterId.value)) return
  saving.value = true
  try {
    await $fetch('/api/settings', {
      method: 'PATCH',
      body: {
        defaultAgentModes: { ...settings.value.defaultAgentModes, [adapterId.value]: mode.value },
        defaultAgentConfig: { ...settings.value.defaultAgentConfig, [adapterId.value]: config.value }
      }
    })
    await refreshSettings()
    toast.add({ title: `${adapter.value.label} settings saved`, color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

function addMode(id: string) {
  typedModes.value.push(id)
  mode.value = id
}
</script>

<template>
  <SettingsShell
    :title="adapter.label"
    description="Defaults and capabilities reported by this ACP adapter."
    :saving="saving"
    :save="save"
  >
    <UAlert
      v-if="probeError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="`Could not start ${adapter.label}`"
      :description="probeError.statusMessage ?? probeError.message"
      :actions="[{ label: 'Retry', color: 'neutral', variant: 'subtle', onClick: () => refreshProbe() }]"
    />
    <UAlert
      v-else
      color="neutral"
      variant="subtle"
      :icon="adapter.icon"
      :title="`${probe?.models.length ?? 0} models available`"
      :description="probe?.current ? `Adapter default: ${probe.current}` : 'The adapter chooses its default model.'"
    />

    <UFormField :label="`Default ${adapter.modeLabel.toLowerCase()}`" :help="adapter.modeDescription">
      <USelectMenu
        v-model="mode"
        :items="modeItems"
        value-key="value"
        :loading="probeStatus === 'pending'"
        create-item
        class="w-full"
        @create="addMode"
      />
    </UFormField>

    <template v-if="probe?.configOptions.length">
      <USeparator />
      <section class="space-y-4">
        <div>
          <h2 class="text-sm font-semibold">Adapter options</h2>
          <p class="text-xs text-muted">These come directly from {{ adapter.label }} and apply to new sessions. Options may change with the selected model.</p>
        </div>
        <UFormField
          v-for="option in probe.configOptions"
          :key="option.id"
          :label="option.name"
          :description="option.description ?? undefined"
        >
          <USelectMenu
            :model-value="configValue(option)"
            :items="configItems(option)"
            value-key="value"
            class="w-full"
            @update:model-value="value => setConfigValue(option, value as string)"
          />
        </UFormField>
      </section>
    </template>
  </SettingsShell>
</template>

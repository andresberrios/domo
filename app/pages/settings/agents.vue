<script setup lang="ts">
import type { AgentAdapter, SessionTitleSettings } from '~~/shared/types'
import { AGENT_ADAPTERS, TITLE_MODELS } from '~~/shared/agent-adapters'

const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()
const form = reactive({
  defaultCwd: '',
  sessionTitles: { enabled: true, adapter: 'claude-code', model: TITLE_MODELS['claude-code'] } as SessionTitleSettings
})
watchEffect(() => {
  if (!settings.value) return
  form.defaultCwd = settings.value.defaultCwd
  // Nothing chosen yet shows what would be used: the cheapest harness this
  // machine is logged in to, on its cheap model.
  const titles = settings.value.sessionTitles
  const fallback = settings.value.sessionTitlesDefault
  const adapter: AgentAdapter = titles.adapter || fallback?.adapter || 'claude-code'
  form.sessionTitles = {
    enabled: titles.enabled,
    adapter,
    model: titles.model || (titles.adapter ? TITLE_MODELS[adapter] : fallback?.model ?? TITLE_MODELS[adapter])
  }
})

const adapterItems = AGENT_ADAPTERS.map(entry => ({ label: entry.label, value: entry.id }))
const titleAdapter = computed({
  get: () => form.sessionTitles.adapter,
  set: (adapter) => {
    form.sessionTitles.adapter = adapter
    if (adapter) form.sessionTitles.model = TITLE_MODELS[adapter]
  }
})
const { data: probe, status: probeStatus } = await useFetch<{ models: Array<{ id: string, name: string }> }>('/api/adapters/models', {
  query: computed(() => ({ adapter: form.sessionTitles.adapter || 'claude-code' })),
  lazy: true,
  server: false
})
const modelItems = computed(() => {
  const items = (probe.value?.models ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  if (form.sessionTitles.model && !items.some(item => item.value === form.sessionTitles.model)) {
    items.push({ label: form.sessionTitles.model, value: form.sessionTitles.model })
  }
  return items
})

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: form })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsShell
    title="Coding agents"
    description="Defaults for every coding agent. Each one's own models, modes and options are on its page."
    :saving="saving"
    :save="save"
  >
    <UFormField label="Default folder" hint="Where agents on this machine start">
      <DirectoryPicker v-model="form.defaultCwd" />
    </UFormField>

    <USeparator />
    <section class="space-y-4">
      <USwitch
        v-model="form.sessionTitles.enabled"
        label="Name sessions from their first message"
        description="A session started without a title gets a short one written by a small model, on your subscription. Until it arrives, and if it fails, the session is called by its first words."
      />
      <template v-if="form.sessionTitles.enabled">
        <UFormField label="Written by">
          <ChoiceMenu v-model="titleAdapter" :items="adapterItems" value-key="value" class="w-full" />
        </UFormField>
        <UFormField label="Model" help="A small, fast one is plenty.">
          <ChoiceMenu
            v-model="form.sessionTitles.model"
            :items="modelItems"
            value-key="value"
            :loading="probeStatus === 'pending'"
            class="w-full"
          />
        </UFormField>
      </template>
    </section>
  </SettingsShell>
</template>

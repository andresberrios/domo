<script setup lang="ts">
import type { AppSettings } from '~~/shared/types'

const toast = useToast()
const { data: settings, refresh } = await useFetch<AppSettings>('/api/settings')
const vscodeSshHost = ref('')
const homeMountsText = ref('')
watchEffect(() => {
  if (!settings.value) return
  vscodeSshHost.value = settings.value.vscodeSshHost
  homeMountsText.value = settings.value.homeMounts.join('\n')
})
const saving = ref(false)
async function save() {
  saving.value = true
  try {
    const homeMounts = homeMountsText.value.split('\n').map(line => line.trim()).filter(Boolean)
    await $fetch('/api/settings', { method: 'PATCH', body: { vscodeSshHost: vscodeSshHost.value, homeMounts } })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.data?.message ?? error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsShell
    title="Development environments"
    description="Host integration applied when a new managed environment is created."
    :saving="saving"
    :save="save"
  >
    <UFormField
      label="Home directory mounts"
      help="Paths under your home directory, one per line. They are mounted read-write into new environments; .gitconfig is included safely, while .claude, .claude.json and .codex are managed separately and refused."
    >
      <UTextarea v-model="homeMountsText" :rows="7" class="w-full font-mono text-xs" />
    </UFormField>
    <UFormField label="VS Code SSH host" help="Leave empty when VS Code and Docker are on the same machine. Otherwise use an SSH target such as you@server.">
      <UInput v-model="vscodeSshHost" class="w-full font-mono text-xs" placeholder="you@server" />
    </UFormField>
  </SettingsShell>
</template>

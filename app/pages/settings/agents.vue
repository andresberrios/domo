<script setup lang="ts">

const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()
const form = reactive({ defaultCwd: '', autoApprovePermissions: false })
watchEffect(() => {
  if (!settings.value) return
  form.defaultCwd = settings.value.defaultCwd
  form.autoApprovePermissions = settings.value.autoApprovePermissions
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
    <USwitch
      v-model="form.autoApprovePermissions"
      label="Auto-approve permission requests"
      description="Answers every prompt with its first “allow once” option. Convenient and dangerous — agents can edit and run things unattended."
    />
  </SettingsShell>
</template>

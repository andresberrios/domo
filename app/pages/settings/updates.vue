<script setup lang="ts">
import type { AppSettings } from '~~/shared/types'

const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()
const { update, headline } = useAppUpdate()

const form = reactive<AppSettings['updates']>({ channel: 'release', checkIntervalMinutes: 60, autoApply: false, minHoursBetweenApplies: 1 })
watchEffect(() => {
  if (settings.value) Object.assign(form, settings.value.updates)
})

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { updates: { ...form } } })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.data?.message ?? error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

const busy = ref<'check' | 'apply' | 'restart' | null>(null)
async function act(action: 'check' | 'apply' | 'restart') {
  busy.value = action
  try {
    const result = await $fetch<{ restarting?: boolean }>(`/api/updates/${action}`, { method: 'POST' })
    if (action === 'restart' && result.restarting) toast.add({ title: 'Restarting Domo', description: 'The page reconnects by itself.', icon: 'i-lucide-rotate-cw' })
  } catch (error: any) {
    toast.add({ title: 'Could not do that', description: error?.data?.message ?? error?.message, color: 'error' })
  } finally {
    busy.value = null
  }
}

const intervals = [
  { label: 'Every 15 minutes', value: 15 },
  { label: 'Every hour', value: 60 },
  { label: 'Every 6 hours', value: 360 },
  { label: 'Once a day', value: 1440 }
]
const gaps = [
  { label: 'No minimum', value: 0 },
  { label: 'At least an hour apart', value: 1 },
  { label: 'At least 6 hours apart', value: 6 },
  { label: 'At least a day apart', value: 24 }
]

function when(iso: string | null | undefined) {
  if (!iso) return 'never'
  return new Date(iso).toLocaleString()
}
const statusColor = computed(() => {
  switch (update.value?.state) {
    case 'failed': return 'error' as const
    case 'ready': case 'building': case 'restarting': return 'primary' as const
    default: return update.value?.behind ? 'warning' as const : 'success' as const
  }
})
</script>

<template>
  <SettingsShell
    title="Updates"
    description="Domo follows a branch of its own repository. A new version is built beside the running one and switched to only once it starts; one that does not start is rolled back."
    :saving="saving"
    :save="save"
  >
    <UAlert
      v-if="!update"
      color="neutral"
      variant="subtle"
      icon="i-lucide-code"
      title="This is a development server"
      description="It runs from a checkout with pnpm dev and is updated with git. The installed kind (see Install in the README) is what checks for and applies new versions."
    />

    <template v-else>
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UBadge :color="statusColor" variant="subtle" :label="headline ?? 'Up to date'" />
              <span class="text-sm text-muted">on <code>{{ update.channel }}</code>, version <code>{{ update.installedCommit.slice(0, 7) }}</code> built {{ when(update.installedAt) }}</span>
            </div>
            <div class="flex items-center gap-2">
              <UButton
                label="Check now"
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="subtle"
                :loading="busy === 'check' || update.state === 'checking'"
                :disabled="update.state === 'building' || update.state === 'restarting'"
                @click="act('check')"
              />
              <UButton
                v-if="update.state === 'ready'"
                label="Restart now"
                icon="i-lucide-rotate-cw"
                :loading="busy === 'restart'"
                @click="act('restart')"
              />
              <UButton
                v-else
                label="Update now"
                icon="i-lucide-download"
                :loading="busy === 'apply' || update.state === 'building'"
                :disabled="update.behind === 0 || update.state === 'restarting'"
                @click="act('apply')"
              />
            </div>
          </div>
        </template>

        <div class="flex flex-col gap-3 text-sm">
          <p v-if="update.state === 'ready'" class="text-muted">
            The new version is built. Domo restarts onto it as soon as nothing is running<template v-if="update.blockers.length">; right now {{ update.blockers.join(', ') }}</template>.
            Restart now interrupts whatever is running.
          </p>
          <p v-else-if="update.state === 'building'" class="text-muted">
            Building the new version. Agents keep working; the restart comes after, at a quiet moment.
          </p>
          <UAlert
            v-if="update.lastError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="update.lastError"
          />
          <div class="text-muted">
            Last checked {{ when(update.checkedAt) }}<template v-if="update.lastAppliedAt">, last updated {{ when(update.lastAppliedAt) }}</template>.
          </div>
          <div v-if="update.commits.length">
            <div class="mb-1 font-medium">What is new</div>
            <ul class="flex flex-col gap-1">
              <li v-for="commit in update.commits" :key="commit.sha" class="flex gap-2">
                <code class="shrink-0 text-muted">{{ commit.sha.slice(0, 7) }}</code>
                <span>{{ commit.subject }}</span>
              </li>
            </ul>
          </div>
          <p v-else-if="update.behind === null && update.checkedAt" class="text-muted">
            More than the fetched history behind; the list of changes is not available.
          </p>
        </div>
      </UCard>

      <UFormField label="Channel" hint="The branch to follow" description="release is what everyone gets. main is every merge, as soon as it lands.">
        <UInput v-model="form.channel" class="w-full max-w-xs" />
      </UFormField>
      <UFormField label="Look for updates">
        <USelect v-model="form.checkIntervalMinutes" :items="intervals" class="w-full max-w-xs" />
      </UFormField>
      <USwitch
        v-model="form.autoApply"
        label="Install updates by themselves"
        description="Build each new version when it appears and restart onto it when no agent is working, no conversation is live, and no schedule is about to fire. Off, Domo only tells you."
      />
      <UFormField label="Automatic updates" :description="form.autoApply ? undefined : 'Applies when the switch above is on.'">
        <USelect v-model="form.minHoursBetweenApplies" :items="gaps" :disabled="!form.autoApply" class="w-full max-w-xs" />
      </UFormField>
    </template>
  </SettingsShell>
</template>

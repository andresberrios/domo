<script setup lang="ts">
import { AGENT_ADAPTERS } from '~~/shared/agent-adapters'

/**
 * Where this Domo stands: each coding agent and voice, and the way into the
 * setup guide. The keys themselves are on the pages of what uses them.
 */
const { data: setup } = useSetupStatus()

const rows = computed(() => {
  const status = setup.value
  if (!status) return []
  return [
    ...AGENT_ADAPTERS.map((adapter) => {
      const agent = status.agents.find(entry => entry.id === adapter.id)!
      return { id: adapter.id, label: adapter.label, icon: adapter.icon, to: `/settings/adapters/${adapter.id}`, badge: agentBadge(agent, status.progress.checks[adapter.id]) }
    }),
    { id: 'voice', label: 'Voice', icon: 'i-lucide-audio-lines', to: '/settings/voice', badge: voiceBadge(status.voice, status.progress.checks.voice) }
  ]
})

const alwaysShowTimes = useAlwaysShowTimes()
</script>

<template>
  <SettingsShell title="General" description="How this Domo is set up.">
    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold">Setup</h2>
          <p class="text-xs text-muted">Each coding agent and voice, and what they sign in with.</p>
        </div>
        <UButton to="/setup" icon="i-lucide-list-checks" label="Open the setup guide" color="neutral" variant="subtle" />
      </div>
      <div class="divide-y divide-default rounded-lg border border-default">
        <template v-if="rows.length">
          <NuxtLink
            v-for="row in rows"
            :key="row.id"
            :to="row.to"
            class="flex items-center gap-3 px-3 py-2.5 hover:bg-elevated/50"
          >
            <UIcon :name="row.icon" class="size-4 shrink-0 text-muted" />
            <span class="flex-1 text-sm">{{ row.label }}</span>
            <UBadge :label="row.badge.label" :color="row.badge.color" variant="subtle" />
            <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed" />
          </NuxtLink>
        </template>
        <div v-else class="space-y-2 p-3">
          <USkeleton v-for="n in 4" :key="n" class="h-6 w-full" />
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold">Transcripts</h2>
      <USwitch
        v-model="alwaysShowTimes"
        label="Always show message times"
        description="Otherwise a message's time shows when you point at it or tap it. Saved in this browser."
      />
    </section>
  </SettingsShell>
</template>

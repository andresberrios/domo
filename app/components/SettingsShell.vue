<script setup lang="ts">
import { AGENT_ADAPTERS } from '~~/shared/agent-adapters'

defineProps<{
  title: string
  description?: string
  saving?: boolean
  save?: (() => void | Promise<void>) | null
}>()

const sections = [
  { label: 'General', to: '/settings', icon: 'i-lucide-settings' },
  { label: 'Coding agents', to: '/settings/agents', icon: 'i-lucide-bot' }
]

const afterAdapters = [
  { label: 'Development environments', to: '/settings/environments', icon: 'i-lucide-container' },
  { label: 'MCP servers', to: '/settings/mcp', icon: 'i-lucide-blocks' }
]
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" icon="i-lucide-settings">
        <template #right>
          <UButton v-if="save" label="Save" icon="i-lucide-check" :loading="saving" @click="save" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 py-4 lg:flex-row lg:gap-10">
        <nav class="flex shrink-0 gap-1 overflow-x-auto lg:w-56 lg:flex-col" aria-label="Settings">
          <UButton
            v-for="item in sections"
            :key="item.to"
            :to="item.to"
            :label="item.label"
            :icon="item.icon"
            color="neutral"
            variant="ghost"
            class="shrink-0 justify-start"
            active-class="bg-elevated text-highlighted"
            :exact="item.to === '/settings'"
          />

          <p class="hidden px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-dimmed lg:block">
            Adapters
          </p>
          <UButton
            v-for="adapter in AGENT_ADAPTERS"
            :key="adapter.id"
            :to="`/settings/adapters/${adapter.id}`"
            :label="adapter.label"
            :icon="adapter.icon"
            color="neutral"
            variant="ghost"
            class="shrink-0 justify-start lg:ps-4"
            active-class="bg-elevated text-highlighted"
          />

          <USeparator class="hidden my-2 lg:block" />
          <UButton
            v-for="item in afterAdapters"
            :key="item.to"
            :to="item.to"
            :label="item.label"
            :icon="item.icon"
            color="neutral"
            variant="ghost"
            class="shrink-0 justify-start"
            active-class="bg-elevated text-highlighted"
          />
        </nav>

        <main class="min-w-0 flex-1">
          <ServiceBanner />
          <header class="mb-6">
            <h1 class="text-lg font-semibold">{{ title }}</h1>
            <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
          </header>
          <div class="space-y-6">
            <slot />
          </div>
        </main>
      </div>
    </template>
  </UDashboardPanel>
</template>

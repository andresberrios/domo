<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * The coding agent a session runs, with its model and effort on the chip and
 * every setting in the popover behind it. Changing them is the composer's
 * job, so the popover opens the composer's panel rather than repeat it.
 */
const props = defineProps<{
  session: AgentSession
  /** Whether the session can still be changed: a closed one has no composer to open. */
  editable: boolean
}>()

const open = ref(false)
const settingsOpen = useAgentSettingsOpen()
const adapter = computed(() => agentAdapterInfo(props.session.adapter))
const summary = computed(() => sessionSettingsSummary(props.session))
const detail = computed(() => [summary.value.model, summary.value.effort].filter(Boolean).join(' · '))

/**
 * Closing hands focus back to the chip, which is outside the composer's panel
 * and so would dismiss it the moment it opened; a hand-off keeps focus where
 * the panel puts it.
 */
let handingOff = false
const content = {
  align: 'start' as const,
  onCloseAutoFocus: (event: Event) => {
    if (handingOff) event.preventDefault()
    handingOff = false
  }
}

function change() {
  handingOff = true
  open.value = false
  settingsOpen.value = true
}
</script>

<template>
  <UPopover v-model:open="open" :content="content">
    <UButton
      color="neutral"
      variant="soft"
      size="xs"
      :title="[adapter.label, detail].filter(Boolean).join(' · ')"
      class="max-w-64 shrink-0"
      data-testid="agent-chip"
    >
      <template #leading>
        <UIcon :name="adapter.icon" class="size-3.5 shrink-0 text-dimmed" />
      </template>
      <span class="truncate">{{ adapter.label }}<span v-if="detail" class="text-dimmed"> · {{ detail }}</span></span>
    </UButton>

    <template #content>
      <div class="w-72 max-w-[calc(100vw-2rem)] space-y-3 p-3 text-sm" data-testid="agent-settings-summary">
        <p class="flex items-center gap-2 font-medium">
          <UIcon :name="adapter.icon" class="size-4 text-muted" />
          {{ adapter.label }}
        </p>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt class="text-muted">
            Model
          </dt>
          <dd class="min-w-0 truncate font-mono" :title="summary.model ?? undefined">
            {{ summary.model ?? 'Default' }}
          </dd>
          <template v-for="option in summary.options" :key="option.id">
            <dt class="text-muted">
              {{ option.label }}
            </dt>
            <dd class="min-w-0 truncate" :title="option.value ?? undefined">
              {{ option.value }}
            </dd>
          </template>
          <template v-if="summary.mode">
            <dt class="text-muted">
              {{ adapter.modeLabel }}
            </dt>
            <dd class="min-w-0 truncate" :title="summary.mode">
              {{ summary.mode }}
            </dd>
          </template>
        </dl>
        <UButton
          v-if="editable"
          label="Change settings"
          icon="i-lucide-sliders-horizontal"
          color="neutral"
          variant="subtle"
          size="xs"
          block
          @click="change"
        />
      </div>
    </template>
  </UPopover>
</template>

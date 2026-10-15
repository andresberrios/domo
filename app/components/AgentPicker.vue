<script setup lang="ts">
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * Picks a coding agent session, grouped the way the sidebar groups them: by
 * project, then by environment, with an environment that holds one session
 * offered as one entry (its icon and name, then the session's).
 *
 * Only what can still take a message is offered. A value chosen earlier that
 * has since been archived or lost its environment stays in the list under a
 * heading of its own, so a form being edited still shows what it points at.
 *
 * `leading` puts other targets first, such as assistants, as plain items.
 */
interface LeadingItem { label: string, value: string, icon?: string }

interface PickerItem {
  type?: 'label'
  label: string
  value?: string
  icon?: string
  session?: AgentSession
  environment?: DevEnvironment | null
  /** Project, environment and title, so a search for any of them finds the entry. */
  search?: string
  description?: string
}

const props = defineProps<{
  leading?: { label: string, items: LeadingItem[] }
  placeholder?: string
}>()

const model = defineModel<string>({ default: '' })

const { groups, sessions, all } = useSessionGroups('offered')

/** A selected session that is no longer offered, and why. */
const stale = computed(() => {
  const id = model.value
  if (!id || sessions.value.some(session => session.id === id)) return null
  const session = all.value.find(item => item.id === id)
  if (!session) return null
  return { session, reason: session.archived ? 'Archived' : 'Can no longer run' }
})

const items = computed<PickerItem[][]>(() => {
  const result: PickerItem[][] = []
  if (props.leading?.items.length) {
    result.push([
      { type: 'label', label: props.leading.label },
      ...props.leading.items.map(item => ({ ...item, search: item.label }))
    ])
  }
  for (const group of groups.value) {
    result.push([
      { type: 'label', label: sessionGroupLabel(group) },
      ...group.entries.map(({ session, environment }) => ({
        label: session.title,
        value: session.id,
        session,
        environment,
        search: [group.project?.name, group.environment?.name, environment?.name, session.title].filter(Boolean).join(' ')
      }))
    ])
  }
  if (stale.value) {
    const { session, reason } = stale.value
    result.push([
      { type: 'label', label: 'No longer offered' },
      { label: session.title, value: session.id, session, environment: null, description: reason, search: session.title }
    ])
  }
  return result
})

const selected = computed(() => items.value.flat().find(item => item.type !== 'label' && item.value === model.value) ?? null)
</script>

<template>
  <ChoiceMenu
    v-model="model"
    :items="items"
    value-key="value"
    :filter-fields="['label', 'search']"
    :placeholder="placeholder"
  >
    <template #leading>
      <template v-if="selected?.session">
        <EnvironmentIcon v-if="selected.environment" :status="selected.environment.status" />
        <AgentStatusIcon :status="selected.session.status" />
      </template>
      <UIcon v-else-if="selected?.icon" :name="selected.icon" class="size-4 shrink-0 text-dimmed" />
    </template>

    <template #item-leading="{ item }">
      <span v-if="(item as PickerItem).session" class="flex shrink-0 items-center gap-1.5">
        <EnvironmentIcon v-if="(item as PickerItem).environment" :status="(item as PickerItem).environment!.status" />
        <AgentStatusIcon :status="(item as PickerItem).session!.status" />
      </span>
      <UIcon v-else-if="(item as PickerItem).icon" :name="(item as PickerItem).icon!" class="size-4 shrink-0 text-dimmed" />
    </template>

    <template #item-label="{ item }">
      <span v-if="(item as PickerItem).environment" class="flex min-w-0 items-baseline gap-1.5">
        <span class="max-w-[50%] shrink-0 truncate text-muted">{{ (item as PickerItem).environment!.name }}</span>
        <span class="min-w-0 truncate">{{ (item as PickerItem).label }}</span>
      </span>
      <template v-else>
        {{ (item as PickerItem).label }}
      </template>
    </template>
  </ChoiceMenu>
</template>

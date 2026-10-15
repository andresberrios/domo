<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * Other sessions, as one chip in an agent page's header: a link to the one
 * when there is one, and a count that opens a list when there are several,
 * grouped the way the sidebar groups them. Each says its status with the same
 * dot the sidebar uses, live.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  sessions: AgentSession[]
  icon: string
  /** Before the title of a single session: "Started by". */
  single: string
  /** The count's words for several: "3 started". */
  several: (count: number) => string
  /** Unanswered permission requests among them, said on the chip. */
  pending?: number
}>()

const open = ref(false)
const { all: projects } = useProjects()
const { all: environments } = useDevEnvironments()

const only = computed(() => props.sessions.length === 1 ? props.sessions[0]! : null)
/** The list's sections. One the grouping cannot place (its environment not synced yet) is still listed, last. */
const sections = computed(() => {
  const groups = groupSessions(props.sessions, projects.value, environments.value)
  const placed = new Set(groups.flatMap(group => group.entries.map(entry => entry.session.id)))
  const unplaced = props.sessions.filter(session => !placed.has(session.id))
  return [
    ...groups.map(group => ({ key: group.key, label: sessionGroupLabel(group), sessions: group.entries.map(entry => entry.session) })),
    ...unplaced.length ? [{ key: 'unplaced', label: '', sessions: unplaced }] : []
  ]
})
/** A few dots on the count, busiest first, so the chip alone says whether anything is moving. */
const RANK: Record<string, number> = { 'awaiting-permission': 0, 'error': 1, 'thinking': 2, 'starting': 2 }
const dots = computed(() => [...props.sessions]
  .sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3))
  .slice(0, 3))
const label = computed(() => only.value ? `${props.single} ${only.value.title}` : props.several(props.sessions.length))
const waiting = computed(() => props.pending ? `${props.pending} waiting for you` : null)
const meta = (status: string) => AGENT_STATUS_META[status] ?? AGENT_STATUS_META.idle!
/** The status dot; a resting one is drawn in the dimmed text colour, as `bg-muted` is the chip's own. */
const dot = (status: string) => meta(status).dot.replace('bg-muted', 'bg-(--ui-text-dimmed)')
</script>

<template>
  <UButton
    v-if="only"
    v-bind="$attrs"
    :to="`/agents/${only.id}`"
    color="neutral"
    variant="soft"
    size="xs"
    :title="[label, meta(only.status).label, waiting].filter(Boolean).join(' · ')"
    class="max-w-64 shrink-0"
  >
    <template #leading>
      <UIcon :name="icon" class="size-3.5 shrink-0 text-dimmed" />
    </template>
    <span class="truncate">{{ label }}</span>
    <template #trailing>
      <span class="size-2 shrink-0 rounded-full" :class="dot(only.status)" />
      <span class="sr-only">{{ meta(only.status).label }}</span>
      <span v-if="pending" class="flex items-center gap-0.5 font-medium text-warning">
        <UIcon name="i-lucide-shield-alert" class="size-3.5" />{{ pending }}
      </span>
    </template>
  </UButton>

  <UPopover v-else-if="sessions.length" v-model:open="open" :content="{ align: 'start' }">
    <UButton
      v-bind="$attrs"
      color="neutral"
      variant="soft"
      size="xs"
      :title="[label, waiting].filter(Boolean).join(' · ')"
      class="shrink-0"
      trailing-icon="i-lucide-chevron-down"
    >
      <template #leading>
        <UIcon :name="icon" class="size-3.5 shrink-0 text-dimmed" />
      </template>
      {{ label }}
      <span class="flex items-center gap-0.5">
        <span v-for="session in dots" :key="session.id" class="size-2 shrink-0 rounded-full" :class="dot(session.status)" />
      </span>
      <span v-if="pending" class="flex items-center gap-0.5 font-medium text-warning">
        <UIcon name="i-lucide-shield-alert" class="size-3.5" />{{ pending }}
      </span>
    </UButton>

    <template #content>
      <div class="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto p-1" data-testid="session-links">
        <p v-if="waiting" class="flex items-center gap-1.5 px-2 py-1.5 text-xs text-warning">
          <UIcon name="i-lucide-shield-alert" class="size-3.5" />
          {{ waiting }}
        </p>
        <template v-for="group in sections" :key="group.key">
          <p v-if="group.label" class="truncate px-2 pt-2 pb-1 text-xs font-medium text-dimmed">
            {{ group.label }}
          </p>
          <NuxtLink
            v-for="session in group.sessions"
            :key="session.id"
            :to="`/agents/${session.id}`"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
            @click="open = false"
          >
            <AgentStatusIcon :status="session.status" />
            <span class="min-w-0 flex-1 truncate" :title="session.title">{{ session.title }}</span>
            <span class="shrink-0 text-xs" :class="session.status === 'awaiting-permission' ? 'text-warning' : 'text-dimmed'">
              {{ session.archived ? 'Archived' : meta(session.status).label }}
            </span>
          </NuxtLink>
        </template>
      </div>
    </template>
  </UPopover>
</template>

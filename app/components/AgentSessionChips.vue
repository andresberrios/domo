<script setup lang="ts">
import type { AgentDraft, AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * The row under an agent page's title: where the session works, what runs it,
 * and the sessions it is tied to, each a way there. Only what exists is shown.
 *
 * A draft says where it is about to work in the same places a session says
 * where it works, so the row does not jump when it becomes one. On a narrow
 * screen the row scrolls sideways rather than wrapping under the title.
 */
const props = defineProps<{
  session: AgentSession | null
  draft: AgentDraft | null
  /** The session cannot take messages: nothing on it can be changed. */
  closed: boolean
  /** On the assistant's own page, which needs no way to itself. */
  inAssistant?: boolean
}>()

const { all: sessions } = useAgentSessions()
const { all: environments } = useDevEnvironments()
const { all: projects } = useProjects()
const { follows } = useAgentFollows()
const { pending } = usePermissions()

const environmentId = computed(() => props.session ? props.session.devEnvironmentId : props.draft?.devEnvironmentId ?? null)
const environment = computed(() => environments.value.find(item => item.id === environmentId.value) ?? null)
const cwd = computed(() => props.session?.cwd ?? props.draft?.cwd ?? null)
const project = computed(() => cwd.value
  ? sessionProject({ cwd: cwd.value, devEnvironmentId: environmentId.value }, environment.value, projects.value)
  : null)
/** The branch, when the environment's name does not already say it. */
const branch = computed(() => {
  const name = environment.value?.branch
  return name && name !== environment.value?.name ? name : null
})

const { assistant } = useAssistant(() => props.session?.assistantId)
const handedOff = computed(() => !!assistant.value && assistant.value.currentSessionId !== props.session?.id)

const spawner = computed(() => {
  const id = props.session?.spawnedBy
  return id ? sessions.value.filter(item => item.id === id) : []
})
const started = computed(() => props.session ? startedSessions(props.session.id, sessions.value) : [])
const following = computed(() => props.session ? followedSessions(props.session.id, follows.value, sessions.value) : [])
</script>

<template>
  <div class="-my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none]" data-testid="session-chips">
    <SessionFolderChip
      v-if="cwd && (session || !draft?.devEnvironmentId)"
      :path="cwd"
      :project="project"
    />

    <UButton
      v-if="environment"
      :to="`/environments/${environment.id}`"
      color="neutral"
      variant="soft"
      size="xs"
      :title="[`Environment ${environment.name}`, environment.retiredAt ? 'retired' : ENVIRONMENT_STATUS_META[environment.status]?.label, environment.branch && `branch ${environment.branch}`].filter(Boolean).join(' · ')"
      class="max-w-48 shrink-0"
      data-testid="environment-chip"
    >
      <template #leading>
        <EnvironmentIcon :status="environment.retiredAt ? 'retired' : environment.status" size="size-3.5" />
      </template>
      <span class="truncate">{{ environment.retiredAt ? `${environment.name} (retired)` : environment.name }}</span>
    </UButton>

    <UBadge
      v-if="branch"
      color="neutral"
      variant="outline"
      size="sm"
      :title="`Branch ${branch}`"
      class="max-w-40 shrink-0 font-mono"
    >
      <template #leading>
        <UIcon name="i-lucide-git-branch" class="size-3 shrink-0 text-dimmed" />
      </template>
      <span class="truncate">{{ branch }}</span>
    </UBadge>

    <SessionAgentChip v-if="session" :session="session" :editable="!closed" />
    <UBadge
      v-else
      color="neutral"
      variant="soft"
      size="sm"
      class="shrink-0"
      :label="draft ? agentAdapterInfo(draft.adapter).label : 'Coding agent'"
      :icon="draft ? agentAdapterInfo(draft.adapter).icon : undefined"
    />

    <UButton
      v-if="assistant && !inAssistant"
      :to="`/assistants/${assistant.id}`"
      color="primary"
      variant="soft"
      size="xs"
      :title="handedOff ? `An earlier session of ${assistant.name}` : `${assistant.name}'s current session`"
      class="max-w-56 shrink-0"
      data-testid="assistant-chip"
    >
      <template #leading>
        <UAvatar :src="assistant.avatar ?? undefined" :alt="assistant.name" size="3xs" />
      </template>
      <span class="truncate">{{ handedOff ? `${assistant.name}, earlier` : assistant.name }}</span>
    </UButton>

    <SessionLinksChip
      :sessions="spawner"
      icon="i-lucide-corner-left-up"
      single="Started by"
      :several="() => 'Started by'"
      data-testid="spawner-chip"
    />
    <SessionLinksChip
      :sessions="started"
      icon="i-lucide-git-fork"
      single="Started"
      :several="count => `Started ${count}`"
      :pending="pendingAmong(started, pending)"
      data-testid="started-chip"
    />
    <SessionLinksChip
      :sessions="following"
      icon="i-lucide-radio"
      single="Following"
      :several="count => `Following ${count}`"
      :pending="pendingAmong(following, pending)"
      data-testid="following-chip"
    />

    <TargetSchedules v-if="session" :agent-session-id="session.id" :assistant-id="handedOff ? null : assistant?.id" />
  </div>
</template>

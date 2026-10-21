<script setup lang="ts">
/**
 * The assistants, above the projects: each is one conversation, so a row is
 * a face, a name and what its current session is doing. Their sessions are
 * in its journal, not in the tree.
 */
const { assistants } = useAssistants()
const { all: sessions } = useAgentSessions()
const { pending } = usePermissions()

const creating = ref(false)

function statusOf(sessionId: string | null) {
  return sessions.value.find(session => session.id === sessionId)?.status ?? 'stopped'
}

function pendingFor(sessionId: string | null) {
  return pending.value.filter(permission => permission.agentSessionId === sessionId).length
}
</script>

<template>
  <section>
    <div class="flex items-center justify-between gap-1 ps-2 pb-1">
      <h2 class="text-xs font-medium text-muted">
        Assistants
      </h2>
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="New assistant"
        @click="creating = true"
      />
    </div>

    <button
      v-if="!assistants.length"
      type="button"
      class="w-full rounded-lg border border-dashed border-default px-3 py-3 text-start text-xs text-muted hover:bg-elevated"
      @click="creating = true"
    >
      An assistant is someone you keep talking to — an inbox organizer, a release
      manager — with one conversation that carries on across sessions.
    </button>

    <MotionList v-else class="flex flex-col gap-px">
      <li v-for="assistant in assistants" :key="assistant.id">
        <div :class="ROW_CLASS">
          <NuxtLink
            :to="`/assistants/${assistant.id}`"
            class="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md ps-1.5 text-sm"
            active-class="row-active"
            :title="assistant.name"
          >
            <UAvatar :src="assistant.avatar ?? undefined" :alt="assistant.name" size="2xs" />
            <span class="min-w-0 flex-1 truncate">{{ assistant.name }}</span>
            <BoardUnseenDot :owner-id="assistant.id" />
            <UIcon v-if="assistant.handoff" name="i-lucide-notebook-pen" class="size-3.5 shrink-0 text-dimmed" />
            <AgentStatusIcon v-else :status="statusOf(assistant.currentSessionId)" />
          </NuxtLink>
          <UChip
            v-if="pendingFor(assistant.currentSessionId)"
            :text="pendingFor(assistant.currentSessionId)"
            color="warning"
            size="sm"
            standalone
          />
        </div>
      </li>
    </MotionList>

    <AssistantModal v-model:open="creating" />
  </section>
</template>

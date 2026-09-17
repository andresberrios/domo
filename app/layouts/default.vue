<script setup lang="ts">
const { sessions: voiceSessions } = useVoiceSessions()
const { sessions: agentSessions } = useAgentSessions()
const { pending } = usePermissions()
const router = useRouter()
const toast = useToast()

const creating = ref(false)
const newAgentOpen = ref(false)

const pendingByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const permission of pending.value) {
    map.set(permission.agentSessionId, (map.get(permission.agentSessionId) ?? 0) + 1)
  }
  return map
})

async function startConversation() {
  creating.value = true
  try {
    const session = await $fetch<{ id: string }>('/api/voice-sessions', { method: 'POST', body: {} })
    await router.push(`/voice/${session.id}`)
  } catch (error: any) {
    toast.add({
      title: 'Could not start a conversation',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar
      id="domo-sidebar"
      mode="slideover"
      resizable
      collapsible
      :default-size="18"
      :min-size="14"
      :max-size="28"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2 px-1 py-0.5">
          <span class="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <UIcon name="i-lucide-audio-lines" class="size-4" />
          </span>
          <span v-if="!collapsed" class="text-sm font-semibold tracking-tight">Domo</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <UButton
              label="New conversation"
              icon="i-lucide-mic"
              block
              :loading="creating"
              @click="startConversation"
            />
            <UButton
              to="/projects"
              label="Projects"
              icon="i-lucide-box"
              color="neutral"
              variant="ghost"
              block
              class="justify-start"
            />
            <UButton
              label="New coding agent"
              icon="i-lucide-plus"
              color="neutral"
              variant="subtle"
              block
              @click="newAgentOpen = true"
            />
          </div>

          <div v-if="agentSessions.length">
            <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Coding agents
            </p>
            <ul class="space-y-0.5">
              <li v-for="agent in agentSessions" :key="agent.id">
                <NuxtLink
                  :to="`/agents/${agent.id}`"
                  class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                  active-class="bg-elevated font-medium"
                >
                  <StatusDot :status="agent.status">
                    <span class="sr-only">{{ agent.status }}</span>
                  </StatusDot>
                  <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                  <UChip
                    v-if="pendingByAgent.get(agent.id)"
                    :text="pendingByAgent.get(agent.id)"
                    color="warning"
                    size="sm"
                    standalone
                  />
                </NuxtLink>
              </li>
            </ul>
          </div>

          <div v-if="voiceSessions.length">
            <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Conversations
            </p>
            <ul class="space-y-0.5">
              <li v-for="session in voiceSessions" :key="session.id">
                <NuxtLink
                  :to="`/voice/${session.id}`"
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                  active-class="bg-elevated font-medium"
                >
                  <UIcon
                    :name="session.status === 'live' ? 'i-lucide-radio' : 'i-lucide-message-circle'"
                    class="size-4 shrink-0"
                    :class="session.status === 'live' ? 'text-primary' : 'text-dimmed'"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>

        <div v-else class="flex flex-col items-center gap-2">
          <UButton icon="i-lucide-mic" :loading="creating" @click="startConversation" />
          <UButton icon="i-lucide-plus" color="neutral" variant="ghost" @click="newAgentOpen = true" />
          <UButton to="/projects" icon="i-lucide-box" color="neutral" variant="ghost" />
        </div>
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center justify-between gap-2">
          <UButton
            to="/settings"
            icon="i-lucide-settings"
            :label="collapsed ? undefined : 'Settings'"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            class="justify-start"
          />
          <ColorModeButton v-if="!collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <NewAgentModal v-model:open="newAgentOpen" />
  </UDashboardGroup>
</template>

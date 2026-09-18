<script setup lang="ts">
const { sessions: voiceSessions } = useVoiceSessions()
const { sessions: agents } = useAgentSessions()
const { pending } = usePermissions()

const { data: settings } = await useFetch('/api/settings', { lazy: true })

const { creating, startConversation } = useNewConversation()
const newAgentOpen = ref(false)

const working = computed(() => agents.value.filter(agent => agent.status === 'thinking').length)
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar title="Domo" icon="i-lucide-audio-lines">
        <template #right>
          <UButton
            label="New agent"
            icon="i-lucide-plus"
            color="neutral"
            variant="subtle"
            @click="newAgentOpen = true"
          />
          <UButton label="Talk" icon="i-lucide-mic" :loading="creating" @click="startConversation" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl space-y-8 py-6">
        <ServiceBanner />
        <section class="text-center">
          <h1 class="text-2xl font-semibold tracking-tight">
            Your voice control room for coding agents
          </h1>
          <p class="mx-auto mt-2 max-w-xl text-sm text-muted">
            Talk to a Gemini Live agent. It spawns Claude Code sessions over ACP, watches them,
            answers their permission prompts, and tells you what changed — while you keep your
            hands free.
          </p>
          <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
            <UButton
              label="Start talking"
              icon="i-lucide-mic"
              size="lg"
              :loading="creating"
              @click="startConversation"
            />
            <UButton
              label="Start a coding agent"
              icon="i-lucide-bot"
              color="neutral"
              variant="subtle"
              size="lg"
              @click="newAgentOpen = true"
            />
          </div>
        </section>

        <UAlert
          v-if="settings && !settings.hasGeminiKey"
          color="warning"
          variant="subtle"
          icon="i-lucide-key-round"
          title="No Gemini API key yet"
          description="Add NUXT_GEMINI_API_KEY to your .env and restart the dev server to enable the voice agent."
        />

        <div class="grid gap-3 sm:grid-cols-3">
          <UPageCard
            icon="i-lucide-bot"
            :title="String(agents.length)"
            description="coding agents"
            variant="subtle"
          />
          <UPageCard
            icon="i-lucide-activity"
            :title="String(working)"
            description="working right now"
            variant="subtle"
          />
          <UPageCard
            icon="i-lucide-shield-question"
            :title="String(pending.length)"
            description="waiting on a decision"
            variant="subtle"
            :ui="{ root: pending.length ? 'ring-warning/40' : undefined }"
          />
        </div>

        <section v-if="pending.length">
          <h2 class="mb-2 text-sm font-semibold text-warning">
            Needs your answer
          </h2>
          <div class="space-y-2">
            <PermissionCard
              v-for="permission in pending"
              :key="permission.id"
              :permission="permission"
            />
          </div>
        </section>

        <section v-if="agents.length">
          <h2 class="mb-2 text-sm font-semibold">
            Coding agents
          </h2>
          <div class="grid gap-3 sm:grid-cols-2">
            <ULink
              v-for="agent in agents"
              :key="agent.id"
              :to="`/agents/${agent.id}`"
              class="rounded-lg border border-default p-3 transition hover:bg-elevated/50"
            >
              <div class="flex items-center gap-2">
                <StatusDot :status="agent.status" />
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ agent.title }}</span>
                <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(agent.lastActivityAt) }}</span>
              </div>
              <p class="mt-1 truncate font-mono text-xs text-dimmed">
                {{ shortPath(agent.cwd, 3) }}
              </p>
              <p v-if="agent.summary" class="mt-2 text-xs text-muted">
                {{ truncate(agent.summary, 130) }}
              </p>
            </ULink>
          </div>
        </section>

        <section v-if="voiceSessions.length">
          <h2 class="mb-2 text-sm font-semibold">
            Recent conversations
          </h2>
          <div class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <ULink
              v-for="session in voiceSessions.slice(0, 6)"
              :key="session.id"
              :to="`/voice/${session.id}`"
              class="flex items-center gap-3 p-3 hover:bg-elevated/50"
            >
              <UIcon
                :name="session.status === 'live' ? 'i-lucide-radio' : 'i-lucide-message-circle'"
                class="size-4 shrink-0"
                :class="session.status === 'live' ? 'text-primary' : 'text-dimmed'"
              />
              <span class="min-w-0 flex-1 truncate text-sm">{{ session.title }}</span>
              <span class="shrink-0 text-xs text-dimmed">
                {{ relativeTime(session.lastActivityAt ?? session.createdAt) }}
              </span>
            </ULink>
          </div>
        </section>
      </div>
        <NewAgentModal v-model:open="newAgentOpen" />
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
const { sessions: everySession, all: allSessions } = useAgentSessions()
/** The coding agents the sidebar shows, grouped the way it groups them. */
const { sessions: agents, groups } = useSessionGroups()
const { pending } = usePermissions()
const { environments } = useDevEnvironments()

const { creating, talk } = useTalk()

const working = computed(() => everySession.value.filter(agent => agent.status === 'thinking').length)
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar title="Domo" icon="i-lucide-audio-lines">
        <template #right>
          <UButton
            label="New session"
            icon="i-lucide-plus"
            color="neutral"
            variant="subtle"
            to="/agents/new"
          />
          <UButton label="Talk" icon="i-lucide-mic" :loading="creating" @click="talk" />
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
            Talk to Claude Code, Codex or OpenCode out loud. Each one can start and watch others,
            and whichever you are talking to reads out their permission prompts and notes, so you
            can keep your hands free.
          </p>
          <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
            <UButton
              label="Start talking"
              icon="i-lucide-mic"
              size="lg"
              :loading="creating"
              @click="talk"
            />
            <UButton
              label="Start a session"
              icon="i-lucide-bot"
              color="neutral"
              variant="subtle"
              size="lg"
              to="/agents/new"
            />
          </div>
        </section>

<UsageLimitsCard />

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UPageCard
            icon="i-lucide-monitor"
            :title="String(environments.filter(environment => environment.status === 'running').length)"
            description="dev environments"
            variant="subtle"
          />
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
              :agent-title="allSessions.find(agent => agent.id === permission.agentSessionId)?.title"
            />
          </div>
        </section>

        <section v-if="groups.length">
          <h2 class="mb-2 text-sm font-semibold">
            Coding agents
          </h2>
          <div class="space-y-4">
            <div v-for="group in groups" :key="group.key">
              <h3 class="mb-2 flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted">
                <EnvironmentIcon v-if="group.environment" :status="group.environment.status" size="size-3.5" />
                <UIcon v-else :name="group.project ? 'i-lucide-folder-git-2' : 'i-lucide-folder'" class="size-3.5 shrink-0" />
                <span class="truncate">{{ sessionGroupLabel(group) }}</span>
              </h3>
              <div class="grid gap-3 sm:grid-cols-2">
                <ULink
                  v-for="{ session: agent, environment } in group.entries"
                  :key="agent.id"
                  :to="`/agents/${agent.id}`"
                  class="min-w-0 rounded-lg border border-default p-3 transition hover:bg-elevated/50"
                >
                  <div class="flex items-center gap-2">
                    <span v-if="environment" class="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 text-sm text-muted" :title="environment.name">
                      <EnvironmentIcon :status="environment.status" />
                      <span class="truncate">{{ environment.name }}</span>
                    </span>
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
            </div>
          </div>
        </section>

      </div>
    </template>
  </UDashboardPanel>
</template>

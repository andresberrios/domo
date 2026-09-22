<script setup lang="ts">
import { revivalState } from '~~/shared/retention'
import type { AgentSession } from '~~/shared/types'

/**
 * Where a session goes when it leaves the sidebar, and the only place either
 * kind is findable again.
 *
 * Two lists, because the two states are genuinely different and were being
 * conflated before this page existed: **archived** is a shelf — the session is
 * still a session, it can be unarchived and resumed — and **retired** is a
 * tombstone, read-only for good, revivable only while the environment it ran in
 * is still around. Archiving previously had no way back at all in the UI, which
 * is also fixed here.
 *
 * Every row comes from the same Electric shape the sidebar reads; nothing is
 * filtered server-side, because a row filtered out of a shape cannot be reached
 * from the browser at all.
 */
const { archived, retired, isReady } = useArchivedAgentSessions()
const { all: allEnvironments } = useDevEnvironments()
const { all: allProjects } = useProjects()

const toast = useToast()
const busy = ref<string | null>(null)

function environmentFor(session: AgentSession) {
  return allEnvironments.value.find(item => item.id === session.devEnvironmentId) ?? null
}

/** "project / environment", with whichever of the two is a tombstone marked. */
function place(session: AgentSession): string {
  const environment = environmentFor(session)
  if (!environment) return shortPath(session.cwd, 3)
  const project = allProjects.value.find(item => item.id === environment.projectId)
  const name = environment.deletedAt ? `${environment.name} (deleted)` : environment.name
  return project ? `${project.name} / ${name}` : name
}

function whyRetired(session: AgentSession): string {
  switch (session.retiredReason) {
    case 'environment-deleted': return 'environment deleted'
    case 'project-deleted': return 'project deleted'
    default: return 'retired'
  }
}

/** Null when it can come back; otherwise the sentence saying why it cannot. */
function blockedReason(session: AgentSession): string | null {
  const state = revivalState(session, environmentFor(session))
  return state.revivable ? null : state.reason
}

async function act(session: AgentSession, request: () => Promise<unknown>, failure: string) {
  busy.value = session.id
  try {
    await request()
  } catch (error: any) {
    toast.add({
      title: failure,
      description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    busy.value = null
  }
}

function unarchive(session: AgentSession) {
  return act(
    session,
    () => $fetch(`/api/agents/${session.id}`, { method: 'PATCH', body: { archived: false } }),
    'Could not unarchive the session'
  )
}

function revive(session: AgentSession) {
  return act(
    session,
    () => $fetch(`/api/agents/${session.id}/revive`, { method: 'POST' }),
    'Could not revive the session'
  )
}
</script>

<template>
  <UDashboardPanel id="archive">
    <template #header>
      <UDashboardNavbar title="Archive" icon="i-lucide-archive" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl space-y-8 py-4">
        <section class="space-y-2">
          <div>
            <h2 class="text-sm font-semibold">
              Archived
            </h2>
            <p class="text-xs text-muted">
              Shelved, not finished. Unarchiving puts a session back in the sidebar, ready to be started again.
            </p>
          </div>

          <ul v-if="archived.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="session in archived" :key="session.id" class="flex items-center gap-3 px-4 py-2.5">
              <AgentStatusIcon :status="session.status" />
              <NuxtLink :to="`/agents/${session.id}`" class="min-w-0 flex-1">
                <p class="truncate text-sm">
                  {{ session.title }}
                </p>
                <p class="truncate font-mono text-xs text-dimmed">
                  {{ place(session) }}
                </p>
              </NuxtLink>
              <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(session.lastActivityAt ?? session.createdAt) }}</span>
              <UButton
                label="Unarchive"
                icon="i-lucide-archive-restore"
                color="neutral"
                variant="subtle"
                size="xs"
                :loading="busy === session.id"
                @click="unarchive(session)"
              />
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
            {{ isReady ? 'Nothing is archived.' : 'Loading…' }}
          </p>
        </section>

        <section class="space-y-2">
          <div>
            <h2 class="text-sm font-semibold">
              Retired
            </h2>
            <p class="text-xs text-muted">
              Finished sessions, kept for their transcripts. They are read-only: nothing can be sent to one, and no
              schedule or peer can wake it. A session whose environment still exists can be brought back into service.
            </p>
          </div>

          <ul v-if="retired.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="session in retired" :key="session.id" class="flex items-center gap-3 px-4 py-2.5">
              <UIcon name="i-lucide-box" class="size-4 shrink-0 text-dimmed" />
              <NuxtLink :to="`/agents/${session.id}`" class="min-w-0 flex-1">
                <p class="truncate text-sm">
                  {{ session.title }}
                </p>
                <p class="truncate font-mono text-xs text-dimmed">
                  {{ place(session) }}
                </p>
              </NuxtLink>
              <UBadge size="sm" color="neutral" variant="subtle" :label="whyRetired(session)" />
              <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(session.retiredAt) }}</span>
              <UButton
                v-if="!blockedReason(session)"
                label="Revive"
                icon="i-lucide-rotate-ccw"
                color="neutral"
                variant="subtle"
                size="xs"
                :loading="busy === session.id"
                @click="revive(session)"
              />
              <UTooltip v-else :text="blockedReason(session) ?? ''">
                <UButton label="Revive" icon="i-lucide-rotate-ccw" color="neutral" variant="ghost" size="xs" disabled />
              </UTooltip>
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
            {{ isReady ? 'Nothing has been retired yet.' : 'Loading…' }}
          </p>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>

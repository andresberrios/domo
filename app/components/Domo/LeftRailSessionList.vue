<script setup lang="ts">
/**
 * Sessions nested under an env in the left rail (Project ▸ Env ▸ Session).
 *
 * Lifecycle UI:
 *  - status dot (waiting / active / pending-approval / error) — the
 *    authoritative value is the in-process engine's per-turn write to the
 *    `sessions.status` cache (see server/lib/sessionEngine), pushed here
 *    on the coarse `table-change` channel via `useLiveRefresh`;
 *  - a new-output dot when this device hasn't seen the latest activity
 *    (`lastEventAt` newer than `viewed_at_per_device[deviceId]`);
 *  - per-row kebab: rename (inline), mark done / not done, delete.
 */
type Session = Awaited<
  ReturnType<typeof apiClient.sessions.list.call>
>[number]

const props = defineProps<{
  projectName: string
  envName: string
  envId: string
  showDone: boolean
  refreshKey: number
}>()

const { data: sessions, refresh } = await apiClient.sessions.list.useCall({
  envId: props.envId,
})
watch(() => props.refreshKey, () => refresh())

// Push-live refetch on any session-row write: insert/delete from
// create/done/rename/delete, and per-turn `updateSession` (status +
// lastEventAt) from the engine. The composable debounces a burst of
// in-turn updates into one SELECT.
useLiveRefresh(() => refresh(), { tables: ['sessions'] })

const visible = computed(() =>
  (sessions.value ?? []).filter((s) => props.showDone || !s.done),
)

const route = useRoute()
const deviceId = useDeviceId()
const creating = ref(false)
const errMsg = ref<string | null>(null)

async function createSession() {
  if (creating.value) return
  creating.value = true
  errMsg.value = null
  try {
    const s = await apiClient.sessions.create.call({ envId: props.envId })
    // Navigate first: the chat page resolves the session itself via
    // sessions.get, so it doesn't depend on the rail list being refreshed.
    // `navigateTo` (vs router.push) is reliable here — this is an async
    // setup component, so a `useRouter()` captured after the top-level
    // `await` runs outside the instance context and its push silently
    // no-ops. Refresh the rail afterwards so the new row + status dot show.
    await navigateTo(`/p/${props.projectName}/e/${props.envName}/s/${s.id}`)
    await refresh()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function isOpen(id: string): boolean {
  return String(route.params.session ?? '') === id
}

/** Unseen activity since this device last looked (suppressed while open). */
function hasNew(s: Session): boolean {
  if (isOpen(s.id) || s.lastEventAt == null) return false
  return s.lastEventAt > (s.viewedAtPerDevice[deviceId] ?? 0)
}

function dotColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-primary'
    case 'pending-approval':
      return 'bg-warning'
    case 'error':
      return 'bg-error'
    default:
      return 'bg-muted'
  }
}
function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Working'
    case 'pending-approval':
      return 'Needs approval'
    case 'error':
      return 'Error'
    default:
      return 'Waiting'
  }
}

// Inline rename.
const editingId = ref<string | null>(null)
const editTitle = ref('')
const renaming = ref(false)
function startRename(s: Session) {
  editingId.value = s.id
  editTitle.value = s.title ?? ''
  nextTick(() => {
    const el = document.getElementById(`sess-rename-${s.id}`)
    if (el instanceof HTMLInputElement) el.select()
  })
}
function cancelRename() {
  editingId.value = null
  editTitle.value = ''
}
async function commitRename(id: string) {
  const title = editTitle.value.trim()
  if (!title) return cancelRename()
  renaming.value = true
  try {
    await apiClient.sessions.rename.call({ id, title })
    await refresh()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    renaming.value = false
    cancelRename()
  }
}

async function toggleDone(s: Session) {
  try {
    await apiClient.sessions.done.call({ id: s.id, done: !s.done })
    await refresh()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeSession(s: Session) {
  if (
    !window.confirm(
      `Delete session "${s.title || 'Untitled session'}"? The agent and its ` +
        `transcript are torn down. This can't be undone.`,
    )
  ) {
    return
  }
  try {
    await apiClient.sessions.delete.call({ id: s.id })
    if (isOpen(s.id)) {
      await navigateTo(`/p/${props.projectName}/e/${props.envName}`)
    }
    await refresh()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  }
}

function rowMenu(s: Session) {
  return [
    [
      {
        label: 'Rename',
        icon: 'i-lucide-pencil',
        onSelect: () => startRename(s),
      },
      {
        label: s.done ? 'Mark not done' : 'Mark done',
        icon: s.done ? 'i-lucide-rotate-ccw' : 'i-lucide-check',
        onSelect: () => toggleDone(s),
      },
    ],
    [
      {
        label: 'Delete',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => removeSession(s),
      },
    ],
  ]
}
</script>

<template>
  <ul class="pl-5 space-y-0.5 mt-0.5">
    <li
      v-for="s in visible"
      :key="s.id"
      class="group/row relative"
    >
      <div
        v-if="editingId === s.id"
        class="flex items-center gap-1.5 px-1 py-0.5"
      >
        <UInput
          :id="`sess-rename-${s.id}`"
          v-model="editTitle"
          size="xs"
          class="flex-1"
          :disabled="renaming"
          @keydown.enter.prevent="commitRename(s.id)"
          @keydown.esc.prevent="cancelRename"
          @blur="cancelRename"
        />
      </div>

      <template v-else>
        <NuxtLink
          :to="`/p/${projectName}/e/${envName}/s/${s.id}`"
          class="flex items-center gap-1.5 rounded pl-1 pr-7 py-0.5 hover:bg-elevated"
          active-class="bg-accented font-medium"
          :class="s.done ? 'opacity-50' : ''"
        >
          <span
            class="size-1.5 rounded-full shrink-0"
            :class="[
              dotColor(s.status),
              s.status === 'active' ? 'animate-pulse' : '',
            ]"
            :title="statusLabel(s.status)"
          />
          <span class="truncate text-xs">{{
            s.title || 'Untitled session'
          }}</span>
          <span
            v-if="hasNew(s)"
            class="ml-auto size-1.5 rounded-full bg-primary shrink-0"
            title="New output since you last viewed"
          />
        </NuxtLink>

        <UDropdownMenu
          :items="rowMenu(s)"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            size="xs"
            class="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`Session actions for ${s.title || 'Untitled session'}`"
            @click.prevent.stop
          />
        </UDropdownMenu>
      </template>
    </li>

    <li>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded px-1 py-0.5 w-full text-left text-xs text-muted hover:bg-elevated hover:text-default disabled:opacity-50"
        :disabled="creating"
        @click="createSession"
      >
        <UIcon
          :name="creating ? 'i-lucide-loader-circle' : 'i-lucide-plus'"
          class="size-3 shrink-0"
          :class="creating ? 'animate-spin' : ''"
        />
        <span>New session</span>
      </button>
    </li>
    <li v-if="errMsg" class="px-1 text-xs text-error">
      {{ errMsg }}
    </li>
  </ul>
</template>

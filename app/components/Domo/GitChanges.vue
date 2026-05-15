<script setup lang="ts">
/**
 * VS Code-style git changes pane for the selected env's worktree. All git
 * runs on the host (the worktree is a host dir). Clicking a file opens the
 * before/after diff in the center area via the file route's `?diff=` flag.
 */
type Status = Awaited<ReturnType<typeof apiClient.git.status.call>>
type Entry = Status['staged'][number]

const props = defineProps<{
  envId: string
  projectName: string
  envName: string
}>()

const status = ref<Status | null>(null)
const error = ref<string | null>(null)
const message = ref('')
const busy = ref(false)
const notice = ref<string | null>(null)

async function load() {
  error.value = null
  try {
    status.value = await apiClient.git.status.call({ envId: props.envId })
  } catch (e) {
    error.value = (e as Error).message
    status.value = null
  }
}

watch(() => props.envId, load, { immediate: true })
useCoastEvents((e) => {
  if (e.event === 'project.git_changed') load()
})

const canCommit = computed(
  () => !!status.value && status.value.staged.length > 0 && message.value.trim().length > 0,
)

function diffHref(e: Entry, staged: boolean): string {
  const segs = e.path.split('/').map(encodeURIComponent).join('/')
  return `/p/${encodeURIComponent(props.projectName)}/e/${encodeURIComponent(props.envName)}/f/${segs}?diff=${staged ? 'staged' : 'unstaged'}`
}

function code(e: Entry, staged: boolean): string {
  if (e.index === '?' && e.worktree === '?') return 'U'
  return (staged ? e.index : e.worktree).trim() || 'M'
}

async function act(fn: () => Promise<unknown>) {
  busy.value = true
  notice.value = null
  try {
    await fn()
    await load()
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

const stage = (p: string) =>
  act(() => apiClient.git.stage.call({ envId: props.envId, path: p }))
const unstage = (p: string) =>
  act(() => apiClient.git.unstage.call({ envId: props.envId, path: p }))

async function commit() {
  if (!canCommit.value) return
  await act(async () => {
    const r = await apiClient.git.commit.call({
      envId: props.envId,
      message: message.value.trim(),
    })
    message.value = ''
    notice.value = `Committed ${r.hash}`
  })
}

async function push() {
  await act(async () => {
    const r = await apiClient.git.push.call({ envId: props.envId })
    notice.value = r.output || 'Pushed.'
  })
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center justify-between px-3 py-2 border-b border-default">
      <span class="text-xs text-muted">
        <template v-if="status?.branch">
          <UIcon name="i-lucide-git-branch" class="size-3 inline" />
          {{ status.branch }}
          <span v-if="status.ahead || status.behind" class="ml-1">
            ↑{{ status.ahead }} ↓{{ status.behind }}
          </span>
        </template>
        <template v-else>—</template>
      </span>
      <div class="flex gap-1">
        <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :disabled="busy" @click="load" />
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-upload"
          title="git push"
          :loading="busy"
          @click="push"
        />
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-auto">
      <p v-if="error" class="p-3 text-xs text-error">
        {{ error }}
      </p>

      <template v-else-if="status">
        <div
          v-if="status.unstaged.length === 0 && status.untracked.length === 0 && status.staged.length === 0"
          class="p-3 text-sm text-muted"
        >
          No changes.
        </div>

        <section v-if="status.staged.length" class="py-1">
          <h4 class="px-3 py-1 text-xs font-semibold text-muted uppercase tracking-wide">
            Staged ({{ status.staged.length }})
          </h4>
          <div
            v-for="e in status.staged"
            :key="`s-${e.path}`"
            class="group flex items-center gap-2 px-3 py-1 hover:bg-elevated"
          >
            <UBadge size="xs" color="success" variant="subtle" class="w-5 justify-center">
              {{ code(e, true) }}
            </UBadge>
            <NuxtLink :to="diffHref(e, true)" class="flex-1 truncate text-sm hover:underline">
              {{ e.path }}
            </NuxtLink>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-minus"
              title="Unstage"
              :disabled="busy"
              @click="unstage(e.path)"
            />
          </div>
        </section>

        <section v-if="status.unstaged.length || status.untracked.length" class="py-1">
          <h4 class="px-3 py-1 text-xs font-semibold text-muted uppercase tracking-wide">
            Changes ({{ status.unstaged.length + status.untracked.length }})
          </h4>
          <div
            v-for="e in [...status.unstaged, ...status.untracked]"
            :key="`u-${e.path}`"
            class="group flex items-center gap-2 px-3 py-1 hover:bg-elevated"
          >
            <UBadge
              size="xs"
              :color="e.index === '?' ? 'neutral' : 'warning'"
              variant="subtle"
              class="w-5 justify-center"
            >
              {{ code(e, false) }}
            </UBadge>
            <NuxtLink :to="diffHref(e, false)" class="flex-1 truncate text-sm hover:underline">
              {{ e.path }}
            </NuxtLink>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-plus"
              title="Stage"
              :disabled="busy"
              @click="stage(e.path)"
            />
          </div>
        </section>
      </template>
    </div>

    <div class="border-t border-default p-2 space-y-2">
      <UTextarea
        v-model="message"
        :rows="2"
        placeholder="Commit message"
        size="sm"
        class="w-full"
      />
      <div class="flex items-center gap-2">
        <UButton
          size="xs"
          color="primary"
          icon="i-lucide-check"
          :disabled="!canCommit || busy"
          :loading="busy"
          @click="commit"
        >
          Commit
        </UButton>
        <span v-if="notice" class="text-xs text-muted truncate">{{ notice }}</span>
      </div>
    </div>
  </div>
</template>

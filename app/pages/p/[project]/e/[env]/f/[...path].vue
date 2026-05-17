<script setup lang="ts">
/**
 * Center-area file surface. Three shapes off one route:
 *   ?diff=staged|unstaged  → before/after merge view (git changes)
 *   markdown file          → Comark preview ⇄ editable source
 *   any other text file    → CodeMirror view ⇄ edit + save
 * Binary / oversized files render a stub. Paths are worktree-relative and
 * server-side path-safe (`safeResolve`).
 */
type ReadResult = Awaited<ReturnType<typeof apiClient.workspace.read.call>>
type DiffResult = Awaited<ReturnType<typeof apiClient.git.diff.call>>

const route = useRoute()
const { envId } = useSelectedEnv()

const path = computed(() => {
  const p = route.params.path
  return Array.isArray(p) ? p.join('/') : String(p ?? '')
})
const diffMode = computed(() => {
  const d = route.query.diff
  return d === 'staged' || d === 'unstaged' ? d : null
})
// Full-screen view of a parked agent edit (the chat approval card links
// here). Served from the in-process park registry, so it's available
// while the turn is live; after a server restart it's gone — we fall back
// to a pointer to the chat card (which is durable / cross-device).
const pendingMode = computed(() => route.query.diff === 'pending')
const pendingDiff = ref<{ before: string; after: string } | null>(null)
const pendingGone = ref(false)

const loading = ref(false)
const errMsg = ref<string | null>(null)
const file = ref<ReadResult | null>(null)
const diff = ref<DiffResult | null>(null)
const content = ref('')
const savedContent = ref('')
const mode = ref<'view' | 'edit' | 'preview' | 'source'>('view')
const saving = ref(false)

const isMarkdown = computed(() => file.value?.language === 'markdown')
const dirty = computed(() => content.value !== savedContent.value)
const editorReadonly = computed(() =>
  isMarkdown.value ? mode.value !== 'source' : mode.value !== 'edit',
)

async function load() {
  if (!envId.value || !path.value) return
  loading.value = true
  errMsg.value = null
  try {
    if (pendingMode.value) {
      const sid = String(route.query.sid ?? '')
      const callId = String(route.query.callId ?? '')
      pendingGone.value = false
      pendingDiff.value = null
      file.value = null
      diff.value = null
      if (sid && callId) {
        const r = await apiClient.sessions.pendingDiff.call({
          id: sid,
          callId,
        })
        if (r) pendingDiff.value = { before: r.before, after: r.after }
        else pendingGone.value = true
      } else {
        pendingGone.value = true
      }
    } else if (diffMode.value) {
      diff.value = await apiClient.git.diff.call({
        envId: envId.value,
        path: path.value,
        staged: diffMode.value === 'staged',
      })
      file.value = null
    } else {
      const r = await apiClient.workspace.read.call({
        envId: envId.value,
        path: path.value,
      })
      file.value = r
      diff.value = null
      content.value = r.content ?? ''
      savedContent.value = r.content ?? ''
      mode.value = r.language === 'markdown' ? 'preview' : 'view'
    }
  } catch (e) {
    errMsg.value = (e as Error).message
    file.value = null
    diff.value = null
  } finally {
    loading.value = false
  }
}

watch(
  [envId, path, diffMode, pendingMode, () => route.query.callId],
  load,
  { immediate: true },
)

function toggleMode() {
  if (isMarkdown.value) {
    mode.value = mode.value === 'preview' ? 'source' : 'preview'
  } else {
    mode.value = mode.value === 'view' ? 'edit' : 'view'
  }
}

async function save() {
  if (!envId.value || !dirty.value) return
  saving.value = true
  errMsg.value = null
  try {
    await apiClient.workspace.write.call({
      envId: envId.value,
      path: path.value,
      content: content.value,
    })
    savedContent.value = content.value
  } catch (e) {
    errMsg.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center gap-2 border-b border-default px-4 py-2">
      <UIcon
        :name="diffMode || pendingMode ? 'i-lucide-git-compare' : 'i-lucide-file'"
        class="size-4 text-muted shrink-0"
      />
      <span class="text-sm font-mono truncate">{{ path }}</span>
      <span v-if="dirty && !diffMode && !pendingMode" class="size-2 rounded-full bg-warning shrink-0" title="Unsaved changes" />
      <span v-if="diffMode" class="text-xs text-muted">({{ diffMode }})</span>
      <span v-if="pendingMode" class="text-xs text-warning">(proposed — pending review)</span>

      <div class="ml-auto flex items-center gap-2">
        <span v-if="file" class="text-xs text-muted">{{ languageLabel(file.language) }}</span>

        <template v-if="file && !file.binary && !file.tooLarge">
          <UButton size="xs" variant="ghost" @click="toggleMode">
            {{ isMarkdown
              ? (mode === 'preview' ? 'Edit source' : 'Preview')
              : (mode === 'view' ? 'Edit' : 'View') }}
          </UButton>
          <UButton
            size="xs"
            color="primary"
            icon="i-lucide-save"
            :disabled="!dirty"
            :loading="saving"
            @click="save"
          >
            Save
          </UButton>
        </template>

        <UTooltip text="Open in chat — Phase 3">
          <UButton size="xs" variant="ghost" icon="i-lucide-message-square" disabled />
        </UTooltip>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-hidden">
      <div v-if="!envId" class="p-6 text-muted">
        No environment selected.
      </div>
      <div v-else-if="loading" class="p-6 text-muted">
        Loading…
      </div>
      <div v-else-if="errMsg" class="p-6 text-error text-sm">
        {{ errMsg }}
      </div>

      <DomoDiffView
        v-else-if="pendingMode && pendingDiff"
        :original="pendingDiff.before"
        :modified="pendingDiff.after"
        :language="languageFromPath(path)"
        class="h-full"
      />
      <div
        v-else-if="pendingMode && pendingGone"
        class="p-6 text-muted text-sm"
      >
        This proposed edit is no longer pending here (already decided, or
        the session runtime restarted). Review it from the session's chat —
        the approval card there is restored from the durable stream.
      </div>

      <DomoDiffView
        v-else-if="diff"
        :original="diff.original"
        :modified="diff.modified"
        :language="diff.language"
        class="h-full"
      />

      <div v-else-if="file?.binary" class="p-6 text-muted text-sm">
        Binary file — not shown.
      </div>
      <div v-else-if="file?.tooLarge" class="p-6 text-muted text-sm">
        File is too large to display ({{ Math.round(file.size / 1024) }} KB).
      </div>

      <DomoMarkdownView
        v-else-if="file && isMarkdown && mode === 'preview'"
        :content="content"
        class="h-full"
      />

      <DomoCodeEditor
        v-else-if="file"
        v-model="content"
        :language="file.language"
        :readonly="editorReadonly"
        class="h-full"
      />
    </div>
  </div>
</template>

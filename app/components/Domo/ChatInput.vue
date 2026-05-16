<script setup lang="ts">
/**
 * Chat prompt box with `/` slash-command and `@`-mention autocomplete.
 *
 * Trigger detection runs off the textarea value + caret; the popup list
 * is `DomoChatAutocomplete`. Navigation keys are intercepted at
 * keydown-**capture** on the wrapper so they never reach `UChatPrompt`'s
 * own Enter→submit / Esc→blur handlers on the inner textarea (the only
 * reliable way to override them without forking the component).
 *
 * The text the user sees/sends is raw (`/review`, `@file`); the entity
 * expands custom commands + mentions at execution time
 * (server/lib/promptExpand.ts) so the transcript stays faithful.
 */
import type { ChatStatus } from 'ai'
import type { AutocompleteItem } from '~/components/Domo/ChatAutocomplete.vue'

const props = defineProps<{
  sessionId: string
  status: ChatStatus
}>()
const emit = defineEmits<{ submit: []; stop: [] }>()
const text = defineModel<string>({ required: true })

type SlashDef = Awaited<
  ReturnType<typeof apiClient.sessions.commands.call>
>[number]
type MentionDef = Awaited<
  ReturnType<typeof apiClient.sessions.mentions.call>
>[number]

const promptRef = useTemplateRef<{ textareaRef?: unknown }>('promptRef')
const acRef = useTemplateRef<{
  scrollSelectedIntoView: (i: number) => void
}>('acRef')

function getTextarea(): HTMLTextAreaElement | null {
  const t = promptRef.value?.textareaRef
  if (t instanceof HTMLTextAreaElement) return t
  const inner = (t as { value?: unknown } | undefined)?.value
  return inner instanceof HTMLTextAreaElement ? inner : null
}

const mode = ref<'slash' | 'mention' | null>(null)
const query = ref('')
const triggerAt = ref(0)
const items = ref<AutocompleteItem[]>([])
const selectedIndex = ref(0)
const dismissedTrigger = ref<string | null>(null)

const popupVisible = computed(
  () => mode.value !== null && items.value.length > 0,
)
const popupHeader = computed(() =>
  mode.value === 'slash'
    ? 'Slash commands'
    : mode.value === 'mention'
      ? 'Add context'
      : undefined,
)

function detect(): { mode: 'slash' | 'mention'; query: string; at: number } | null {
  const el = getTextarea()
  const value = text.value
  const caret = el?.selectionStart ?? value.length
  const sm = /^\/([^\s]*)$/.exec(value)
  if (sm) return { mode: 'slash', query: sm[1] ?? '', at: 0 }
  const before = value.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at !== -1) {
    const prevOk = at === 0 || /\s/.test(before[at - 1] ?? '')
    const frag = before.slice(at + 1)
    if (
      prevOk &&
      !/\s/.test(frag) &&
      !frag.toLowerCase().startsWith('http')
    ) {
      return { mode: 'mention', query: frag, at }
    }
  }
  return null
}

function recompute() {
  const d = detect()
  if (!d) {
    mode.value = null
    return
  }
  const trig = `${d.mode}|${d.query}`
  if (dismissedTrigger.value === trig) {
    mode.value = null
    return
  }
  dismissedTrigger.value = null
  triggerAt.value = d.at
  if (mode.value !== d.mode || query.value !== d.query) {
    mode.value = d.mode
    query.value = d.query
  }
}
function scheduleRecompute() {
  nextTick(recompute)
}
watch(text, scheduleRecompute)

// ── data sources ────────────────────────────────────────────────────────
const slashRaw = ref<SlashDef[] | null>(null)
async function ensureSlashLoaded() {
  if (slashRaw.value) return
  try {
    slashRaw.value = await apiClient.sessions.commands.call({
      id: props.sessionId,
    })
  } catch {
    slashRaw.value = []
  }
}
const SOURCE_ICON: Record<string, string> = {
  builtin: 'i-lucide-slash',
  project: 'i-lucide-file-text',
  user: 'i-lucide-user',
}
function slashItems(q: string): AutocompleteItem[] {
  const needle = q.toLowerCase()
  return (slashRaw.value ?? [])
    .filter(
      (c) =>
        c.command.toLowerCase().includes(needle) ||
        c.description.toLowerCase().includes(needle),
    )
    .map((c) => ({
      key: c.command,
      title: c.command,
      subtitle: c.description,
      icon: SOURCE_ICON[c.source],
      tag: c.source === 'builtin' ? undefined : c.source,
    }))
}

const MENTION_ICON: Record<string, string> = {
  file: 'i-lucide-file',
  folder: 'i-lucide-folder',
  git: 'i-lucide-git-compare',
  commit: 'i-lucide-git-commit-horizontal',
}
function mentionItem(m: MentionDef): AutocompleteItem {
  return {
    key: m.value,
    title: m.label,
    subtitle: m.description,
    icon: MENTION_ICON[m.kind],
    tag: m.kind === 'commit' ? 'commit' : undefined,
  }
}
let mentionTimer: ReturnType<typeof setTimeout> | null = null
function loadMentions(q: string) {
  if (mentionTimer) clearTimeout(mentionTimer)
  mentionTimer = setTimeout(async () => {
    try {
      const res = await apiClient.sessions.mentions.call({
        id: props.sessionId,
        query: q,
      })
      if (mode.value !== 'mention' || query.value !== q) return
      items.value = res.map(mentionItem)
      selectedIndex.value = 0
    } catch {
      /* worktree gone / offline — popup just stays empty */
    }
  }, 150)
}

watch([mode, query], async ([m, q]) => {
  if (m === 'slash') {
    await ensureSlashLoaded()
    if (mode.value !== 'slash') return
    items.value = slashItems(q)
    selectedIndex.value = 0
  } else if (m === 'mention') {
    loadMentions(q)
  } else {
    items.value = []
  }
})

// ── selection / insertion ───────────────────────────────────────────────
function close() {
  mode.value = null
  items.value = []
}
async function applySelection(index: number) {
  const item = items.value[index]
  if (!item) return
  const el = getTextarea()
  if (mode.value === 'slash') {
    text.value = `${item.key} `
    await nextTick()
    const pos = text.value.length
    el?.setSelectionRange(pos, pos)
  } else {
    const value = text.value
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, triggerAt.value)
    const after = value.slice(caret)
    const insert = `@${item.key} `
    text.value = before + insert + after
    await nextTick()
    const pos = (before + insert).length
    el?.setSelectionRange(pos, pos)
  }
  el?.focus()
  close()
}
function dismiss() {
  dismissedTrigger.value = `${mode.value}|${query.value}`
  mode.value = null
}

function onCaptureKeydown(e: KeyboardEvent) {
  if (!popupVisible.value) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      e.stopPropagation()
      selectedIndex.value = Math.min(
        selectedIndex.value + 1,
        items.value.length - 1,
      )
      acRef.value?.scrollSelectedIntoView(selectedIndex.value)
      break
    case 'ArrowUp':
      e.preventDefault()
      e.stopPropagation()
      selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
      acRef.value?.scrollSelectedIntoView(selectedIndex.value)
      break
    case 'Enter':
    case 'Tab':
      e.preventDefault()
      e.stopPropagation()
      void applySelection(selectedIndex.value)
      break
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      dismiss()
      break
  }
}

function onSubmit() {
  // Capture-phase handler swallows Enter while the popup is open, so a
  // submit here means no popup — safe to send.
  close()
  emit('submit')
}

const placeholder = computed(() =>
  props.status === 'streaming'
    ? 'Agent is working — send to queue, or stop'
    : 'Message the agent…  ( / commands · @ context )',
)

// Used by the transcript's per-message "Edit" affordance (Chat.vue) to
// pull focus back to the prompt after pre-filling it.
defineExpose({ focus: () => getTextarea()?.focus() })
</script>

<template>
  <div
    class="relative"
    @keydown.capture="onCaptureKeydown"
    @keyup="scheduleRecompute"
    @mouseup="scheduleRecompute"
  >
    <DomoChatAutocomplete
      v-if="popupVisible"
      ref="acRef"
      :items="items"
      :selected-index="selectedIndex"
      :header="popupHeader"
      @select="applySelection"
      @hover="selectedIndex = $event"
    />

    <UChatPrompt
      ref="promptRef"
      v-model="text"
      :placeholder="placeholder"
      variant="subtle"
      @submit="onSubmit"
    >
      <template #footer>
        <div class="flex-1" />
        <UChatPromptSubmit
          :status="status"
          color="neutral"
          size="sm"
          @stop="emit('stop')"
        />
      </template>
    </UChatPrompt>
  </div>
</template>

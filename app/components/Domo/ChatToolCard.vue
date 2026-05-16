<script setup lang="ts">
/**
 * Renders one Claude Code tool call as a collapsible card, following the
 * patterns audited from the cloned VS Code Claude-Code-Chat extensions:
 * Read/Glob/Grep collapse to a one-line chip; Edit/Write show an inline
 * diff (reusing `DomoDiffView`); Bash shows command + stdout/stderr;
 * TodoWrite renders a checklist; everything else falls back to JSON.
 *
 * Input is an AI SDK `dynamic-tool` part (see app/utils/sessionMessages.ts).
 */
import { languageFromPath } from '~/utils/language'

interface ToolPart {
  toolName: string
  toolCallId: string
  state: string
  input?: Record<string, unknown>
  output?: unknown
  errorText?: string
}
const props = defineProps<{ part: ToolPart }>()

const input = computed(
  () => (props.part.input ?? {}) as Record<string, unknown>,
)
const name = computed(() => props.part.toolName)
const running = computed(
  () =>
    props.part.state === 'input-available' ||
    props.part.state === 'input-streaming',
)
const errored = computed(() => props.part.state === 'output-error')

const family = computed(() => {
  const n = name.value
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update'].includes(n))
    return 'edit'
  if (n === 'Bash' || n === 'BashOutput') return 'bash'
  if (n === 'TodoWrite') return 'todo'
  if (['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch'].includes(n))
    return 'lookup'
  return 'generic'
})

const icon = computed(
  () =>
    (
      ({
        Read: 'i-lucide-file-text',
        Edit: 'i-lucide-file-pen',
        Write: 'i-lucide-file-plus',
        MultiEdit: 'i-lucide-file-pen',
        NotebookEdit: 'i-lucide-file-pen',
        Update: 'i-lucide-file-pen',
        Bash: 'i-lucide-terminal',
        BashOutput: 'i-lucide-terminal',
        Glob: 'i-lucide-search',
        Grep: 'i-lucide-search',
        LS: 'i-lucide-folder',
        TodoWrite: 'i-lucide-list-checks',
        WebFetch: 'i-lucide-globe',
        WebSearch: 'i-lucide-globe',
      }) as Record<string, string>
    )[name.value] ?? 'i-lucide-wrench',
)

const summary = computed(() => {
  const i = input.value
  switch (name.value) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Update':
      return String(i.file_path ?? i.path ?? '')
    case 'NotebookEdit':
      return String(i.notebook_path ?? '')
    case 'Glob':
    case 'Grep':
      return String(i.pattern ?? '')
    case 'Bash':
      return String(i.command ?? '')
    case 'LS':
      return String(i.path ?? '')
    case 'WebFetch':
      return String(i.url ?? '')
    case 'WebSearch':
      return String(i.query ?? '')
    default:
      return ''
  }
})

const diff = computed(() => {
  const i = input.value
  if (name.value === 'Write')
    return { original: '', modified: String(i.content ?? '') }
  if (name.value === 'Edit' || name.value === 'Update')
    return {
      original: String(i.old_string ?? ''),
      modified: String(i.new_string ?? ''),
    }
  if (name.value === 'MultiEdit') {
    const edits = Array.isArray(i.edits)
      ? (i.edits as Array<{ old_string?: string; new_string?: string }>)
      : []
    return {
      original: edits.map((e) => e.old_string ?? '').join('\n'),
      modified: edits.map((e) => e.new_string ?? '').join('\n'),
    }
  }
  return null
})
const diffLanguage = computed(() => languageFromPath(summary.value))

const todos = computed(() => {
  const t = input.value.todos
  return Array.isArray(t)
    ? (t as Array<{ content?: string; status?: string }>)
    : []
})
function todoIcon(status?: string) {
  if (status === 'completed') return 'i-lucide-check-circle-2'
  if (status === 'in_progress') return 'i-lucide-loader-circle'
  return 'i-lucide-circle'
}

const outputText = computed(() => {
  if (errored.value) return props.part.errorText ?? ''
  const o = props.part.output
  if (typeof o === 'string') return o
  if (Array.isArray(o))
    return o
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && 'text' in b
            ? String((b as { text?: unknown }).text ?? '')
            : JSON.stringify(b),
      )
      .join('\n')
  if (o == null) return ''
  return typeof o === 'object' ? JSON.stringify(o, null, 2) : String(o)
})
</script>

<template>
  <UChatTool
    :text="name"
    :suffix="summary"
    :icon="icon"
    :streaming="running"
    :default-open="family === 'edit' || errored"
    chevron="leading"
    class="my-1"
  >
    <div class="text-sm">
      <p v-if="errored" class="text-error text-xs mb-2">
        Tool error
      </p>

      <DomoDiffView
        v-if="family === 'edit' && diff"
        :original="diff.original"
        :modified="diff.modified"
        :language="diffLanguage"
        class="max-h-96 border border-default rounded"
      />

      <div v-else-if="family === 'bash'">
        <pre class="text-xs bg-elevated/50 rounded p-2 overflow-x-auto whitespace-pre-wrap"><code>$ {{ input.command }}</code></pre>
        <pre
          v-if="outputText"
          class="mt-1 text-xs bg-elevated/30 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap"
        >{{ outputText }}</pre>
      </div>

      <ul v-else-if="family === 'todo'" class="space-y-1">
        <li
          v-for="(t, idx) in todos"
          :key="idx"
          class="flex items-start gap-2"
          :class="t.status === 'completed' ? 'text-muted line-through' : ''"
        >
          <UIcon
            :name="todoIcon(t.status)"
            class="size-4 mt-0.5 shrink-0"
            :class="t.status === 'in_progress' ? 'text-primary' : ''"
          />
          <span>{{ t.content }}</span>
        </li>
      </ul>

      <template v-else>
        <pre
          v-if="outputText"
          class="text-xs bg-elevated/30 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap"
        >{{ outputText }}</pre>
        <pre
          v-else-if="running"
          class="text-xs text-muted"
        >Running…</pre>
        <details v-if="family === 'generic'" class="mt-1">
          <summary class="text-xs text-muted cursor-pointer">
            input
          </summary>
          <pre class="text-xs bg-elevated/30 rounded p-2 mt-1 overflow-auto whitespace-pre-wrap">{{ JSON.stringify(input, null, 2) }}</pre>
        </details>
      </template>
    </div>
  </UChatTool>
</template>

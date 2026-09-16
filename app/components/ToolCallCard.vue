<script setup lang="ts">
import type { ToolCallView } from '~/utils/agentTranscript'

const props = defineProps<{ tool: ToolCallView }>()

const open = ref(false)

const icon = computed(() => TOOL_KIND_ICONS[props.tool.kind] ?? TOOL_KIND_ICONS.other!)
const status = computed(() => TOOL_STATUS_META[props.tool.status] ?? TOOL_STATUS_META.pending!)

const diffs = computed(() =>
  (props.tool.content ?? []).filter((part: any) => part?.type === 'diff')
)

const textOutput = computed(() =>
  (props.tool.content ?? [])
    .filter((part: any) => part?.type === 'content' && part.content?.type === 'text')
    .map((part: any) => part.content.text)
    .join('\n\n')
)

const terminals = computed(() =>
  (props.tool.content ?? []).filter((part: any) => part?.type === 'terminal')
)

const command = computed(() => {
  const input = props.tool.rawInput
  if (!input || typeof input !== 'object') return null
  return input.command ?? input.cmd ?? null
})

const hasDetail = computed(() =>
  !!(diffs.value.length || textOutput.value || terminals.value.length || props.tool.rawInput || props.tool.rawOutput)
)
</script>

<template>
  <div class="rounded-lg border border-default bg-elevated/30">
    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-start"
      :class="hasDetail ? 'cursor-pointer hover:bg-elevated/60' : 'cursor-default'"
      @click="hasDetail && (open = !open)"
    >
      <UIcon :name="icon" class="size-4 shrink-0 text-muted" />
      <span class="min-w-0 flex-1 truncate text-sm">
        {{ tool.title }}
        <span v-if="command" class="ms-1 font-mono text-xs text-muted">{{ truncate(String(command), 60) }}</span>
      </span>
      <UBadge
        :color="status.color"
        variant="subtle"
        size="sm"
        :label="status.label"
        :icon="tool.status === 'in_progress' ? 'i-lucide-loader-circle' : undefined"
        :ui="{ leadingIcon: tool.status === 'in_progress' ? 'animate-spin' : '' }"
      />
      <UIcon
        v-if="hasDetail"
        name="i-lucide-chevron-down"
        class="size-4 shrink-0 text-dimmed transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <div v-if="open && hasDetail" class="space-y-3 border-t border-default px-3 py-3">
      <div v-if="tool.locations?.length" class="flex flex-wrap gap-1.5">
        <UBadge
          v-for="location in tool.locations"
          :key="location.path"
          color="neutral"
          variant="outline"
          size="sm"
          class="font-mono"
          :label="location.line ? `${shortPath(location.path, 3)}:${location.line}` : shortPath(location.path, 3)"
        />
      </div>

      <DiffView
        v-for="(diff, index) in diffs"
        :key="index"
        :path="diff.path"
        :old-text="diff.oldText"
        :new-text="diff.newText"
      />

      <div v-if="terminals.length" class="text-xs text-muted">
        Ran in terminal {{ terminals.map((terminal: any) => terminal.terminalId).join(', ') }}
      </div>

      <div v-if="textOutput" class="max-h-72 overflow-auto rounded-lg bg-default p-2">
        <MarkdownView :text="textOutput" />
      </div>

      <UCollapsible v-if="tool.rawInput">
        <UButton
          label="Input"
          color="neutral"
          variant="link"
          size="xs"
          trailing-icon="i-lucide-chevron-down"
          class="px-0"
        />
        <template #content>
          <pre class="mt-1 max-h-60 overflow-auto rounded bg-default p-2 font-mono text-[11px] text-muted">{{ JSON.stringify(tool.rawInput, null, 2) }}</pre>
        </template>
      </UCollapsible>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolCallView } from '~/utils/agentTranscript'

const props = defineProps<{ tool: ToolCallView }>()

const open = ref(false)

const names = useDomoNames()
/** A call to one of Domo's own tools says what it did in words, not as JSON. */
const domo = computed(() => domoCall(props.tool))
const described = computed(() => (domo.value ? describeDomoCall(domo.value, names) : null))
const domoResult = computed(() => {
  const result = domo.value?.result
  if (result == null) return null
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
})

const icon = computed(() => described.value?.icon ?? TOOL_KIND_ICONS[props.tool.kind] ?? TOOL_KIND_ICONS.other!)

const children = computed(() => props.tool.children ?? [])

// An `Agent` call that launched its subagent in the background is done the
// moment it launches; the subagent is still working while its calls are.
const shownStatus = computed(() =>
  children.value.some(child => child.status === 'pending' || child.status === 'in_progress')
    ? 'in_progress'
    : props.tool.status
)
const status = computed(() => TOOL_STATUS_META[shownStatus.value] ?? TOOL_STATUS_META.pending!)

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
  if (domo.value) return null
  const input = props.tool.rawInput
  if (!input || typeof input !== 'object') return null
  return input.command ?? input.cmd ?? null
})

const hasDetail = computed(() =>
  !!(children.value.length || diffs.value.length || textOutput.value || terminals.value.length || props.tool.rawInput || props.tool.rawOutput)
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
      <ActionLine
        v-if="described"
        :action="described.action"
        :subject="described.subject"
        :detail="described.detail"
        :outcome="described.outcome"
        data-testid="domo-tool"
      />
      <span v-else class="min-w-0 flex-1 truncate text-sm">
        {{ tool.title }}
        <span v-if="command" class="ms-1 font-mono text-xs text-muted">{{ truncate(String(command), 60) }}</span>
        <span v-if="children.length" class="ms-1 text-xs text-muted">· {{ children.length }} tool call{{ children.length === 1 ? '' : 's' }}</span>
      </span>
      <UBadge
        :color="status.color"
        variant="subtle"
        size="sm"
        :label="status.label"
        :icon="shownStatus === 'in_progress' ? 'i-lucide-loader-circle' : undefined"
        :ui="{ leadingIcon: shownStatus === 'in_progress' ? 'animate-spin' : '' }"
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

      <div v-if="children.length" class="space-y-2 border-s-2 border-accented ps-3">
        <ToolCallCard
          v-for="child in children"
          :key="child.toolCallId"
          :tool="child"
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

      <pre v-if="domoResult" class="max-h-72 overflow-auto rounded-lg bg-default p-2 font-mono text-[11px] text-muted">{{ domoResult }}</pre>

      <div v-else-if="textOutput" class="max-h-72 overflow-auto rounded-lg bg-default p-2">
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

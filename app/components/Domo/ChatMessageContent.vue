<script setup lang="ts">
/**
 * Renders one message's parts — same pattern as the chat template's
 * `MessageContent.vue`, but switching on the part `type` string (the `ai`
 * package is a types-only devDep; we never import its runtime guards).
 * Our projector emits standard AI SDK parts: `text`, `reasoning`,
 * `dynamic-tool`. Narrowing is done here so the template stays cast-free
 * (vue-tsc rejects inline `as` casts with type literals in bindings).
 */
import type { UIMessage } from 'ai'

const props = defineProps<{ message: UIMessage }>()

interface ToolPart {
  toolName: string
  toolCallId: string
  state: string
  input?: Record<string, unknown>
  output?: unknown
  errorText?: string
}
type Rendered =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: ToolPart }

const isUser = computed(() => props.message.role === 'user')

// Mid-turn steer messages (Decided #18) carry metadata; show whether the
// running agent has picked it up yet (queued) or has (delivered).
const steer = computed<{ steer?: boolean; delivered?: boolean } | null>(() => {
  const m = props.message.metadata
  return m && typeof m === 'object' && 'steer' in m
    ? (m as { steer?: boolean; delivered?: boolean })
    : null
})

const rendered = computed<Rendered[]>(() => {
  const out: Rendered[] = []
  for (const part of props.message.parts) {
    if (part.type === 'text') {
      out.push({ kind: 'text', text: part.text })
    } else if (part.type === 'reasoning') {
      out.push({ kind: 'reasoning', text: part.text })
    } else if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      out.push({ kind: 'tool', tool: part as unknown as ToolPart })
    }
  }
  return out
})
</script>

<template>
  <UBadge
    v-if="steer?.steer"
    :color="steer.delivered ? 'success' : 'neutral'"
    :icon="steer.delivered ? 'i-lucide-check' : 'i-lucide-clock'"
    variant="subtle"
    size="sm"
    class="mb-1"
  >
    {{ steer.delivered ? 'Steered into the turn' : 'Queued — agent will pick this up' }}
  </UBadge>

  <template
    v-for="(part, index) in rendered"
    :key="`${message.id}-${index}`"
  >
    <UChatReasoning
      v-if="part.kind === 'reasoning'"
      :text="part.text"
      chevron="leading"
    >
      <DomoComark :markdown="part.text" />
    </UChatReasoning>

    <DomoChatToolCard
      v-else-if="part.kind === 'tool'"
      :part="part.tool"
    />

    <template v-else>
      <p v-if="isUser" class="whitespace-pre-wrap text-sm">
        {{ part.text }}
      </p>
      <DomoComark v-else :markdown="part.text" />
    </template>
  </template>
</template>

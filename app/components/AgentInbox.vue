<script setup lang="ts">
import type { AgentInboxMessage } from '~~/shared/types'

/**
 * What is queued for an agent that is still working.
 *
 * The queue is Domo's, not the adapter's, so it can be shown and taken back.
 * An adapter's own queue — which is what a second `session/prompt` lands in —
 * is invisible and does not survive a restart.
 */
const props = defineProps<{ agentSessionId: string, messages: AgentInboxMessage[] }>()

const toast = useToast()
const removing = ref<string | null>(null)

function preview(message: AgentInboxMessage): string {
  const text = (message.content ?? [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('\n')
    .trim()
  return text || '(attachments only)'
}

/** `agent:<id>` names the peer that sent it; the rest are plain words. */
function sender(origin: string): string {
  if (origin.startsWith('agent:')) return 'From another agent'
  if (origin.startsWith('cron:')) return 'From a schedule'
  if (origin === 'voice') return 'From Domo'
  if (origin === 'system') return 'From Domo'
  return 'From you'
}

async function remove(message: AgentInboxMessage) {
  removing.value = message.id
  try {
    await $fetch(`/api/agents/${props.agentSessionId}/inbox/${message.id}`, { method: 'DELETE' })
  } catch (error: any) {
    toast.add({
      title: 'Could not remove it',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl">
    <UCollapsible :default-open="messages.length <= 3">
      <UButton
        color="neutral"
        variant="subtle"
        size="sm"
        block
        icon="i-lucide-inbox"
        trailing-icon="i-lucide-chevron-down"
        :label="`${messages.length} queued`"
        :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
      />

      <template #content>
        <div class="mt-2 max-h-[28vh] space-y-1.5 overflow-y-auto">
          <div
            v-for="message in messages"
            :key="message.id"
            class="flex items-start gap-2 rounded-md border border-default px-3 py-2"
          >
            <div class="min-w-0 flex-1">
              <p class="text-xs text-dimmed">
                {{ sender(message.origin) }} · {{ relativeTime(message.createdAt) }}
              </p>
              <p class="mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap">
                {{ preview(message) }}
              </p>
            </div>
            <UTooltip text="Remove from the queue">
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                :loading="removing === message.id"
                @click="remove(message)"
              />
            </UTooltip>
          </div>
        </div>
      </template>
    </UCollapsible>
  </div>
</template>

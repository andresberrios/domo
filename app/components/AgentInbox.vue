<script setup lang="ts">
import type { AgentInboxMessage, AgentSession, QueuedDeliveryResult } from '~~/shared/types'

/**
 * What is queued for an agent that is still working.
 *
 * The queue is Domo's, not the adapter's, so it can be shown and taken back.
 * An adapter's own queue — which is what a second `session/prompt` lands in —
 * is invisible and does not survive a restart.
 */
const props = withDefaults(defineProps<{
  agentSessionId: string
  messages: AgentInboxMessage[]
  /**
   * A retired session's queue is a record of what was waiting when it ended, so
   * it is still worth showing — but nothing may be taken back out of it, and a
   * button that only ever errored would be worse than no button.
   */
  readonly?: boolean
  /** The session they wait for: whether it is working, and whether it can be steered. */
  session?: AgentSession | null
}>(), { readonly: false, session: null })

const toast = useToast()
const removing = ref<string | null>(null)
const open = ref(props.messages.length <= 3)

/* --------------------------- send queued now --------------------------- */

const busy = computed(() => props.session?.status === 'thinking' || props.session?.status === 'awaiting-permission')
/** `steering` is read off the row, as the composer does; null is "never measured", not "cannot". */
const steers = computed(() => props.session?.steering !== false)

/**
 * What "Send now" does with a turn running: the two modes of a message that
 * means "now" (`message_agent`'s), applied to what is queued. With no turn
 * there is nothing to choose: they go as the next turn, as the drain sends
 * them, so the button has no dropdown then.
 */
const sendModes = computed(() => [
  {
    value: 'steer' as const,
    label: 'Steer',
    icon: 'i-lucide-git-branch',
    description: steers.value
      ? 'Put them into the turn it is running now, in order'
      : 'This agent cannot take a message mid-turn — it stops the current turn instead'
  },
  { value: 'interrupt' as const, label: 'Interrupt', icon: 'i-lucide-octagon-x', description: 'Stop the current turn, then send them as the next one' }
])
const sendMode = ref<'steer' | 'interrupt'>('steer')
const sendInfo = computed(() => sendModes.value.find(item => item.value === sendMode.value)!)
const sendItems = computed(() => [
  sendModes.value.map(item => ({
    label: item.label,
    description: item.description,
    icon: item.icon,
    type: 'checkbox' as const,
    checked: item.value === sendMode.value,
    onUpdateChecked: () => { sendMode.value = item.value }
  }))
])
const sendTip = computed(() => busy.value
  ? `Send them now — ${sendInfo.value.description.toLowerCase()}`
  : 'Send them now, as the next turn')

const sending = ref(false)

/**
 * The server sends them oldest first and stops at the first one the agent
 * does not take (the turn ended under it, or the adapter refused); those stay
 * here, in their places, and go when the turn ends. Only that case needs
 * words: everything that went is in the transcript.
 */
async function sendNow() {
  if (!props.session) return
  sending.value = true
  try {
    const result = await $fetch<QueuedDeliveryResult>(`/api/agents/${props.session.id}/inbox/deliver`, {
      method: 'POST',
      body: { delivery: sendMode.value }
    })
    if (result.waiting && result.delivered) {
      toast.add({
        title: `${result.delivered} joined the turn; ${result.waiting} still queued`,
        description: 'The agent stopped taking messages mid-turn. The rest go when this turn ends.',
        color: 'neutral'
      })
    } else if (result.waiting) {
      toast.add({
        title: 'Still queued',
        description: 'The turn was ending, so they go next, as soon as it has.',
        color: 'neutral'
      })
    }
  } catch (error: any) {
    toast.add({
      title: 'Could not send them',
      description: error?.data?.statusMessage ?? error?.data?.message ?? error?.message,
      color: 'error'
    })
  } finally {
    sending.value = false
  }
}

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
    <div class="flex items-center gap-1.5">
      <UButton
        color="neutral"
        variant="subtle"
        size="sm"
        block
        class="min-w-0 flex-1"
        icon="i-lucide-inbox"
        trailing-icon="i-lucide-chevron-down"
        :label="readonly ? `${messages.length} never delivered` : `${messages.length} queued`"
        :aria-expanded="open"
        :ui="{ trailingIcon: ['transition-transform', open ? 'rotate-180' : ''] }"
        @click="open = !open"
      />
      <UFieldGroup v-if="!readonly && session" size="sm" class="shrink-0">
        <UTooltip :text="sendTip">
          <UButton
            :icon="busy ? sendInfo.icon : 'i-lucide-send'"
            label="Send now"
            color="neutral"
            variant="subtle"
            :loading="sending"
            @click="sendNow"
          />
        </UTooltip>
        <UDropdownMenu v-if="busy" :items="sendItems" :content="{ side: 'top', align: 'end' }">
          <UTooltip text="How they go into a running turn">
            <UButton
              icon="i-lucide-chevron-up"
              color="neutral"
              variant="subtle"
              :aria-label="`Send now as: ${sendInfo.label}`"
            />
          </UTooltip>
        </UDropdownMenu>
      </UFieldGroup>
    </div>

    <UCollapsible v-model:open="open">
      <template #content>
        <MotionList tag="div" class="mt-2 max-h-[28vh] space-y-1.5 overflow-y-auto">
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
            <UTooltip v-if="!readonly" text="Remove from the queue">
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
        </MotionList>
      </template>
    </UCollapsible>
  </div>
</template>

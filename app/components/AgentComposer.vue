<script setup lang="ts">
import type { AgentSession, MessageDelivery } from '~~/shared/types'

const props = defineProps<{ session: AgentSession }>()

const toast = useToast()
const text = ref('')
const sending = ref(false)

/**
 * On a phone the on-screen keyboard's return key is the only way to type a line
 * break, so Enter must not send: the button does. Desktop keeps Enter to send
 * and Shift+Enter to break, which is what `UChatPrompt` does by default.
 */
const isTouch = useIsTouch()

/**
 * What happens to a message sent while the agent is mid-turn.
 *
 * `steer` is preselected because that is what typing at a working agent
 * normally means. It is a property of *this message* rather than of the
 * session — which is why it is not in the settings panel with the model and
 * the mode — so it hangs off the send button, the control it modifies. With
 * nothing running all three mean the same thing (a prompt), so the button has
 * no dropdown at all until there is a turn to choose about, and the
 * placeholder says in words what the chosen one will do.
 */
const DELIVERY_ITEMS = [
  { value: 'steer' as const, label: 'Steer', icon: 'i-lucide-git-branch', description: 'Put it into the turn it is running now' },
  { value: 'queue' as const, label: 'Queue', icon: 'i-lucide-inbox', description: 'Wait for the current turn to finish' },
  { value: 'interrupt' as const, label: 'Interrupt', icon: 'i-lucide-octagon-x', description: 'Stop the current turn first' }
]
const delivery = ref<MessageDelivery>('steer')
const deliveryInfo = computed(() => DELIVERY_ITEMS.find(item => item.value === delivery.value)!)

/**
 * One checked item rather than a radio group, because `UDropdownMenu` has no
 * radio type; unchecking the checked one re-selects it, which is the only
 * sensible reading of "none of the three".
 */
const deliveryItems = computed(() => [
  DELIVERY_ITEMS.map(item => ({
    label: item.label,
    description: item.description,
    icon: item.icon,
    type: 'checkbox' as const,
    checked: item.value === delivery.value,
    onUpdateChecked: () => { delivery.value = item.value }
  }))
])
const attachments = ref<Array<{ name: string, path: string, mimeType: string, size: number }>>([])
const fileInput = ref<HTMLInputElement | null>(null)

/**
 * Uploads are counted rather than flagged, and they chain: a paste while an
 * earlier one is still in flight is normal, and a submit in the gap has to
 * wait for both rather than send the message without its attachments.
 */
const uploads = ref(0)
const uploading = computed(() => uploads.value > 0)
let inflight: Promise<void> = Promise.resolve()

const busy = computed(() => props.session.status === 'thinking' || props.session.status === 'starting')
const status = computed(() => (busy.value ? ('streaming' as const) : ('ready' as const)))

const placeholder = computed(() => {
  if (!busy.value) return 'Message this agent…'
  if (delivery.value === 'queue') return 'The agent is working — this waits for its turn to end…'
  if (delivery.value === 'interrupt') return 'The agent is working — this stops it first…'
  return 'The agent is working — this goes into the turn it is running…'
})

/** Never rejects: a failed upload is a toast, not something a caller handles. */
async function upload(files: File[]) {
  try {
    const form = new FormData()
    // The third argument is the filename the server sees, which is the only
    // way a clipboard file with no name of its own gets one.
    for (const file of files) form.append('files', file, uploadName(file))
    const result = await $fetch<{ files: typeof attachments.value }>('/api/uploads', {
      method: 'POST',
      body: form
    })
    attachments.value = [...attachments.value, ...result.files]
  } catch (error: any) {
    toast.add({ title: 'Upload failed', description: error?.message, color: 'error' })
  }
}

function attach(files: File[]) {
  if (!files.length) return
  uploads.value += 1
  inflight = inflight
    .then(() => upload(files))
    .finally(() => { uploads.value -= 1 })
}

function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  attach(Array.from(input.files))
  input.value = ''
}

/**
 * A screenshot or a copied file goes straight in as an attachment; anything
 * the clipboard also has text for is left to the textarea, which is every
 * ordinary paste.
 */
function onPaste(event: ClipboardEvent) {
  const files = pastedFiles(event.clipboardData)
  if (!files.length) return
  event.preventDefault()
  attach(files)
}

function removeAttachment(path: string) {
  attachments.value = attachments.value.filter(attachment => attachment.path !== path)
}

/**
 * `UChatPrompt` refuses to emit `submit` while its textarea is empty, so a
 * message that is *only* an attachment — which is what pasting a screenshot
 * and pressing Enter produces — could never leave. Both of its send paths are
 * caught in the capture phase instead, and only in the case it drops.
 */
function attachmentOnly() {
  return !text.value.trim() && (attachments.value.length > 0 || uploading.value)
}

/** Whether there is anything to send — text, an attachment, or one arriving. */
const canSend = computed(() =>
  Boolean(text.value.trim()) || attachments.value.length > 0 || uploading.value
)

function onSubmitCapture(event: Event) {
  if (!attachmentOnly()) return
  event.preventDefault()
  event.stopPropagation()
  void submit()
}

function onKeydownCapture(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing) return
  if ((event.target as HTMLElement | null)?.tagName !== 'TEXTAREA') return
  // The same rule `UChatPrompt` applies, since this stands in for it: Enter
  // sends unless the prompt is in touch mode, where a modifier is needed.
  const sends = isTouch.value
    ? event.ctrlKey || event.metaKey
    : !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  if (!sends || !attachmentOnly()) return
  event.preventDefault()
  event.stopPropagation()
  void submit()
}

async function submit() {
  const body = text.value.trim()
  if (!body && !attachments.value.length && !uploading.value) return

  sending.value = true
  // Enter right after a paste is the normal way to send a screenshot, so the
  // message waits for the upload rather than leaving it behind.
  if (uploading.value) await inflight
  if (!body && !attachments.value.length) {
    sending.value = false
    return
  }
  try {
    const content: any[] = []
    for (const attachment of attachments.value) {
      content.push({
        type: 'resource_link',
        uri: `file://${attachment.path}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size
      })
    }
    if (body) content.push({ type: 'text', text: body })

    await $fetch(`/api/agents/${props.session.id}/prompt`, {
      method: 'POST',
      body: { content, delivery: delivery.value }
    })
    text.value = ''
    attachments.value = []
  } catch (error: any) {
    toast.add({
      title: 'Could not send',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    sending.value = false
  }
}

async function stop() {
  try {
    await $fetch(`/api/agents/${props.session.id}/cancel`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: 'Could not stop', description: error?.message, color: 'error' })
  }
}
</script>

<template>
  <div
    class="mx-auto w-full max-w-3xl space-y-2"
    @keydown.capture="onKeydownCapture"
    @submit.capture="onSubmitCapture"
  >
    <div v-if="attachments.length || uploading" class="flex flex-wrap gap-1.5">
      <UBadge
        v-for="attachment in attachments"
        :key="attachment.path"
        color="neutral"
        variant="subtle"
        size="md"
        class="gap-1"
      >
        <UIcon name="i-lucide-paperclip" class="size-3" />
        {{ attachment.name }}
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="link"
          size="xs"
          class="-me-1 p-0"
          @click="removeAttachment(attachment.path)"
        />
      </UBadge>

      <UBadge v-if="uploading" color="neutral" variant="subtle" size="md" class="gap-1">
        <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
        Attaching…
      </UBadge>
    </div>

    <UChatPrompt
      v-model="text"
      :placeholder="placeholder"
      :autoresize="true"
      :maxrows="10"
      :submit-on-enter="!isTouch"
      variant="outline"
      @submit="submit"
      @paste="onPaste"
    >
      <template #footer>
        <div class="flex w-full items-start justify-between gap-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <UTooltip text="Attach files — or paste them in">
              <UButton
                icon="i-lucide-paperclip"
                color="neutral"
                variant="ghost"
                size="sm"
                :loading="uploading"
                @click="fileInput?.click()"
              />
            </UTooltip>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden"
              @change="onFiles"
            >

            <!--
              The mode, the model and the adapter's own settings, as one card
              that opens a panel; see AgentComposerSettings.
            -->
            <AgentComposerSettings :session="session" />

            <span class="hidden min-w-0 truncate text-xs text-dimmed lg:inline">
              {{ shortPath(session.cwd, 3) }}
            </span>
          </div>

          <div class="flex items-center gap-1">
            <!--
              While the agent works, `UChatPromptSubmit` is a stop button and
              nothing else, so on a touch screen — where Enter deliberately
              types a line break — there was no way to send at all. Steering a
              running turn is the normal thing to do here, so it gets its own
              button rather than a rule about which key to press — and the
              delivery mode hangs off that button as a split control, because
              it is a choice about the message this button is about to send.
            -->
            <UFieldGroup v-if="busy">
              <UTooltip :text="`Send — ${deliveryInfo.description.toLowerCase()}`">
                <UButton
                  icon="i-lucide-arrow-up"
                  color="neutral"
                  size="md"
                  aria-label="Send"
                  :loading="sending"
                  :disabled="!canSend"
                  @click="submit"
                />
              </UTooltip>
              <UDropdownMenu :items="deliveryItems" :content="{ side: 'top', align: 'end' }">
                <UTooltip text="What happens to this message mid-turn">
                  <UButton
                    icon="i-lucide-chevron-up"
                    color="neutral"
                    size="md"
                    :aria-label="`Delivery: ${deliveryInfo.label}`"
                  />
                </UTooltip>
              </UDropdownMenu>
            </UFieldGroup>
            <UChatPromptSubmit
              :status="status"
              :loading="sending"
              @stop="stop"
              @reload="submit"
            />
          </div>
        </div>
      </template>
    </UChatPrompt>
  </div>
</template>

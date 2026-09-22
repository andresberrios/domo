<script setup lang="ts">
import type { AgentSession, MessageDelivery, SessionConfigOptionInfo } from '~~/shared/types'

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

/* ---------------- what this session is running on ---------------- */

/**
 * The permission mode, the model and whatever else the adapter offers all live
 * here rather than in the page header. They are decisions about the message
 * being written — "plan this one", "switch to Opus for this bit", "think
 * harder about this" — and the composer is where that decision is made and
 * where the answer is about to be sent. All of them go through the one
 * `PATCH /api/agents/[id]`, which reaches the running adapter.
 *
 * Nothing here holds the chosen value: every picker reads the session row, so
 * a change that the adapter refuses reverts on its own, and a change made from
 * the voice agent or another browser arrives through Electric like any other.
 */
const applying = ref<string | null>(null)

async function apply(body: Record<string, unknown>, key: string, failure: string) {
  applying.value = key
  try {
    await $fetch(`/api/agents/${props.session.id}`, { method: 'PATCH', body })
  } catch (error: any) {
    toast.add({ title: failure, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    applying.value = null
  }
}

const modeItems = computed(() =>
  (props.session.modes ?? []).map(mode => ({ label: mode.name, value: mode.id }))
)

const currentMode = computed({
  get: () => props.session.modeId ?? '',
  set: (value: string) => { void apply({ modeId: value }, 'mode', 'Could not change the mode') }
})

/**
 * The model list is the one thing not already on the row: an adapter only
 * reports it in a `session/new` response, so the server answers this by
 * spawning a throwaway probe (cached an hour). Hence `immediate: false` and a
 * fetch on first open — opening an agent page must not cost an adapter spawn.
 */
const { data: modelData, status: modelStatus, refresh: refreshModels } = await useFetch<{
  models: Array<{ id: string, name: string }>
}>('/api/adapters/models', {
  query: computed(() => ({ adapter: props.session.adapter })),
  immediate: false,
  lazy: true,
  watch: false
})

let probed = false
function probeModels(open: boolean) {
  if (!open || probed) return
  probed = true
  void refreshModels()
}

const modelItems = computed(() => {
  const items = (modelData.value?.models ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  // Whatever the session is actually on goes in even before the probe answers:
  // a menu whose selected value is not among its own items renders blank.
  const current = props.session.model
  if (current && !items.some(item => item.value === current)) items.unshift({ label: current, value: current })
  return items
})

const currentModel = computed({
  get: () => props.session.model ?? '',
  set: (value: string) => { void apply({ model: value }, 'model', 'Could not change the model') }
})

/**
 * The adapter's own settings: reasoning effort, and whatever else it ships.
 *
 * Read off the row and never hard-coded, because the two adapters do not agree
 * on any of it — Claude Code calls effort `effort` and Codex
 * `reasoning_effort`, Codex has a collaboration mode Claude has never heard
 * of, and both publish these *per model*, so the list changes when the model
 * above it does. The row is rewritten from the adapter's own answer on every
 * change, so this follows along on its own.
 */
const configOptions = computed(() => props.session.configOptions ?? [])

function configValue(option: SessionConfigOptionInfo): string {
  return props.session.config?.[option.id] ?? option.currentValue ?? ''
}

function configItems(option: SessionConfigOptionInfo) {
  return option.options.map(entry => ({ label: entry.name, value: entry.value }))
}

function setConfigValue(option: SessionConfigOptionInfo, value: string) {
  void apply({ config: { [option.id]: value } }, option.id, `Could not change ${option.name.toLowerCase()}`)
}

/** ACP's own category is the only hint available, and only some of it is known. */
function configIcon(option: SessionConfigOptionInfo): string {
  return option.category === 'thought_level' ? 'i-lucide-brain' : 'i-lucide-sliders-horizontal'
}

/**
 * What happens to a message sent while the agent is mid-turn.
 *
 * `steer` is preselected because that is what typing at a working agent
 * normally means; it only matters while something is running, so the picker is
 * hidden the rest of the time.
 */
const DELIVERY_ITEMS = [
  { value: 'steer' as const, label: 'Steer', icon: 'i-lucide-git-branch', description: 'Put it into the turn it is running now' },
  { value: 'queue' as const, label: 'Queue', icon: 'i-lucide-inbox', description: 'Wait for the current turn to finish' },
  { value: 'interrupt' as const, label: 'Interrupt', icon: 'i-lucide-octagon-x', description: 'Stop the current turn first' }
]
const delivery = ref<MessageDelivery>('steer')
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
        <!--
          The pickers wrap rather than shrink: there may be four of them on a
          Codex session (mode, model, reasoning effort, collaboration mode) and
          a phone has no room for that in one row. The submit button stays
          outside the wrapping group so it never moves.
        -->
        <div class="flex w-full items-start justify-between gap-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
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

            <UTooltip v-if="modeItems.length" text="Permission mode">
              <USelectMenu
                v-model="currentMode"
                :items="modeItems"
                value-key="value"
                size="xs"
                variant="ghost"
                icon="i-lucide-shield"
                :loading="applying === 'mode'"
                class="w-32"
              />
            </UTooltip>

            <UTooltip text="Model">
              <USelectMenu
                v-model="currentModel"
                :items="modelItems"
                value-key="value"
                size="xs"
                variant="ghost"
                icon="i-lucide-cpu"
                placeholder="Model"
                :loading="applying === 'model' || modelStatus === 'pending'"
                class="w-32"
                @update:open="probeModels"
              />
            </UTooltip>

            <!-- Whatever this adapter offers on this model; see the script. -->
            <UTooltip
              v-for="option in configOptions"
              :key="option.id"
              :text="option.description || option.name"
            >
              <USelectMenu
                :model-value="configValue(option)"
                :items="configItems(option)"
                value-key="value"
                size="xs"
                variant="ghost"
                :icon="configIcon(option)"
                :placeholder="option.name"
                :loading="applying === option.id"
                class="w-32"
                @update:model-value="value => setConfigValue(option, value as string)"
              />
            </UTooltip>

            <span v-if="!busy" class="hidden text-xs text-dimmed lg:inline">
              {{ shortPath(session.cwd, 3) }}
            </span>
            <USelectMenu
              v-else
              v-model="delivery"
              :items="DELIVERY_ITEMS"
              value-key="value"
              size="xs"
              variant="ghost"
              class="w-32"
            />
          </div>

          <div class="flex items-center gap-1">
            <!--
              While the agent works, `UChatPromptSubmit` is a stop button and
              nothing else, so on a touch screen — where Enter deliberately
              types a line break — there was no way to send at all. Steering a
              running turn is the normal thing to do here, so it gets its own
              button rather than a rule about which key to press.
            -->
            <UTooltip v-if="busy" text="Send">
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

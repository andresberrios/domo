<script setup lang="ts">
import { effectScope, type EffectScope } from 'vue'
import type { AgentDraft, AgentSession, MessageDelivery } from '~~/shared/types'
import type { AgentVoice } from '~/composables/useAgentVoice'

const props = defineProps<{
  /** `null` on the new-session page, where there is no session until this sends. */
  session: AgentSession | null
  /**
   * What sending does on a draft: create the session with this as its first
   * message. Resolves false when that failed, and the message comes back into
   * the box to be sent again.
   */
  start?: (content: any[]) => Promise<boolean>
}>()
/** The draft's settings, for the card beside the attach button; see AgentComposerSettings. */
const draft = defineModel<AgentDraft | null>('draft', { default: null })

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
 * Whether a `steer` on this session really steers.
 *
 * `steer` on an adapter that does not advertise the extension falls back to
 * `interrupt` — the intent is "change course now", and waiting is the one
 * thing it definitely does not mean — so on such a session the option is still
 * the right default and still does the right thing, it just does it bluntly.
 * Saying so is the whole point: the label used to promise an injection into
 * the running turn and OpenCode would cancel the turn instead, which is a
 * surprise rather than a choice.
 *
 * The row is read, never a probe: `agent_sessions.steering` is written on every
 * attach, so this costs nothing and — the part that matters — cannot start an
 * adapter. `null` means nothing has ever attached, and an unmeasured session is
 * not claimed to be either one.
 */
const steers = computed(() => props.session?.steering !== false)

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
 *
 * A computed rather than a constant because Steer's description depends on the
 * session — see `steers`.
 */
const deliveryModes = computed(() => [
  {
    value: 'steer' as const,
    label: 'Steer',
    icon: 'i-lucide-git-branch',
    description: steers.value
      ? 'Put it into the turn it is running now'
      : 'This agent cannot take a message mid-turn — it stops the current turn instead'
  },
  { value: 'queue' as const, label: 'Queue', icon: 'i-lucide-inbox', description: 'Wait for the current turn to finish' },
  { value: 'interrupt' as const, label: 'Interrupt', icon: 'i-lucide-octagon-x', description: 'Stop the current turn first' }
])
const delivery = ref<MessageDelivery>('steer')
const deliveryInfo = computed(() => deliveryModes.value.find(item => item.value === delivery.value)!)

/**
 * One checked item rather than a radio group, because `UDropdownMenu` has no
 * radio type; unchecking the checked one re-selects it, which is the only
 * sensible reading of "none of the three".
 */
const deliveryItems = computed(() => [
  deliveryModes.value.map(item => ({
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
 * What is typed and not sent is kept per session, so leaving for another page
 * and coming back — or reloading — finds it where it was. It is forgotten only
 * when the send has gone through: the composer keeps the text through a
 * session's send, and a draft's first message, which leaves the box at once,
 * is held back from storage until the session exists (`holding`).
 */
const draftKey = computed(() => props.session?.id ?? 'new')
let holding = false

function persist() {
  if (!holding) writeComposerDraft(draftKey.value, { text: text.value, attachments: attachments.value })
}

watch([text, attachments], persist, { deep: true })

/**
 * The key changes under a mounted composer only when the conversation carries
 * on in another session: a draft becoming its session, or an assistant handing
 * off — every other move between sessions builds the page again. What was
 * typed goes along, and the old slot is emptied.
 */
watch(draftKey, (_current, previous) => {
  writeComposerDraft(previous, { text: '', attachments: [] })
  persist()
})

const prompt = ref<{ textareaRef?: HTMLTextAreaElement | null } | null>(null)

onMounted(() => {
  const saved = readComposerDraft(draftKey.value)
  if (!saved) return
  text.value = saved.text
  attachments.value = saved.attachments
  // The cursor goes after what was there, as if the typing had never stopped.
  nextTick(() => {
    const textarea = prompt.value?.textareaRef
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
  })
})

/**
 * Uploads are counted rather than flagged, and they chain: a paste while an
 * earlier one is still in flight is normal, and a submit in the gap has to
 * wait for both rather than send the message without its attachments.
 */
const uploads = ref(0)
const uploading = computed(() => uploads.value > 0)
let inflight: Promise<void> = Promise.resolve()

const busy = computed(() => props.session?.status === 'thinking' || props.session?.status === 'starting')
const status = computed(() => (busy.value ? ('streaming' as const) : ('ready' as const)))

const placeholder = computed(() => {
  if (!props.session) return 'What should it do? Sending this starts the session…'
  if (!busy.value) return 'Message this agent…'
  // One line on a phone: a placeholder that wraps is cut off by the box, which
  // keeps its height. The send button's tooltip has the longer version.
  if (delivery.value === 'queue') return 'Waits for this turn to end…'
  if (delivery.value === 'interrupt') return 'Stops the turn, then sends…'
  if (!steers.value) return 'Can’t steer — this stops the turn…'
  return 'Joins the turn it is running…'
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
    toast.add({ title: 'Upload failed', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
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

/** The attachments as `MessageAttachments` reads a sent message's. */
const attachmentViews = computed(() => attachments.value.map(attachment => ({
  name: attachment.name,
  uri: `file://${attachment.path}`,
  mimeType: attachment.mimeType
})))

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
  onGesture()
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
  if (!props.session) return startSession()

  sending.value = true
  // Enter right after a paste is the normal way to send a screenshot, so the
  // message waits for the upload rather than leaving it behind.
  if (uploading.value) await inflight
  if (!body && !attachments.value.length) {
    sending.value = false
    return
  }
  try {
    const content = messageContent(body, attachments.value)
    const key = draftKey.value

    await $fetch(`/api/agents/${props.session.id}/prompt`, {
      method: 'POST',
      body: { content, delivery: delivery.value }
    })
    text.value = ''
    attachments.value = []
    voice.value?.expectReply()
    // Written here, not left to the watcher: a page left mid-send has stopped watching.
    writeComposerDraft(key, { text: '', attachments: [] })
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

/**
 * The first message of a session that does not exist yet. It leaves the box at
 * once, as any sent message does — the page shows it in the transcript while
 * the session is made — and comes back if that failed, so nothing typed is
 * lost. One at a time: a second Enter while the first is still out would make
 * a second session.
 */
async function startSession() {
  if (sending.value || !props.start) return
  sending.value = true
  try {
    if (uploading.value) await inflight
    const body = text.value.trim()
    const sent = { text: text.value, attachments: attachments.value }
    if (!body && !sent.attachments.length) return
    holding = true
    text.value = ''
    attachments.value = []
    const started = await props.start(messageContent(body, sent.attachments))
    if (!started) {
      text.value = sent.text
      attachments.value = sent.attachments
    }
    await nextTick()
    holding = false
    // Sent: the draft's slot goes (the key moved on with the session). Not
    // sent: it is written back as it was, with anything typed since.
    if (started) writeComposerDraft('new', { text: '', attachments: [] })
    persist()
  } finally {
    holding = false
    sending.value = false
  }
}

function messageContent(body: string, files: typeof attachments.value): any[] {
  const content: any[] = files.map(attachment => ({
    type: 'resource_link',
    uri: `file://${attachment.path}`,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size
  }))
  if (body) content.push({ type: 'text', text: body })
  return content
}

/* ------------------------------ voice mode ------------------------------ */

/**
 * The composer has two modes, and voice is the one where the text box gives
 * way to the voice bar (`AgentVoiceBar`) while everything around it — the
 * attachments, the settings card, the context gauge — stays. Whether it is on
 * is one answer for every page, kept across reloads (`useAgentVoiceOpen`):
 * someone who talks to their agents does not want to find the microphone
 * every time. The text typed before switching is still in `text`, and comes
 * back with the box.
 *
 * A draft has no session to talk to, so it is always text. And the session a
 * draft becomes stays in text until asked: it was being typed to a moment ago.
 *
 * Hearing the agent is a separate switch (`useAgentVoiceListen`), the speaker
 * in the footer, in both modes: someone typing can want the replies read out
 * and the chimes on. Voice mode turns it on, since talking to something you
 * cannot hear is rarely meant; the speaker can still mute it there.
 */
const voiceOpen = useAgentVoiceOpen()
const listening = useAgentVoiceListen()
const typedHere = ref(!props.session)
const voiceMode = computed(() => !!props.session && voiceOpen.value && !typedHere.value)

function setVoiceMode(on: boolean) {
  typedHere.value = false
  voiceOpen.value = on
  if (on) listening.value = true
  if (!on) nextTick(() => prompt.value?.textareaRef?.focus())
}

function setListening(on: boolean) {
  listening.value = on
  // The tap that turned it on is the gesture the audio needs to start.
  if (on) nextTick(() => void voice.value?.unlock())
}

const { data: appSettings } = useSettings()
const { request: replayRequest } = useAgentVoiceReplay()

/**
 * The socket and the speaker exist while the agent is heard or talked to,
 * and the microphone only once a tap opens it, in a scope of their own: when
 * neither is wanted the scope stops, which closes them all (`useAgentVoice`
 * cleans up on scope dispose). Going between the modes keeps the same one, so
 * nothing reconnects.
 */
const voiceActive = computed(() => !!props.session && (voiceMode.value || listening.value))
const voice = shallowRef<AgentVoice | null>(null)
let voiceScope: EffectScope | null = null

/** What the attachments look like as content blocks; a spoken turn takes them too. */
const attachmentBlocks = computed(() => messageContent('', attachments.value))

watch(voiceActive, (on) => {
  voiceScope?.stop()
  voiceScope = null
  voice.value = null
  if (!on) return
  voiceScope = effectScope()
  voice.value = voiceScope.run(() => {
    const voice = useAgentVoice(() => props.session!.id, {
      busy: () => props.session?.status === 'thinking' || props.session?.status === 'awaiting-permission',
      toolSound: () => appSettings.value?.agentVoice?.toolSound,
      volumes: () => appSettings.value?.agentVoice?.volumes,
      // Only voice mode sends a spoken turn; typed ones carry their own.
      attachments: () => (voiceMode.value ? attachmentBlocks.value : []),
      onAttachmentsSent: (uris) => {
        attachments.value = attachments.value.filter(attachment => !uris.includes(`file://${attachment.path}`))
      }
    })
    // A message asked to be heard again; listening may have just been turned on for it.
    watch(replayRequest, (request) => {
      if (!request) return
      replayRequest.value = null
      void voice.replay(request.text)
    }, { immediate: true })
    return voice
  })!
  // The socket, not the microphone: a microphone opened here is one opened
  // outside a tap, which iOS leaves suspended. The first tap on the button
  // opens it.
  voice.value.connect()
}, { immediate: true })

onScopeDispose(() => voiceScope?.stop())

/**
 * A browser starts audio only from a gesture, and a page reloaded with
 * listening on has had none yet: any key or tap in the composer is one.
 */
function onGesture() {
  if (voice.value) void voice.value.unlock()
}

/** Typing has nowhere else to say that the voice failed, so it says it here. */
watch(() => voice.value?.errorMessage.value, (message) => {
  if (message && !voiceMode.value) toast.add({ title: 'The agent’s voice', description: message, color: 'error' })
})
watch(() => voice.value?.notice.value, (message) => {
  if (message && !voiceMode.value) toast.add({ title: message, color: 'neutral' })
})

/** A turn to cancel, including one parked on a permission, which is when a person most wants out. */
const turnRunning = computed(() => busy.value || props.session?.status === 'awaiting-permission')

const voiceModes = [
  { value: 'click', label: 'Tap to talk', icon: 'i-lucide-mouse-pointer-click' },
  { value: 'handsfree', label: 'Hands-free', icon: 'i-lucide-radio' }
] as const
const voiceModeInfo = computed(() => voiceModes.find(item => item.value === voice.value?.mode.value) ?? voiceModes[0])
const voiceModeOther = computed(() => voiceModes.find(item => item !== voiceModeInfo.value)!)

async function stop() {
  if (!props.session) return
  try {
    await $fetch(`/api/agents/${props.session.id}/cancel`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: 'Could not stop', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}
</script>

<template>
  <div
    class="mx-auto w-full max-w-3xl space-y-2"
    @keydown.capture="onKeydownCapture"
    @pointerdown.capture="onGesture"
    @submit.capture="onSubmitCapture"
  >
    <MessageAttachments
      v-if="attachments.length || uploading"
      :attachments="attachmentViews"
      removable
      @remove="index => removeAttachment(attachments[index]!.path)"
    >
      <UBadge v-if="uploading" color="neutral" variant="subtle" size="md" class="gap-1">
        <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
        Attaching…
      </UBadge>
    </MessageAttachments>

    <UChatPrompt
      ref="prompt"
      v-model="text"
      :placeholder="placeholder"
      :autoresize="true"
      :maxrows="10"
      :submit-on-enter="!isTouch"
      variant="outline"
      :ui="{ base: 'min-h-10' }"
      @submit="submit"
      @paste="onPaste"
    >
      <!--
        The voice bar is as tall as the text box at rest (`min-h-10` there,
        `h-10` in the bar), so switching modes does not move the transcript.
      -->
      <template v-if="voiceMode && voice" #body>
        <AgentVoiceBar :voice="voice" />
      </template>

      <template #footer>
        <div class="flex w-full items-start justify-between gap-2">
          <!--
            One line whatever the state: the settings card truncates instead
            of wrapping when a turn adds Send and Stop on a phone. A second
            line here took the transcript's height while the agent worked and
            gave it back at the end, moving every row of the view down.
          -->
          <div class="flex min-w-0 flex-1 items-center gap-1.5">
            <UTooltip :text="voiceMode ? 'Attach files. They go with what you say next.' : 'Attach files — or paste them in'">
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
            <AgentComposerSettings v-model:draft="draft" :session="session" />

            <UsageMeter v-if="session" :usage="session.usage ?? null" :provider="usageProviderOf(session.adapter)" />
          </div>

          <div v-if="voiceMode && voice" class="flex shrink-0 items-center gap-1">
            <!-- One button that flips between the two on a phone, where the pair would crowd out the settings card. -->
            <UTooltip :text="`${voiceModeInfo.label} — tap for ${voiceModeOther.label.toLowerCase()}`">
              <UButton
                :icon="voiceModeInfo.icon"
                color="neutral"
                variant="ghost"
                size="sm"
                class="sm:hidden"
                :aria-label="`${voiceModeInfo.label}. Switch to ${voiceModeOther.label.toLowerCase()}`"
                @click="voice.setMode(voiceModeOther.value)"
              />
            </UTooltip>
            <UFieldGroup size="sm" class="hidden sm:inline-flex">
              <UTooltip v-for="item in voiceModes" :key="item.value" :text="item.label">
                <UButton
                  :icon="item.icon"
                  color="neutral"
                  :variant="voice.mode.value === item.value ? 'solid' : 'ghost'"
                  :aria-label="item.label"
                  :aria-pressed="voice.mode.value === item.value"
                  @click="voice.setMode(item.value)"
                >
                  <span class="hidden lg:inline">{{ item.label }}</span>
                </UButton>
              </UTooltip>
            </UFieldGroup>
            <AgentVoiceQuickSettings />
            <UTooltip :text="listening ? 'Replies and sounds are on. Tap to mute.' : 'Hear the agent: replies read aloud, and its sounds'">
              <UButton
                :icon="listening ? 'i-lucide-volume-2' : 'i-lucide-volume-off'"
                :color="listening ? 'primary' : 'neutral'"
                :variant="listening ? 'soft' : 'ghost'"
                size="sm"
                :aria-label="listening ? 'Mute the agent' : 'Hear the agent'"
                :aria-pressed="listening"
                @click="setListening(!listening)"
              />
            </UTooltip>
            <UTooltip text="Type instead">
              <UChip :show="!!text.trim()" size="sm" inset>
                <UButton
                  icon="i-lucide-keyboard"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  aria-label="Type instead"
                  @click="setVoiceMode(false)"
                />
              </UChip>
            </UTooltip>
            <UTooltip v-if="turnRunning" text="Cancel the agent's turn">
              <UButton
                icon="i-lucide-square"
                color="neutral"
                variant="subtle"
                size="md"
                aria-label="Cancel the turn"
                @click="voice.cancel()"
              />
            </UTooltip>
          </div>

          <div v-else class="flex shrink-0 items-center gap-1">
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
            <!-- Typing while hearing the agent: the one way to stop a reply short of muting. -->
            <UTooltip v-if="voice && (voice.speaking.value || voice.synthesizing.value)" text="Stop reading this reply. The agent keeps working.">
              <UButton icon="i-lucide-volume-x" color="neutral" variant="subtle" size="sm" aria-label="Hush" @click="voice.hush()" />
            </UTooltip>
            <!-- Hearing and voice mode both need a session, which a draft does not have yet. -->
            <template v-if="session">
              <UTooltip :text="listening ? 'Replies and sounds are on. Tap to mute.' : 'Hear the agent: replies read aloud, and its sounds'">
                <UButton
                  :icon="listening ? 'i-lucide-volume-2' : 'i-lucide-volume-off'"
                  :color="listening ? 'primary' : 'neutral'"
                  :variant="listening ? 'soft' : 'ghost'"
                  size="sm"
                  :aria-label="listening ? 'Mute the agent' : 'Hear the agent'"
                  :aria-pressed="listening"
                  @click="setListening(!listening)"
                />
              </UTooltip>
              <UTooltip text="Talk instead">
                <UButton
                  icon="i-lucide-mic"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  aria-label="Talk instead"
                  @click="setVoiceMode(true)"
                />
              </UTooltip>
            </template>
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

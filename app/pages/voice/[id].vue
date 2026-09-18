<script setup lang="ts">
import type { VoiceSession } from '~~/shared/types'

// Nuxt keys pages by their interpolated path, so going from one conversation to
// another would remount this page, and its unmount stops the mic. One key for
// every conversation keeps the page (and the open mic) while `switchSession`
// moves the socket to the new id.
definePageMeta({ key: 'voice' })

const route = useRoute()
const router = useRouter()
const toast = useToast()

// Leaving for `/agents/:id` changes `params.id` before this page unmounts; only
// follow ids that are still conversations.
const sessionId = ref(route.params.id as string)
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === 'string' && route.path.startsWith('/voice/')) sessionId.value = id
  }
)

const { data: fetchedSession, refresh: refreshSession } = await useFetch<VoiceSession>(
  () => `/api/voice-sessions/${sessionId.value}`,
  { lazy: true }
)
// The live row wins, so an auto-generated title shows up as soon as it lands.
const { sessions } = useVoiceSessions()
const session = computed(() => sessions.value.find(row => row.id === sessionId.value) ?? fetchedSession.value)
const { creating, startConversation } = useNewConversation()

const { messages } = useVoiceMessages(sessionId)
const { sessions: agents } = useAgentSessions()
const { pending } = usePermissions()

// When Domo starts a fresh conversation itself, follow it there.
const voice = useVoiceChannel(sessionId, { onSessionChanged: id => router.push(`/voice/${id}`) })
const typed = ref('')
const newAgentOpen = ref(false)
const renaming = ref(false)
const titleDraft = ref('')

const transcript = computed(() => messages.value.filter(message => message.role !== 'tool'))

const toolMessages = computed(() =>
  messages.value.filter(message => message.role === 'tool').slice(-20)
)

const scroller = ref<HTMLElement | null>(null)

watch(
  () => [messages.value.length, voice.liveAssistantText.value, voice.liveUserText.value],
  async () => {
    await nextTick()
    const element = scroller.value
    if (element) element.scrollTop = element.scrollHeight
  }
)

onMounted(() => voice.connect())

// Keeps the mic open across conversations: talking, then "new conversation",
// carries straight on in the new one.
watch(sessionId, () => voice.switchSession())

async function toggleMic() {
  if (voice.micEnabled.value) voice.stopTalking()
  else await voice.startTalking()
}

function sendTyped() {
  if (!typed.value.trim()) return
  voice.sendText(typed.value)
  typed.value = ''
}

async function endSession() {
  voice.disconnect({ stopSession: true })
  await refreshSession()
}

async function saveTitle() {
  if (!titleDraft.value.trim()) return
  await $fetch(`/api/voice-sessions/${sessionId.value}`, {
    method: 'PATCH',
    body: { title: titleDraft.value.trim() }
  })
  renaming.value = false
  await refreshSession()
}

async function nameAutomatically() {
  await $fetch(`/api/voice-sessions/${sessionId.value}`, { method: 'PATCH', body: { autoTitle: true } })
  toast.add({ title: 'Domo will name this conversation', color: 'neutral', icon: 'i-lucide-sparkles' })
}

const menuItems = computed(() => [[
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { titleDraft.value = session.value?.title ?? ''; renaming.value = true } },
  ...(session.value?.titleSource === 'user'
    ? [{ label: 'Name automatically', icon: 'i-lucide-sparkles', onSelect: nameAutomatically }]
    : []),
  { label: 'End session', icon: 'i-lucide-power', onSelect: endSession },
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: remove }
]])

async function remove() {
  await $fetch(`/api/voice-sessions/${sessionId.value}`, { method: 'DELETE' })
  toast.add({ title: 'Conversation deleted', color: 'neutral' })
  await router.push('/')
}

const statusLabel = computed(() => {
  if (voice.state.value === 'live') return voice.micEnabled.value ? 'Listening' : 'Connected'
  if (voice.state.value === 'connecting') return 'Connecting…'
  if (voice.state.value === 'error') return 'Error'
  return 'Offline'
})

function roleMeta(role: string) {
  if (role === 'user') return { label: 'You', icon: 'i-lucide-user', class: 'bg-elevated' }
  if (role === 'assistant') return { label: 'Domo', icon: 'i-lucide-audio-lines', class: 'bg-primary/10' }
  return { label: 'System', icon: 'i-lucide-info', class: 'bg-elevated/60' }
}
</script>

<template>
  <UDashboardPanel id="voice">
    <template #header>
      <UDashboardNavbar icon="i-lucide-audio-lines">
        <template #title>
          <span class="truncate">{{ session?.title ?? 'Conversation' }}</span>
        </template>

        <template #trailing>
          <UBadge
            :color="voice.state.value === 'live' ? 'primary' : voice.state.value === 'error' ? 'error' : 'neutral'"
            variant="subtle"
            size="sm"
            :label="statusLabel"
          />
        </template>

        <template #right>
          <UTooltip text="Start over with a fresh context">
            <UButton
              icon="i-lucide-message-square-plus"
              color="neutral"
              variant="ghost"
              label="New conversation"
              :loading="creating"
              :ui="{ label: 'hidden sm:inline' }"
              @click="startConversation"
            />
          </UTooltip>
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            label="Agent"
            :ui="{ label: 'hidden sm:inline' }"
            @click="newAgentOpen = true"
          />
          <UDropdownMenu :items="menuItems">
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <ServiceBanner />

      <div class="flex h-full min-h-0 gap-4">
        <!-- conversation -->
        <div class="flex min-w-0 flex-1 flex-col">
          <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto w-full max-w-2xl space-y-4 px-1 py-4">
              <div v-if="!transcript.length" class="flex flex-col items-center gap-3 py-16 text-center">
                <VoiceOrb
                  :state="voice.state.value"
                  :listening="voice.micEnabled.value && !voice.muted.value"
                  :speaking="voice.speaking.value"
                  :input-level="voice.inputLevel.value"
                  :output-level="voice.outputLevel.value"
                />
                <div>
                  <p class="text-base font-medium">
                    Talk to Domo
                  </p>
                  <p class="mx-auto mt-1 max-w-sm text-sm text-muted">
                    Ask it to spin up a coding agent, check on one, or just say
                    <em>"what's everyone working on?"</em>
                  </p>
                </div>
                <UButton
                  :label="voice.micEnabled.value ? 'Stop talking' : 'Start talking'"
                  :icon="voice.micEnabled.value ? 'i-lucide-mic-off' : 'i-lucide-mic'"
                  size="lg"
                  @click="toggleMic"
                />
              </div>

              <div
                v-for="message in transcript"
                :key="message.id"
                class="flex gap-3"
              >
                <div
                  class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                  :class="roleMeta(message.role).class"
                >
                  <UIcon :name="roleMeta(message.role).icon" class="size-3.5 text-muted" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-0.5 text-xs text-dimmed">
                    {{ roleMeta(message.role).label }} · {{ relativeTime(message.createdAt) }}
                  </p>
                  <div
                    class="text-sm"
                    :class="message.role === 'system' ? 'text-muted italic' : ''"
                  >
                    <MarkdownView v-if="message.role === 'assistant'" :text="message.text" />
                    <p v-else class="whitespace-pre-wrap">{{ message.text }}</p>
                  </div>
                </div>
              </div>

              <!-- in-flight turn -->
              <div v-if="voice.liveUserText.value" class="flex gap-3 opacity-70">
                <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated">
                  <UIcon name="i-lucide-user" class="size-3.5 text-muted" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-0.5 text-xs text-dimmed">
                    You · speaking
                  </p>
                  <p class="whitespace-pre-wrap text-sm">{{ voice.liveUserText.value }}</p>
                </div>
              </div>

              <div v-if="voice.liveAssistantText.value" class="flex gap-3">
                <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <UIcon name="i-lucide-audio-lines" class="size-3.5 text-primary" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-0.5 text-xs text-dimmed">
                    Domo · speaking
                  </p>
                  <MarkdownView :text="voice.liveAssistantText.value" />
                </div>
              </div>
            </div>
          </div>

          <!-- controls -->
          <div class="shrink-0 border-t border-default pt-3">
            <div class="mx-auto flex w-full max-w-2xl flex-col gap-3">
              <UAlert
                v-if="voice.errorMessage.value"
                color="error"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                :description="voice.errorMessage.value"
                :close="true"
                @update:open="voice.errorMessage.value = null"
              />

              <div class="flex items-center gap-2">
                <UTooltip :text="voice.micEnabled.value ? 'Stop the microphone' : 'Start talking'">
                  <UButton
                    :icon="voice.micEnabled.value ? 'i-lucide-mic-off' : 'i-lucide-mic'"
                    :color="voice.micEnabled.value ? 'primary' : 'neutral'"
                    :variant="voice.micEnabled.value ? 'solid' : 'subtle'"
                    size="lg"
                    :aria-label="voice.micEnabled.value ? 'Stop the microphone' : 'Start talking'"
                    @click="toggleMic"
                  />
                </UTooltip>

                <UTooltip v-if="voice.micEnabled.value" :text="voice.muted.value ? 'Unmute' : 'Mute'">
                  <UButton
                    :icon="voice.muted.value ? 'i-lucide-volume-x' : 'i-lucide-volume-2'"
                    color="neutral"
                    variant="subtle"
                    size="lg"
                    :aria-label="voice.muted.value ? 'Unmute the microphone' : 'Mute the microphone'"
                    @click="voice.setMuted(!voice.muted.value)"
                  />
                </UTooltip>

                <UTooltip v-if="voice.speaking.value" text="Stop speaking">
                  <UButton
                    icon="i-lucide-square"
                    color="neutral"
                    variant="subtle"
                    size="lg"
                    aria-label="Stop speaking"
                    @click="voice.stopPlayback()"
                  />
                </UTooltip>

                <UInput
                  v-model="typed"
                  class="flex-1"
                  size="lg"
                  placeholder="…or type to Domo"
                  :ui="{ trailing: 'pe-1' }"
                  @keydown.enter="sendTyped"
                >
                  <template #trailing>
                    <UButton
                      icon="i-lucide-corner-down-left"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      :disabled="!typed.trim()"
                      @click="sendTyped"
                    />
                  </template>
                </UInput>
              </div>

              <p class="text-center text-xs text-dimmed">
                Domo hears you continuously while the mic is on and can interrupt itself when you speak.
              </p>
            </div>
          </div>
        </div>

        <!-- right rail: what the voice agent is doing -->
        <aside class="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-s border-default ps-4 lg:flex">
          <div class="flex flex-col items-center gap-2 pt-2">
            <VoiceOrb
              :state="voice.state.value"
              :listening="voice.micEnabled.value && !voice.muted.value"
              :speaking="voice.speaking.value"
              :input-level="voice.inputLevel.value"
              :output-level="voice.outputLevel.value"
            />
            <p class="text-xs text-muted">
              {{ voice.statusDetail.value || statusLabel }}
            </p>
          </div>

          <div v-if="pending.length">
            <p class="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-warning">
              Waiting on you
            </p>
            <ul class="space-y-1.5">
              <li v-for="permission in pending" :key="permission.id">
                <NuxtLink
                  :to="`/agents/${permission.agentSessionId}`"
                  class="block rounded-md border border-warning/30 bg-warning/5 p-2 text-xs hover:bg-warning/10"
                >
                  {{ truncate(permission.title, 80) }}
                </NuxtLink>
              </li>
            </ul>
          </div>

          <div>
            <p class="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Agents
            </p>
            <p v-if="!agents.length" class="text-xs text-muted">
              None yet. Ask Domo to start one.
            </p>
            <ul class="space-y-1">
              <li v-for="agent in agents" :key="agent.id">
                <NuxtLink
                  :to="`/agents/${agent.id}`"
                  class="block rounded-md p-2 hover:bg-elevated"
                >
                  <span class="flex items-center gap-2">
                    <StatusDot :status="agent.status">
                      <span class="sr-only">{{ agent.status }}</span>
                    </StatusDot>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ agent.title }}</span>
                  </span>
                  <span v-if="agent.summary" class="mt-0.5 block text-xs text-dimmed">
                    {{ truncate(agent.summary, 70) }}
                  </span>
                </NuxtLink>
              </li>
            </ul>
          </div>

          <div v-if="toolMessages.length">
            <p class="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Tool calls
            </p>
            <ul class="space-y-1">
              <li
                v-for="message in toolMessages"
                :key="message.id"
                class="rounded-md bg-elevated/50 px-2 py-1.5"
              >
                <p class="font-mono text-[11px] text-muted">
                  {{ message.toolName }}
                </p>
                <p class="text-[11px] text-dimmed">
                  {{ truncate(message.text, 90) }}
                </p>
              </li>
            </ul>
          </div>
        </aside>
      </div>
        <NewAgentModal v-model:open="newAgentOpen" :voice-session-id="sessionId" />

        <UModal v-model:open="renaming" title="Rename conversation" description="Give this conversation a name.">
          <template #body>
            <UInput v-model="titleDraft" class="w-full" autofocus @keydown.enter="saveTitle" />
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="ghost" @click="renaming = false" />
              <UButton label="Save" @click="saveTitle" />
            </div>
          </template>
        </UModal>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import type { AgentAdapter, SetupCheckResult, SetupProgress, SetupTarget } from '~~/shared/types'
import { AGENT_ADAPTERS, agentAdapterInfo } from '~~/shared/agent-adapters'
import { SPEAKERS, TRANSCRIBERS } from '~~/shared/agent-voice'
import type { SetupTone } from '~/utils/setup'

/**
 * The setup guide: each coding agent and voice, whether it is installed and
 * signed in and on what, what to do when it is not, and a live check the
 * person starts. It opens by itself on a new install and is in Settings
 * after that. What it remembers is what was done: checks that passed, steps
 * skipped, and whether the guide was finished.
 */
const toast = useToast()
const { data: setup, refresh: refreshSetup, status: setupLoad } = useSetupStatus()
const { data: settings, refresh: refreshSettings } = useSettings()

async function refresh() {
  await Promise.all([refreshSetup(), refreshSettings()])
}

const progress = computed<SetupProgress>(() => setup.value?.progress ?? { finishedAt: null, skipped: [], checks: {} })

interface Step {
  id: SetupTarget
  label: string
  icon: string
  badge: { label: string, color: SetupTone }
  ready: boolean
}

const steps = computed<Step[]>(() => {
  const status = setup.value
  if (!status) return []
  const agents = AGENT_ADAPTERS.map((adapter): Step => {
    const agent = status.agents.find(entry => entry.id === adapter.id)!
    const check = progress.value.checks[adapter.id]
    const badge = agentBadge(agent, check)
    return { id: adapter.id, label: adapter.label, icon: adapter.icon, badge, ready: agent.installed && agent.login !== 'none' && check?.ok !== false }
  })
  const voiceCheck = progress.value.checks.voice
  return [...agents, {
    id: 'voice',
    label: 'Voice',
    icon: 'i-lucide-audio-lines',
    badge: voiceBadge(status.voice, voiceCheck),
    ready: !status.voice.problem && voiceCheck?.ok !== false
  }]
})

const isSkipped = (id: SetupTarget) => progress.value.skipped.includes(id)
const doneCount = computed(() => steps.value.filter(step => step.ready && progress.value.checks[step.id]?.ok).length)

/** Open what still needs something, once, when the status first arrives. */
const open = ref<Partial<Record<SetupTarget, boolean>>>({})
watch(steps, (list, before) => {
  if (before?.length || !list.length) return
  for (const step of list) open.value[step.id] = !isSkipped(step.id) && !(step.ready && progress.value.checks[step.id]?.ok)
}, { immediate: true })

function agentStatus(id: AgentAdapter) {
  return setup.value?.agents.find(agent => agent.id === id) ?? null
}

/** What a live check will cost, said before the button is pressed. */
function costNote(id: AgentAdapter): string {
  const agent = agentStatus(id)
  if (!agent) return ''
  const model = id === 'opencode' && agent.login === 'free' ? 'one of its free models' : agent.testModel
  if (agent.login === 'api-key') return `Sends one short message to ${model}. On an API key that bills a fraction of a cent.`
  if (agent.login === 'free') return `Sends one short message to ${model}. Free.`
  return `Sends one short message to ${model}, a tiny part of your plan.`
}

const checking = ref<Partial<Record<SetupTarget, boolean>>>({})
const replies = ref<Partial<Record<SetupTarget, string | null>>>({})

async function runCheck(target: SetupTarget) {
  checking.value[target] = true
  try {
    const answer = await $fetch<SetupCheckResult & { reply?: string | null, audio?: string | null, heard?: string | null, progress: SetupProgress }>(
      '/api/setup/check', { method: 'POST', body: { target } }
    )
    if (setup.value) setup.value = { ...setup.value, progress: answer.progress }
    replies.value[target] = answer.reply ?? null
    if (answer.audio) await playWav(base64ToArrayBuffer(answer.audio), 1).catch(() => {})
    await refreshSetup()
  } catch (error: any) {
    toast.add({ title: 'Could not run the check', description: error?.data?.message ?? error?.message, color: 'error' })
  } finally {
    checking.value[target] = false
  }
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0))
  return bytes.buffer
}

async function patchSetup(body: { finished?: boolean, skip?: SetupTarget, unskip?: SetupTarget }) {
  try {
    const next = await $fetch<SetupProgress>('/api/setup', { method: 'PATCH', body })
    if (setup.value) setup.value = { ...setup.value, progress: next }
    return true
  } catch (error: any) {
    toast.add({ title: 'Could not save that', description: error?.data?.message ?? error?.message, color: 'error' })
    return false
  }
}

async function skip(id: SetupTarget) {
  if (await patchSetup({ skip: id })) open.value[id] = false
}

async function finish() {
  if (await patchSetup({ finished: true })) {
    await refreshSettings()
    await navigateTo('/')
  }
}

const voiceEngines = computed(() => {
  const voice = setup.value?.voice
  if (!voice) return ''
  const hears = TRANSCRIBERS.find(engine => engine.id === voice.transcriber)?.label ?? voice.transcriber
  const speaks = SPEAKERS.find(engine => engine.id === voice.speaker)?.label ?? voice.speaker
  return `Hears you with ${hears}; speaks with ${speaks}.`
})
const voiceUses = (engine: string) => setup.value?.voice.transcriber === engine || setup.value?.voice.speaker === engine

const switchingVoice = ref(false)
/** The way past a missing key that needs no account: the open models on this computer. */
async function useOpenModels() {
  if (!settings.value) return
  switchingVoice.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { agentVoice: { ...settings.value.agentVoice, transcriber: 'local', speaker: 'local' } } })
    await refresh()
    toast.add({ title: 'Voice now uses the open models', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not switch', description: error?.data?.message ?? error?.message, color: 'error' })
  } finally {
    switchingVoice.value = false
  }
}

function when(at: string) {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <UDashboardPanel id="setup">
    <template #header>
      <UDashboardNavbar title="Set up Domo" icon="i-lucide-list-checks">
        <template #right>
          <UButton
            v-if="!progress.finishedAt"
            label="Skip for now"
            color="neutral"
            variant="ghost"
            @click="finish"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-2xl space-y-6 py-4">
        <header class="space-y-2">
          <h1 class="text-lg font-semibold">Let's get your agents talking</h1>
          <p class="text-sm text-muted">
            Domo runs Claude Code, Codex and OpenCode for you, and lets you talk to them. Below, each one is checked:
            is it there, is it signed in, and does it answer. You need at least one coding agent; skip anything you don't use.
          </p>
          <p class="flex gap-2 text-xs text-muted">
            <UIcon name="i-lucide-monitor-smartphone" class="mt-0.5 size-4 shrink-0" />
            <span>A step that says "run in a terminal" happens on the computer Domo runs on. Everything else, pasting keys included, works from here, on a phone too.</span>
          </p>
          <div v-if="steps.length" class="flex items-center gap-3 pt-1">
            <UProgress :model-value="doneCount" :max="steps.length" class="flex-1" />
            <span class="shrink-0 text-xs tabular-nums text-muted">{{ doneCount }} of {{ steps.length }} tested</span>
          </div>
        </header>

        <div v-if="!steps.length" class="space-y-3">
          <USkeleton v-for="n in 4" :key="n" class="h-14 w-full" />
          <p v-if="setupLoad === 'error'" class="text-sm text-error">Could not read the setup status. Reload to try again.</p>
        </div>

        <UCard
          v-for="step in steps"
          :key="step.id"
          :ui="{ body: 'p-0 sm:p-0', root: 'overflow-hidden' }"
        >
          <UCollapsible v-model:open="open[step.id]">
            <button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-elevated/50">
              <UIcon :name="step.icon" class="size-5 shrink-0 text-muted" />
              <span class="flex-1 font-medium">{{ step.label }}</span>
              <UBadge v-if="isSkipped(step.id)" label="Skipped" color="neutral" variant="outline" />
              <UBadge v-else :label="step.badge.label" :color="step.badge.color" variant="subtle" />
              <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 text-dimmed transition-transform" :class="open[step.id] ? 'rotate-180' : ''" />
            </button>

            <template #content>
              <div class="space-y-5 border-t border-default px-4 py-4">
                <template v-if="step.id !== 'voice'">
                  <AgentSignIn
                    :adapter="step.id"
                    :status="agentStatus(step.id)"
                    :settings="settings ?? null"
                    @changed="refresh"
                  />

                  <div v-if="agentStatus(step.id)?.installed && agentStatus(step.id)?.login !== 'none'" class="space-y-2">
                    <p class="text-sm font-medium">Try it</p>
                    <p class="text-xs text-muted">{{ costNote(step.id) }}</p>
                    <UButton
                      :label="progress.checks[step.id] ? 'Test again' : `Test ${agentAdapterInfo(step.id).label}`"
                      icon="i-lucide-play"
                      :loading="checking[step.id]"
                      @click="runCheck(step.id)"
                    />
                    <UAlert
                      v-if="progress.checks[step.id]"
                      :color="progress.checks[step.id]!.ok ? 'success' : 'error'"
                      variant="subtle"
                      :icon="progress.checks[step.id]!.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                      :title="progress.checks[step.id]!.ok ? 'It answered' : 'It did not work'"
                      :description="`${progress.checks[step.id]!.summary}${replies[step.id] ? ` It said: “${replies[step.id]}”.` : ''} (${when(progress.checks[step.id]!.at)})`"
                    />
                    <p v-if="agentStatus(step.id)?.usage?.state === 'ok'" class="text-xs text-muted">
                      Your plan limits show in the sidebar.
                    </p>
                  </div>
                </template>

                <template v-else>
                  <p class="text-sm text-muted">{{ voiceEngines }}</p>
                  <UAlert
                    v-if="setup?.voice.problem"
                    color="error"
                    variant="subtle"
                    icon="i-lucide-circle-alert"
                    title="Voice can't work yet"
                    :description="setup.voice.problem"
                  />
                  <CredentialField
                    v-if="voiceUses('gemini')"
                    :settings="settings ?? null"
                    credential="geminiApiKey"
                    label="Gemini API key"
                    placeholder="AIza…"
                    @saved="refresh"
                  >
                    <template #help>
                      Free to start.
                      <ULink to="https://aistudio.google.com/apikey" target="_blank" class="text-primary">Get a key at Google AI Studio</ULink>,
                      then paste it here.
                    </template>
                  </CredentialField>
                  <CredentialField
                    v-if="voiceUses('openai')"
                    :settings="settings ?? null"
                    credential="openAiApiKey"
                    label="OpenAI API key"
                    placeholder="sk-…"
                    warning="Bills per token through the OpenAI API, not a ChatGPT plan."
                    @saved="refresh"
                  />
                  <div v-if="setup?.voice.problem" class="space-y-1">
                    <UButton
                      label="Use the free open models instead"
                      icon="i-lucide-cpu"
                      color="neutral"
                      variant="subtle"
                      :loading="switchingVoice"
                      @click="useOpenModels"
                    />
                    <p class="text-xs text-muted">They run on the computer Domo runs on: no key, no account, a little slower.</p>
                  </div>

                  <div class="space-y-2">
                    <p class="text-sm font-medium">Try it</p>
                    <p class="text-xs text-muted">Domo says a sentence out loud, then listens to it. Turn your sound on.</p>
                    <UButton
                      :label="progress.checks.voice ? 'Test again' : 'Test voice'"
                      icon="i-lucide-volume-2"
                      :loading="checking.voice"
                      :disabled="!!setup?.voice.problem"
                      @click="runCheck('voice')"
                    />
                    <UAlert
                      v-if="progress.checks.voice"
                      :color="progress.checks.voice.ok ? 'success' : 'error'"
                      variant="subtle"
                      :icon="progress.checks.voice.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                      :title="progress.checks.voice.ok ? 'Voice works' : 'It did not work'"
                      :description="`${progress.checks.voice.summary} (${when(progress.checks.voice.at)})`"
                    />
                  </div>
                  <ULink to="/settings/voice" class="text-sm text-primary">All voice settings</ULink>
                </template>

                <div class="flex justify-end border-t border-default pt-3">
                  <UButton
                    v-if="isSkipped(step.id)"
                    label="Don't skip"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    @click="patchSetup({ unskip: step.id })"
                  />
                  <UButton
                    v-else
                    :label="`I don't use ${step.id === 'voice' ? 'voice' : step.label}`"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    @click="skip(step.id)"
                  />
                </div>
              </div>
            </template>
          </UCollapsible>
        </UCard>

        <div v-if="steps.length" class="flex flex-wrap items-center justify-end gap-3">
          <p class="flex-1 text-xs text-muted">You can come back here any time from Settings.</p>
          <UButton :label="progress.finishedAt ? 'Done' : 'Finish'" icon="i-lucide-check" @click="finish" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

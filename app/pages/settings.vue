<script setup lang="ts">
import type { AppSettings, McpServer } from '~~/shared/types'

const toast = useToast()
const { servers } = useMcpServers()

const { data: settings, refresh } = await useFetch<AppSettings & {
  hasGeminiKey: boolean
  hasAnthropicKey: boolean
  hasOpenAiKey: boolean
}>(
  '/api/settings',
  { lazy: false }
)

const { data: modelList } = await useFetch<{ models: Array<{ name: string, displayName?: string, live: boolean }>, error?: string }>(
  '/api/models',
  { lazy: true }
)

const form = reactive<AppSettings>({
  liveModel: '',
  voiceName: 'Puck',
  systemInstruction: '',
  defaultCwd: '',
  proactiveNotifications: true,
  autoApprovePermissions: false,
  defaultAgentMode: 'default',
  language: 'en-US'
})

watchEffect(() => {
  if (!settings.value) return
  Object.assign(form, {
    liveModel: settings.value.liveModel,
    voiceName: settings.value.voiceName,
    systemInstruction: settings.value.systemInstruction,
    defaultCwd: settings.value.defaultCwd,
    proactiveNotifications: settings.value.proactiveNotifications,
    autoApprovePermissions: settings.value.autoApprovePermissions,
    defaultAgentMode: settings.value.defaultAgentMode,
    language: settings.value.language
  })
})

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { ...form } })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

/* Model ids move fast; offer whatever the key can actually see, plus a free
 * text fallback so a brand-new Live model can be typed in. */
const modelItems = computed(() => {
  const fromApi = (modelList.value?.models ?? []).filter(model => model.live).map(model => model.name)
  const candidates = new Set<string>([form.liveModel, ...fromApi].filter(Boolean))
  return [...candidates]
})

const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']

const MODES = [
  { label: 'Ask every time', value: 'default' },
  { label: 'Accept edits', value: 'acceptEdits' },
  { label: 'Plan first', value: 'plan' },
  { label: 'Bypass permissions', value: 'bypassPermissions' }
]

const mcpOpen = ref(false)
const editing = ref<McpServer | null>(null)

function addServer() {
  editing.value = null
  mcpOpen.value = true
}

function editServer(server: McpServer) {
  editing.value = server
  mcpOpen.value = true
}

async function toggleServer(server: McpServer) {
  await $fetch(`/api/mcp-servers/${server.id}`, { method: 'PATCH', body: { enabled: !server.enabled } })
}

async function deleteServer(server: McpServer) {
  await $fetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' })
  toast.add({ title: `Removed ${server.name}`, color: 'neutral' })
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" icon="i-lucide-settings">
        <template #right>
          <UButton label="Save" icon="i-lucide-check" :loading="saving" @click="save" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-3xl space-y-8 py-4">
        <ServiceBanner />
        <section class="space-y-4">
          <div>
            <h2 class="text-sm font-semibold">
              Keys
            </h2>
            <p class="text-xs text-muted">
              Keys come from your <code class="rounded bg-elevated px-1">.env</code> file, never the database.
            </p>
          </div>
          <div class="grid gap-2 sm:grid-cols-3">
            <UAlert
              :color="settings?.hasGeminiKey ? 'success' : 'warning'"
              variant="subtle"
              :icon="settings?.hasGeminiKey ? 'i-lucide-check' : 'i-lucide-key-round'"
              title="Gemini (voice agent)"
              :description="settings?.hasGeminiKey ? 'NUXT_GEMINI_API_KEY is set' : 'Set NUXT_GEMINI_API_KEY in .env'"
            />
            <UAlert
              :color="settings?.hasAnthropicKey ? 'success' : 'neutral'"
              variant="subtle"
              icon="i-lucide-terminal"
              title="Claude Code"
              :description="settings?.hasAnthropicKey ? 'ANTHROPIC_API_KEY is forwarded to the adapter' : 'Using your local `claude` login'"
            />
            <UAlert
              :color="settings?.hasOpenAiKey ? 'success' : 'neutral'"
              variant="subtle"
              icon="i-lucide-terminal"
              title="Codex"
              :description="settings?.hasOpenAiKey ? 'OpenAI API key is forwarded to the adapter' : 'Using your local Codex login'"
            />
          </div>
        </section>

        <USeparator />

        <section class="space-y-4">
          <h2 class="text-sm font-semibold">
            Voice agent
          </h2>

          <UFormField label="Live model" hint="Gemini Live model id">
            <UInputMenu
              v-model="form.liveModel"
              :items="modelItems"
              create-item
              class="w-full font-mono text-xs"
              @create="(value: string) => (form.liveModel = value)"
            />
            <template #help>
              <span v-if="modelList?.error" class="text-xs text-muted">
                Could not list models: {{ modelList.error }} — type the id manually.
              </span>
            </template>
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Voice">
              <USelectMenu v-model="form.voiceName" :items="VOICES" class="w-full" />
            </UFormField>
            <UFormField label="Spoken language">
              <UInput v-model="form.language" class="w-full" placeholder="en-US" />
            </UFormField>
          </div>

          <UFormField label="System instruction" hint="How the voice agent behaves">
            <UTextarea v-model="form.systemInstruction" :rows="10" class="w-full text-xs" />
          </UFormField>

          <USwitch
            v-model="form.proactiveNotifications"
            label="Speak up on agent activity"
            description="When a coding agent finishes a turn or needs a decision, the voice agent tells you."
          />
        </section>

        <USeparator />

        <section class="space-y-4">
          <h2 class="text-sm font-semibold">
            Coding agents
          </h2>

          <UFormField label="Default workspace" hint="Where new agents start">
            <DirectoryPicker v-model="form.defaultCwd" />
          </UFormField>

          <UFormField label="Default permission mode">
            <USelectMenu
              v-model="form.defaultAgentMode"
              :items="MODES"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <USwitch
            v-model="form.autoApprovePermissions"
            label="Auto-approve permission requests"
            description="Answers every prompt with its first “allow once” option. Convenient and dangerous — the agent can edit and run things unattended."
          />
        </section>

        <USeparator />

        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-sm font-semibold">
                MCP servers
              </h2>
              <p class="text-xs text-muted">
                Extra tools for the voice agent, the coding agents, or both.
              </p>
            </div>
            <UButton label="Add" icon="i-lucide-plus" size="sm" color="neutral" variant="subtle" @click="addServer" />
          </div>

          <div v-if="!servers.length" class="rounded-lg border border-dashed border-default p-6 text-center">
            <p class="text-sm text-muted">
              No MCP servers yet.
            </p>
            <p class="mt-1 text-xs text-dimmed">
              Coding agents always get Domo's built-in <code>domo</code> server for talking to each other.
            </p>
          </div>

          <div v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <div
              v-for="server in servers"
              :key="server.id"
              class="flex items-center gap-3 p-3"
            >
              <UIcon
                :name="server.transport === 'stdio' ? 'i-lucide-terminal' : 'i-lucide-globe'"
                class="size-4 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">
                  {{ server.name }}
                  <UBadge
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    class="ms-1.5"
                    :label="server.scope === 'both' ? 'all agents' : server.scope === 'voice' ? 'voice' : 'coding'"
                  />
                </p>
                <p class="truncate font-mono text-xs text-dimmed">
                  {{ server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url }}
                </p>
              </div>
              <USwitch :model-value="server.enabled" @update:model-value="toggleServer(server)" />
              <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" @click="editServer(server)" />
              <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" @click="deleteServer(server)" />
            </div>
          </div>
        </section>
      </div>
        <McpServerModal v-model:open="mcpOpen" :server="editing" />
    </template>
  </UDashboardPanel>
</template>

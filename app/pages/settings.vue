<script setup lang="ts">
import type { AgentAdapter, AppSettings, McpServer, SessionModeInfo } from '~~/shared/types'

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
  defaultAgentModes: { 'claude-code': 'default', codex: 'agent' },
  language: 'en-US',
  autoTitle: true,
  vscodeSshHost: '',
  homeMounts: []
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
    defaultAgentModes: { ...settings.value.defaultAgentModes },
    language: settings.value.language,
    autoTitle: settings.value.autoTitle,
    vscodeSshHost: settings.value.vscodeSshHost,
    homeMounts: [...settings.value.homeMounts]
  })
})

/* One path per line is how people write a list of paths. It stays text while
 * it is being edited — parsing on every keystroke would eat the newline the
 * moment you press Enter — and becomes an array on save. */
const homeMountsText = ref('')

watchEffect(() => {
  if (settings.value) homeMountsText.value = settings.value.homeMounts.join('\n')
})

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    const homeMounts = homeMountsText.value.split('\n').map(line => line.trim()).filter(Boolean)
    await $fetch('/api/settings', { method: 'PATCH', body: { ...form, homeMounts } })
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

/* Permission modes are per adapter and only the adapter knows them: the two
 * share no mode id at all (Claude Code `default`/`acceptEdits`/`plan`/`auto`/
 * `bypassPermissions`, Codex `read-only`/`agent`/`agent-full-access`), so the
 * list that used to be hard-coded here was wrong for one of them whichever way
 * it was written. Same probe and same endpoint as the model picker, so opening
 * this page costs at most one adapter spawn each, cached server-side for an
 * hour. */
type AdapterProbe = {
  models: Array<{ id: string, name: string }>
  current: string | null
  modes: SessionModeInfo[]
  currentMode: string | null
}

const ADAPTERS: Array<{ id: AgentAdapter, label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

const probes = {
  'claude-code': await useFetch<AdapterProbe>('/api/adapters/models', {
    key: 'adapter-probe-claude-code',
    query: { adapter: 'claude-code' },
    lazy: true
  }),
  codex: await useFetch<AdapterProbe>('/api/adapters/models', {
    key: 'adapter-probe-codex',
    query: { adapter: 'codex' },
    lazy: true
  })
}

/* A mode id the adapter has not listed — one that shipped after this Domo, or
 * the value this install already had. The selected value is always among the
 * items, or the menu would render blank. */
const typedModes = reactive<Record<AgentAdapter, string[]>>({ 'claude-code': [], codex: [] })

function modeItems(adapter: AgentAdapter) {
  const items = (probes[adapter].data.value?.modes ?? []).map(mode => ({ label: mode.name, value: mode.id }))
  for (const id of [form.defaultAgentModes[adapter], ...typedModes[adapter]]) {
    if (id && !items.some(item => item.value === id)) items.push({ label: id, value: id })
  }
  return items
}

function addTypedMode(adapter: AgentAdapter, id: string) {
  typedModes[adapter].push(id)
  form.defaultAgentModes[adapter] = id
}

function probeError(adapter: AgentAdapter): string | null {
  const error = probes[adapter].error.value as any
  return error ? (error.statusMessage ?? error.message ?? String(error)) : null
}

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

          <USwitch
            v-model="form.autoTitle"
            label="Name conversations automatically"
            description="The voice agent titles each conversation as it goes and renames it when the topic moves on. A title you set yourself is never replaced."
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

          <div class="space-y-2">
            <p class="text-sm font-medium">
              Default permission mode
            </p>
            <p class="text-xs text-muted">
              How much a new session may do before it asks. Each agent has its own list and its own
              default — they share no mode ids — and both lists come from the agent itself.
            </p>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField v-for="entry in ADAPTERS" :key="entry.id" :label="entry.label">
                <USelectMenu
                  v-model="form.defaultAgentModes[entry.id]"
                  :items="modeItems(entry.id)"
                  value-key="value"
                  :loading="probes[entry.id].status.value === 'pending'"
                  create-item
                  class="w-full"
                  @create="(id: string) => addTypedMode(entry.id, id)"
                />
                <template #help>
                  <span v-if="probeError(entry.id)" class="text-xs text-error">
                    Could not ask {{ entry.label }} which modes it offers: {{ probeError(entry.id) }} —
                    type the id manually.
                  </span>
                </template>
              </UFormField>
            </div>
          </div>

          <USwitch
            v-model="form.autoApprovePermissions"
            label="Auto-approve permission requests"
            description="Answers every prompt with its first “allow once” option. Convenient and dangerous — the agent can edit and run things unattended."
          />
        </section>

        <USeparator />

        <section class="space-y-4">
          <h2 class="text-sm font-semibold">
            Development environments
          </h2>

          <UFormField
            label="Home directory mounts"
            help="Paths under your home directory, one per line, bind-mounted read-write into a new environment's home so agents can push and use your CLI logins. One you do not have is skipped. .gitconfig is mounted read-only as .gitconfig-host and included from the environment's own config; .claude, .claude.json and .codex are refused, and .docker is a bad idea (its credential helper only exists on this machine, so docker pull fails in there). Mounts are fixed when a container is created, so this applies to environments created from now on."
          >
            <UTextarea v-model="homeMountsText" :rows="6" class="w-full font-mono text-xs" />
          </UFormField>

          <UFormField
            label="VS Code SSH host"
            help="Leave empty when VS Code runs on the same machine as Domo's Docker. Otherwise the SSH target VS Code should reach Docker through, e.g. you@server."
          >
            <UInput v-model="form.vscodeSshHost" class="w-full font-mono text-xs" placeholder="you@server" />
          </UFormField>
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

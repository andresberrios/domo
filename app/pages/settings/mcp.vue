<script setup lang="ts">
import type { McpServer } from '~~/shared/types'

const toast = useToast()
const { servers } = useMcpServers()
const open = ref(false)
const editing = ref<McpServer | null>(null)
function add() { editing.value = null; open.value = true }
function edit(server: McpServer) { editing.value = server; open.value = true }
async function toggle(server: McpServer) {
  await $fetch(`/api/mcp-servers/${server.id}`, { method: 'PATCH', body: { enabled: !server.enabled } })
}
async function remove(server: McpServer) {
  await $fetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' })
  toast.add({ title: `Removed ${server.name}`, color: 'neutral' })
}
</script>

<template>
  <SettingsShell title="MCP servers" description="Extra tools made available to the voice agent, coding agents, or both.">
    <div class="flex justify-end">
      <UButton label="Add server" icon="i-lucide-plus" size="sm" @click="add" />
    </div>
    <div v-if="!servers.length" class="rounded-lg border border-dashed border-default p-8 text-center">
      <p class="text-sm text-muted">No MCP servers yet.</p>
      <p class="mt-1 text-xs text-dimmed">Coding agents still get Domo's built-in mesh server when their adapter supports HTTP MCP.</p>
    </div>
    <div v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
      <div v-for="server in servers" :key="server.id" class="flex items-center gap-3 p-3">
        <UIcon :name="server.transport === 'stdio' ? 'i-lucide-terminal' : 'i-lucide-globe'" class="size-4 shrink-0 text-muted" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">
            {{ server.name }}
            <UBadge size="sm" color="neutral" variant="subtle" class="ms-1.5" :label="server.scope === 'both' ? 'all agents' : server.scope" />
          </p>
          <p class="truncate font-mono text-xs text-dimmed">{{ server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url }}</p>
        </div>
        <USwitch :model-value="server.enabled" @update:model-value="toggle(server)" />
        <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" @click="edit(server)" />
        <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" @click="remove(server)" />
      </div>
    </div>
    <McpServerModal v-model:open="open" :server="editing" />
  </SettingsShell>
</template>

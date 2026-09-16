<script setup lang="ts">
import type { McpServer } from '~~/shared/types'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ server?: McpServer | null }>()
const emit = defineEmits<{ saved: [] }>()

const toast = useToast()
const saving = ref(false)

const form = reactive({
  name: '',
  transport: 'stdio' as McpServer['transport'],
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  scope: 'both' as McpServer['scope'],
  enabled: true
})

watch(open, (value) => {
  if (!value) return
  const server = props.server
  form.name = server?.name ?? ''
  form.transport = server?.transport ?? 'stdio'
  form.command = server?.command ?? ''
  form.args = (server?.args ?? []).join(' ')
  form.env = Object.entries(server?.env ?? {}).map(([key, val]) => `${key}=${val}`).join('\n')
  form.url = server?.url ?? ''
  form.headers = Object.entries(server?.headers ?? {}).map(([key, val]) => `${key}: ${val}`).join('\n')
  form.scope = server?.scope ?? 'both'
  form.enabled = server?.enabled ?? true
})

function parsePairs(input: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(separator)
    if (index === -1) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

async function save() {
  saving.value = true
  try {
    const body = {
      name: form.name.trim(),
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : null,
      args: form.transport === 'stdio' ? form.args.split(' ').map(a => a.trim()).filter(Boolean) : [],
      env: parsePairs(form.env, '='),
      url: form.transport === 'stdio' ? null : form.url.trim(),
      headers: parsePairs(form.headers, ':'),
      scope: form.scope,
      enabled: form.enabled
    }

    if (props.server) {
      await $fetch(`/api/mcp-servers/${props.server.id}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/mcp-servers', { method: 'POST', body })
    }
    open.value = false
    emit('saved')
  } catch (error: any) {
    toast.add({
      title: 'Could not save',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="server ? 'Edit MCP server' : 'Add MCP server'"
    description="MCP servers give the agents extra tools. stdio servers run locally; http/sse servers are remote."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name">
          <UInput v-model="form.name" class="w-full" placeholder="linear" autofocus />
        </UFormField>

        <UFormField label="Transport">
          <UTabs
            v-model="form.transport"
            :items="[
              { label: 'stdio', value: 'stdio' },
              { label: 'http', value: 'http' },
              { label: 'sse', value: 'sse' }
            ]"
            :content="false"
            size="sm"
          />
        </UFormField>

        <template v-if="form.transport === 'stdio'">
          <UFormField label="Command">
            <UInput v-model="form.command" class="w-full font-mono text-xs" placeholder="npx" />
          </UFormField>
          <UFormField label="Arguments" hint="space separated">
            <UInput v-model="form.args" class="w-full font-mono text-xs" placeholder="-y @acme/mcp-server" />
          </UFormField>
        </template>

        <template v-else>
          <UFormField label="URL">
            <UInput v-model="form.url" class="w-full font-mono text-xs" placeholder="https://example.com/mcp" />
          </UFormField>
          <UFormField label="Headers" hint="one per line, Key: value">
            <UTextarea v-model="form.headers" :rows="3" class="w-full font-mono text-xs" />
          </UFormField>
        </template>

        <UFormField label="Environment" hint="one per line, KEY=value">
          <UTextarea v-model="form.env" :rows="3" class="w-full font-mono text-xs" />
        </UFormField>

        <UFormField label="Available to">
          <USelectMenu
            v-model="form.scope"
            :items="[
              { label: 'Voice agent and coding agents', value: 'both' },
              { label: 'Voice agent only', value: 'voice' },
              { label: 'Coding agents only', value: 'coding' }
            ]"
            value-key="value"
            class="w-full"
          />
        </UFormField>

        <USwitch v-model="form.enabled" label="Enabled" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton label="Save" :loading="saving" :disabled="!form.name.trim()" @click="save" />
      </div>
    </template>
  </UModal>
</template>

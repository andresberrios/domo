<script setup lang="ts">
import type { Env } from '~~/server/lib/schemas'

const props = defineProps<{ projectId: string; defaultBranch: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [env: Env]; cancelled: [] }>()

const name = ref('')
const baseBranch = ref('')
const pending = ref(false)
const errMsg = ref<string | null>(null)
const streaming = ref(false)
const cancelling = ref(false)
const createdEnv = ref<Env | null>(null)
const { steps, reset, consume } = useBuildProgress()

watch(open, (v) => {
  if (v) {
    name.value = ''
    baseBranch.value = props.defaultBranch ?? ''
    pending.value = false
    errMsg.value = null
    streaming.value = false
    cancelling.value = false
    reset()
    createdEnv.value = null
  }
})

let abort: AbortController | null = null

async function streamRun(envId: string): Promise<void> {
  abort = new AbortController()
  const res = await fetch('/api/envs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envId }),
    signal: abort.signal,
  })
  if (!res.ok || !res.body) {
    errMsg.value = `coast run failed (${res.status})`
    streaming.value = false
    return
  }
  await consume(res.body, {
    onError: (msg) => { errMsg.value = msg },
  })
  streaming.value = false
}

async function submit() {
  if (!name.value.trim()) return
  pending.value = true
  errMsg.value = null
  try {
    const env = await apiClient.envs.create.call({
      projectId: props.projectId,
      name: name.value.trim(),
      baseBranch: baseBranch.value.trim() || undefined,
    })
    createdEnv.value = env
    emit('created', env)
    streaming.value = true
    await streamRun(env.id)
  } catch (e) {
    errMsg.value = (e as Error).message
  } finally {
    pending.value = false
  }
}

onBeforeUnmount(() => { abort?.abort() })

function close() { open.value = false }

/**
 * Abort an in-flight provisioning: stop reading the stream *and* tear the
 * half-provisioned env back down (coastd `rm`), distinct from "Run in
 * background" which deliberately keeps it provisioning. Best-effort —
 * coastd may already be mid-teardown; the row is removed regardless.
 */
async function cancelProvisioning() {
  if (!createdEnv.value || cancelling.value) return
  cancelling.value = true
  abort?.abort()
  try {
    await apiClient.envs.delete.call({ id: createdEnv.value.id })
  } catch { /* coastd unreachable / already gone — row drop still happens */ }
  cancelling.value = false
  emit('cancelled')
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Create environment"
    description="Provision a new Coast environment and git worktree."
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div v-if="!createdEnv" class="space-y-3">
        <UFormField label="Name" hint="Used as branch, worktree, and coast instance name">
          <UInput v-model="name" size="sm" placeholder="feature-x" />
        </UFormField>
        <UFormField label="Base branch" :hint="defaultBranch ? `Default: ${defaultBranch}` : ''">
          <UInput v-model="baseBranch" size="sm" :placeholder="defaultBranch ?? 'main'" />
        </UFormField>

        <p v-if="errMsg" class="text-sm text-error">
          {{ errMsg }}
        </p>

        <div class="flex justify-end gap-2 pt-2">
          <UButton size="sm" variant="ghost" :disabled="pending" @click="close">
            Cancel
          </UButton>
          <UButton size="sm" color="primary" :loading="pending" @click="submit">
            Create
          </UButton>
        </div>
      </div>

      <div v-else class="space-y-3">
        <p class="text-sm">
          <UIcon
            v-if="streaming"
            name="i-lucide-loader-circle"
            class="size-3.5 animate-spin inline mr-1.5"
          />
          <UIcon v-else name="i-lucide-check" class="size-3.5 inline mr-1.5 text-success" />
          {{ streaming ? `Provisioning ${createdEnv.name}…` : `${createdEnv.name} is ready.` }}
        </p>
        <DomoBuildSteps :steps="steps" />
        <p v-if="errMsg" class="text-sm text-error">
          {{ errMsg }}
        </p>
        <div class="flex justify-end gap-2">
          <UButton
            v-if="streaming"
            size="sm"
            color="error"
            variant="ghost"
            icon="i-lucide-x"
            :loading="cancelling"
            @click="cancelProvisioning"
          >
            Cancel
          </UButton>
          <UButton
            size="sm"
            :variant="streaming ? 'ghost' : 'solid'"
            :disabled="cancelling"
            @click="close"
          >
            {{ streaming ? 'Run in background' : 'Close' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

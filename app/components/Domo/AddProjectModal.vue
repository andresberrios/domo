<script setup lang="ts">
import type { Project } from '~~/server/lib/schemas'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ added: [project: Project] }>()

type Step = 'pick' | 'confirms' | 'error'
const step = ref<Step>('pick')
const pickedPath = ref<string | null>(null)
const pending = ref(false)
const errMsg = ref<string | null>(null)
const addedProject = ref<Project | null>(null)

// Step state — what's the latest response from projects.add?
type AddResp = Awaited<ReturnType<typeof apiClient.projects.add.call>>
const lastResp = ref<AddResp | null>(null)

// Confirms granted so far. Re-sent on each retry.
const confirms = reactive({
  confirmGitInit: false,
  confirmGitignoreAddWorktrees: false,
})

watch(open, (v) => {
  if (v) reset()
})

function reset() {
  step.value = 'pick'
  pickedPath.value = null
  pending.value = false
  errMsg.value = null
  addedProject.value = null
  lastResp.value = null
  confirms.confirmGitInit = false
  confirms.confirmGitignoreAddWorktrees = false
}

async function attemptAdd(): Promise<void> {
  if (!pickedPath.value) return
  pending.value = true
  errMsg.value = null
  try {
    const resp = await apiClient.projects.add.call({
      rootPath: pickedPath.value,
      ...confirms,
    })
    lastResp.value = resp
    if (resp.status === 'ok') {
      addedProject.value = resp.project
      emit('added', resp.project)
      // Devcontainer-based projects don't pre-build at add time — the
      // image gets built (or pulled + features applied) on the first
      // `devcontainer up` in env-create. Close the modal.
      open.value = false
    } else {
      step.value = 'confirms'
    }
  } catch (e) {
    errMsg.value = (e as Error).message
    step.value = 'error'
  } finally {
    pending.value = false
  }
}

function onPathSelected(p: string) {
  pickedPath.value = p
  attemptAdd()
}

function acceptCurrentPrompt() {
  if (!lastResp.value) return
  switch (lastResp.value.status) {
    case 'missing-git': confirms.confirmGitInit = true; break
    case 'missing-gitignore-worktrees': confirms.confirmGitignoreAddWorktrees = true; break
  }
  attemptAdd()
}

function cancelFlow() {
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{ content: 'max-w-2xl' }"
    title="Add project"
    description="Register any git repo as a Domo project. devcontainer.json is optional — a default is used if absent."
  >
    <template #body>
      <!-- Step 1: pick directory -->
      <DomoDirectoryPicker
        v-if="step === 'pick'"
        @select="onPathSelected"
        @cancel="cancelFlow"
      />

      <!-- Step 2: confirms -->
      <div v-else-if="step === 'confirms' && lastResp" class="space-y-4">
        <p class="text-sm text-muted">
          Selected: <code>{{ pickedPath }}</code>
        </p>

        <template v-if="lastResp.status === 'missing-git'">
          <p>
            This directory is not a git repository.
            <strong>Initialize one</strong> with <code>git init</code>?
          </p>
        </template>

        <template v-else-if="lastResp.status === 'missing-gitignore-worktrees'">
          <p>
            Domo puts per-env worktrees under <code>.worktrees/</code>.
            <strong>Add it to <code>.gitignore</code></strong>?
          </p>
        </template>

        <template v-else-if="lastResp.status === 'already-exists'">
          <p>This directory is already registered as a Domo project.</p>
        </template>

        <template v-else-if="lastResp.status === 'invalid-path'">
          <p class="text-error">
            {{ lastResp.reason }}
          </p>
        </template>

        <div class="flex justify-end gap-2">
          <UButton size="sm" variant="ghost" :disabled="pending" @click="cancelFlow">
            Cancel
          </UButton>
          <UButton
            v-if="lastResp.status === 'missing-git' || lastResp.status === 'missing-gitignore-worktrees'"
            size="sm"
            color="primary"
            :loading="pending"
            @click="acceptCurrentPrompt"
          >
            Yes, continue
          </UButton>
          <UButton
            v-else
            size="sm"
            color="primary"
            @click="cancelFlow"
          >
            Close
          </UButton>
        </div>
      </div>

      <!-- Error fallback -->
      <div v-else-if="step === 'error'" class="space-y-3">
        <p class="text-error text-sm">
          {{ errMsg }}
        </p>
        <div class="flex justify-end">
          <UButton size="sm" @click="cancelFlow">
            Close
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

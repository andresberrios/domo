<script setup lang="ts">
import type { DevEnvironment, EnvironmentBranchImport, EnvironmentBranches } from '~~/shared/types'

/**
 * The other direction from `ExportBranchModal`: a branch in the project's own
 * checkout, pushed into the environment. Deliberately the same shape, because
 * the two sit next to each other and the only thing a reader has to keep
 * straight is which way things move.
 */
const props = withDefaults(defineProps<{ environment: DevEnvironment, trigger?: boolean }>(), {
  trigger: true
})

/** Exposed so the sidebar's action menu can open this without the button. */
const open = defineModel<boolean>('open', { default: false })
const branches = ref<EnvironmentBranches>({ current: null, branches: [] })
const branch = ref('')
const from = ref('')
const loading = ref(false)
const submitting = ref(false)
const loadError = ref('')
const failure = ref('')
const result = ref<EnvironmentBranchImport | null>(null)

const running = computed(() => props.environment.status === 'running')
/**
 * Not a warning — this is the branch an import most often *wants*. Importing
 * into one the agent is not on is inert: nothing in the container tells it that
 * some other branch moved. Said out loud only because what happens next depends
 * on whether an agent is working, which the server decides.
 */
const isCheckedOut = computed(() =>
  !!branch.value.trim() && branch.value.trim() === branches.value.current)

/** What the import did, as one sentence and a colour. */
const outcome = computed(() => {
  const report = result.value
  if (!report) return null
  switch (report.result) {
    case 'fast-forwarded':
      return { color: 'success' as const, title: `${report.branch} fast-forwarded to ${report.sha.slice(0, 8)}` }
    case 'created':
      return { color: 'success' as const, title: `${report.branch} created at ${report.sha.slice(0, 8)}` }
    case 'up-to-date':
      return { color: 'neutral' as const, title: `${report.branch} was already up to date` }
    default:
      return { color: 'warning' as const, title: 'Nothing was sent' }
  }
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    branches.value = await $fetch(`/api/dev-environments/${props.environment.id}/branches`)
    // The branch the environment is on is the one an import usually means:
    // bringing it up to date after work landed here.
    branch.value = branches.value.current ?? branches.value.branches[0]?.name ?? ''
    from.value = branch.value
  } catch (error: any) {
    loadError.value = error?.data?.statusMessage ?? error?.message ?? 'Could not list the branches.'
  } finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  result.value = null
  failure.value = ''
  branches.value = { current: null, branches: [] }
  load()
})

// The host ref follows the environment's branch until it is edited; the two
// having the same name is what somebody wants almost every time.
watch(branch, (value, previous) => {
  if (from.value === previous) from.value = value
})

async function submit() {
  submitting.value = true
  failure.value = ''
  result.value = null
  try {
    result.value = await $fetch<EnvironmentBranchImport>(`/api/dev-environments/${props.environment.id}/import`, {
      method: 'POST',
      // Blank means the branch's own name: unlike an export there is no
      // "send nothing" mode to fall back to.
      body: { branch: branch.value.trim(), from: from.value.trim() || null }
    })
  } catch (error: any) {
    failure.value = error?.data?.statusMessage ?? error?.message ?? 'Could not import the branch.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UTooltip v-if="trigger" :text="running ? 'Send a branch from the project checkout into this environment.' : 'Start the environment first — the import writes to its container.'">
    <UButton
      label="Import branch"
      icon="i-lucide-git-branch-plus"
      size="xs"
      color="neutral"
      variant="soft"
      :disabled="!running"
      @click="open = true"
    />
  </UTooltip>

  <UModal
    v-model:open="open"
    title="Import branch"
    :description="`Sends a branch from the project’s own checkout on this machine into ${environment.name}, and fast-forwards the branch there onto it. Fast-forward only — nothing in the environment is ever rewritten or merged, and uncommitted work there is never written over.`"
  >
    <template #body>
      <div class="space-y-4">
        <UAlert v-if="loadError" color="error" variant="subtle" :title="loadError" />

        <UFormField label="Branch on this machine" hint="Defaults to the same name">
          <UInput v-model="from" :placeholder="branch || 'main'" class="w-full" />
        </UFormField>

        <UFormField label="Branch in the environment">
          <UInput v-model="branch" placeholder="main" class="w-full" />
          <template #help>
            <span v-if="loading" class="text-xs text-muted">Reading the environment’s branches…</span>
            <span v-else-if="branches.branches.length" class="text-xs text-muted">
              Already there:
              <span v-for="(entry, index) in branches.branches" :key="entry.name">
                <span v-if="index">, </span>
                <code>{{ entry.name }}</code><span v-if="entry.name === branches.current"> (checked out)</span>
              </span>
            </span>
            <span v-else class="text-xs text-muted">A name that is not there yet creates the branch.</span>
          </template>
        </UFormField>

        <UAlert
          v-if="isCheckedOut"
          color="neutral"
          variant="subtle"
          :title="`${environment.name} is on “${branch}”`"
          description="Its working tree will move with it, so the agent simply finds the new files. If an agent is mid-turn the branch lands beside it instead, and either way the agents there are told where the changes are. Uncommitted work in the environment stops the import rather than being written over."
        />

        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

        <UAlert
          v-else-if="result && outcome"
          :color="outcome.color"
          variant="subtle"
          :title="outcome.title"
        >
          <template #description>
            <div class="space-y-2">
              <p v-if="result.reason" class="text-sm">{{ result.reason }}</p>
              <p v-if="result.diverted" class="text-sm">{{ result.diverted }}</p>
              <p v-if="result.notified.length" class="text-xs text-muted">
                Told:
                <span v-for="(entry, index) in result.notified" :key="entry.agentSessionId">
                  <span v-if="index">, </span>{{ entry.title }}
                  <span class="text-dimmed">({{ entry.via === 'inbox' ? 'waiting in its inbox' : entry.via }})</span>
                </span>
              </p>
              <ul v-if="result.commits.length" class="space-y-1">
                <li v-for="commit in result.commits" :key="commit.sha" class="flex gap-2 text-xs">
                  <span class="font-mono text-dimmed">{{ commit.sha.slice(0, 8) }}</span>
                  <span class="truncate">{{ commit.subject }}</span>
                </li>
              </ul>
              <p v-else class="text-xs text-muted">No commits crossed.</p>
            </div>
          </template>
        </UAlert>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Close" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Import"
          icon="i-lucide-upload"
          :loading="submitting"
          :disabled="!branch.trim()"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>

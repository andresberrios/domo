<script setup lang="ts">
import type { BranchExport, DevEnvironment, EnvironmentBranches } from '~~/shared/types'

const props = defineProps<{ environment: DevEnvironment }>()

const open = ref(false)
const branches = ref<EnvironmentBranches>({ current: null, branches: [] })
const branch = ref('')
const into = ref('')
const loading = ref(false)
const submitting = ref(false)
const loadError = ref('')
const failure = ref('')
const result = ref<BranchExport | null>(null)

const running = computed(() => props.environment.status === 'running')
const branchItems = computed(() => branches.value.branches.map(entry => ({
  label: entry.name === branches.value.current ? `${entry.name} (checked out)` : entry.name,
  value: entry.name
})))

/** What the export did, as one sentence and a colour. */
const outcome = computed(() => {
  const report = result.value
  if (!report) return null
  const into = report.into
  switch (report.result) {
    case 'fast-forwarded':
      return { color: 'success' as const, title: `${into} fast-forwarded to ${report.sha.slice(0, 8)}` }
    case 'created':
      return { color: 'success' as const, title: `${into} created at ${report.sha.slice(0, 8)}` }
    case 'up-to-date':
      return { color: 'neutral' as const, title: into ? `${into} was already up to date` : 'Already up to date' }
    default:
      return { color: 'warning' as const, title: 'Fetched, but no branch was moved' }
  }
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    branches.value = await $fetch(`/api/dev-environments/${props.environment.id}/branches`)
    branch.value = branches.value.current ?? branches.value.branches[0]?.name ?? ''
    into.value = branch.value
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

// The host branch follows the container's until the export has been run; the
// two having the same name is what somebody wants almost every time.
watch(branch, (value, previous) => {
  if (into.value === previous) into.value = value
})

async function submit() {
  submitting.value = true
  failure.value = ''
  result.value = null
  try {
    result.value = await $fetch<BranchExport>(`/api/dev-environments/${props.environment.id}/export`, {
      method: 'POST',
      // Blank means "fetch it, but leave every local branch alone".
      body: { branch: branch.value, into: into.value.trim() || null }
    })
  } catch (error: any) {
    failure.value = error?.data?.statusMessage ?? error?.message ?? 'Could not export the branch.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UTooltip :text="running ? 'Bring a branch from this environment into the project checkout.' : 'Start the environment first — the export reads its container.'">
    <UButton
      label="Export branch"
      icon="i-lucide-git-branch"
      size="xs"
      color="neutral"
      variant="soft"
      :disabled="!running"
      @click="open = true"
    />
  </UTooltip>

  <UModal
    v-model:open="open"
    title="Export branch"
    :description="`Fetches a branch out of ${environment.name} into the project’s own checkout on this machine, and fast-forwards a local branch onto it. Nothing there is ever rewritten or merged.`"
  >
    <template #body>
      <div class="space-y-4">
        <UAlert v-if="loadError" color="error" variant="subtle" :title="loadError" />

        <UFormField label="Branch in the environment">
          <USelect
            v-model="branch"
            :items="branchItems"
            value-key="value"
            :loading="loading"
            :disabled="!branchItems.length"
            placeholder="No branches found"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Local branch" hint="Leave blank to fetch without touching a branch">
          <UInput v-model="into" :placeholder="branch || 'main'" class="w-full" />
          <template #help>
            <span class="text-xs text-muted">
              Fast-forward only. It always lands in
              <code>refs/remotes/domo-env/…</code> first, whatever happens to the local branch.
            </span>
          </template>
        </UFormField>

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
              <p class="font-mono text-xs text-dimmed">{{ result.ref }}</p>
              <ul v-if="result.commits.length" class="space-y-1">
                <li v-for="commit in result.commits" :key="commit.sha" class="flex gap-2 text-xs">
                  <span class="font-mono text-dimmed">{{ commit.sha.slice(0, 8) }}</span>
                  <span class="truncate">{{ commit.subject }}</span>
                </li>
              </ul>
              <p v-else class="text-xs text-muted">No commits came over.</p>
            </div>
          </template>
        </UAlert>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Close" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Export"
          icon="i-lucide-download"
          :loading="submitting"
          :disabled="!branch"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>

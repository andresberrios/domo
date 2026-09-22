<script setup lang="ts">
import type {
  DevEnvironment,
  EnvironmentBranchImport,
  EnvironmentBranches,
  ImportPlan
} from '~~/shared/types'

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
/**
 * What the server says it would do, from the same pure `planImport()` it will
 * run on. Refreshed as the branches are edited, because the outcome depends on
 * live state — is a turn running, is the tree dirty — and a button whose
 * behaviour cannot be predicted is one people are afraid to press.
 */
const plan = ref<ImportPlan | null>(null)
const planning = ref(false)

const running = computed(() => props.environment.status === 'running')

/** The plan in sentences, in the order they happen. */
const steps = computed<string[]>(() => {
  const preview = plan.value
  if (!preview) return []
  const lines: string[] = []
  if (preview.commitFirst) {
    const { total } = preview.commitFirst
    lines.push(`Commit ${total} uncommitted ${total === 1 ? 'file' : 'files'} in the environment first, `
      + 'so nothing is stashed or discarded.')
  }
  lines.push(preview.merge
    ? `Send "${preview.from}" to "${preview.branch}" and merge it into "${preview.checkedOut}".`
    : `Send "${preview.from}" to "${preview.branch}".`)
  if (preview.sideBranchReason === 'agent-mid-turn') {
    lines.push('An agent is mid-turn, so the working tree is left alone entirely.')
  }
  if (preview.merge) lines.push('If the merge conflicts, abort it and leave the commits on the side branch.')
  if (preview.notify.length) {
    lines.push(`Tell ${preview.notify.map(entry => entry.title).join(', ')} what happened.`)
  }
  if (preview.resolver) {
    lines.push(`Ask ${preview.resolver.title} — the most recently active — to merge anything left over. `
      + 'Only one, because they share a single checkout.')
  } else if (!preview.notify.length) {
    lines.push('No agent sessions are running here, so there is nobody to tell.')
  }
  return lines
})

async function refreshPlan() {
  const target = branch.value.trim()
  if (!target || !running.value) {
    plan.value = null
    return
  }
  planning.value = true
  try {
    plan.value = await $fetch<ImportPlan>(`/api/dev-environments/${props.environment.id}/import-plan`, {
      method: 'POST',
      body: { branch: target, from: from.value.trim() || null }
    })
  } catch {
    // A preview that cannot be taken is not worth an error of its own; the
    // import itself reports properly if it fails too.
    plan.value = null
  } finally {
    planning.value = false
  }
}

/** What the import did, as one sentence and a colour. */
const outcome = computed(() => {
  const report = result.value
  if (!report) return null
  switch (report.result) {
    case 'merged':
      return { color: 'success' as const, title: `Merged into ${report.requested}` }
    case 'fast-forwarded':
      return { color: 'success' as const, title: `${report.branch} fast-forwarded to ${report.sha.slice(0, 8)}` }
    case 'created':
      return { color: 'success' as const, title: `${report.branch} created at ${report.sha.slice(0, 8)}` }
    case 'up-to-date':
      return { color: 'neutral' as const, title: `${report.requested} was already up to date` }
    default:
      return { color: 'warning' as const, title: report.wip ? 'Not merged' : 'Nothing was sent' }
  }
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    branches.value = await $fetch(`/api/dev-environments/${props.environment.id}/branches`)
    // The branch the environment is on is the one an import usually means:
    // bringing it up to date after work landed here.
    // Assigning these is what asks for the plan, through the watcher below.
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
  plan.value = null
  failure.value = ''
  branches.value = { current: null, branches: [] }
  // Cleared so that `load()` assigning the same branch name as last time is
  // still a change, and still asks for a fresh plan: the answer depends on
  // what the environment is doing now, not on what it was doing then.
  branch.value = ''
  from.value = ''
  load()
})

// The host ref follows the environment's branch until it is edited; the two
// having the same name is what somebody wants almost every time.
watch(branch, (value, previous) => {
  if (from.value === previous) from.value = value
})

watch([branch, from], () => {
  result.value = null
  refreshPlan()
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
    :description="`Sends a branch from the project’s own checkout on this machine into ${environment.name}. Nothing there is ever rewritten, force-updated or discarded: uncommitted work is committed before anything else happens, so it stays recoverable.`"
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

        <!--
          What will happen, before it happens. The outcome depends on live state
          — is a turn running, is the tree dirty — so a button whose behaviour
          cannot be predicted is one people are afraid to press. Rendered from
          the same plan the server executes, never from a guess made here.
        -->
        <div v-if="planning && !plan" class="text-xs text-muted">Working out what this would do…</div>
        <UAlert
          v-else-if="plan"
          color="neutral"
          variant="subtle"
          :title="plan.merge
            ? `Will merge into “${plan.checkedOut}”, the branch ${environment.name} is on`
            : `Will land on “${plan.branch}”`"
        >
          <template #description>
            <ol class="mt-1 space-y-1 text-sm">
              <li v-for="(step, index) in steps" :key="index" class="flex gap-2">
                <span class="text-dimmed">{{ index + 1 }}.</span>
                <span>{{ step }}</span>
              </li>
            </ol>
            <p v-if="plan.commitFirst?.paths.length" class="mt-2 text-xs text-muted">
              <span v-for="(path, index) in plan.commitFirst.paths" :key="path">
                <span v-if="index">, </span><code>{{ path }}</code>
              </span>
              <span v-if="plan.commitFirst.total > plan.commitFirst.paths.length">
                and {{ plan.commitFirst.total - plan.commitFirst.paths.length }} more
              </span>
            </p>
          </template>
        </UAlert>

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
              <p v-if="result.wip" class="text-sm">
                Uncommitted work in the environment was committed first, as
                <code>{{ result.wip.slice(0, 8) }}</code> — nothing was stashed or discarded.
              </p>
              <p v-if="result.resolver" class="text-sm">
                {{ result.resolver.title }} was asked to merge it — one session only, because they all
                share the environment's single checkout.
              </p>
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

<script setup lang="ts">
import { branchOnRetirement, describeBranchOutcome } from '~~/shared/dev-environments'
import type { DevEnvironment } from '~~/shared/types'

/**
 * One dev environment in the tree.
 *
 * The name links to the environment's page and the chevron only toggles the
 * agent list — two separate controls, because a row that is both a link and a
 * disclosure can be neither reliably. The open state belongs to the tree, so it
 * arrives as a prop and leaves as an event.
 */
const props = defineProps<{
  environment: DevEnvironment
  expanded: boolean
  agentCount: number
  /** What the row shows: the last segment of the name inside its folder. The full name is its tooltip. */
  label?: string
}>()

const emit = defineEmits<{ toggle: [], newAgent: [] }>()

const toast = useToast()
const busy = ref(false)
const renaming = ref(false)
const confirmingRetire = ref(false)

const { href: vscodeHref } = useVsCodeHref(() => props.environment)
const retired = computed(() => !!props.environment.retiredAt)
const running = computed(() => props.environment.status === 'running')

function report(error: any, failure: string) {
  toast.add({ title: failure, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
}

async function lifecycle(action: 'start' | 'stop') {
  busy.value = true
  try {
    await $fetch(`/api/dev-environments/${props.environment.id}/${action}`, { method: 'POST' })
  } catch (error: any) {
    report(error, `Could not ${action} the environment`)
  } finally {
    busy.value = false
  }
}

async function rename(name: string) {
  renaming.value = false
  busy.value = true
  try {
    await $fetch(`/api/dev-environments/${props.environment.id}`, { method: 'PATCH', body: { name } })
  } catch (error: any) {
    report(error, 'Could not rename the environment')
  } finally {
    busy.value = false
  }
}

async function retire() {
  confirmingRetire.value = false
  busy.value = true
  try {
    const result = await $fetch(`/api/dev-environments/${props.environment.id}`, { method: 'DELETE' })
    toast.add(result.leftovers.length
      ? { title: 'Environment retired, but not everything could be removed', description: result.leftovers[0]!.error, color: 'warning' }
      : { title: `${props.environment.name} retired`, description: describeBranchOutcome(result.branch) || 'Its records stay readable.', color: 'neutral' })
  } catch (error: any) {
    report(error, 'Could not retire the environment')
  } finally {
    busy.value = false
  }
}

// A retired environment has no container behind it, so it offers nothing but
// its name: every other entry here would be a call into something that is gone.
const items = computed(() => retired.value
  ? [[{ label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } }]]
  : [
      [
        { label: 'New agent here', icon: 'i-lucide-plus', onSelect: () => emit('newAgent') }
      ],
      [
        running.value
          ? { label: 'Stop', icon: 'i-lucide-square', onSelect: () => lifecycle('stop') }
          : { label: 'Start', icon: 'i-lucide-play', onSelect: () => lifecycle('start') },
        // A link, not a button: the menu item carries the `vscode://` URL itself.
        { label: 'Open in VS Code', icon: 'i-lucide-code-xml', to: vscodeHref.value, target: '_self', disabled: !vscodeHref.value },
        { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } }
      ],
      [
        { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
      ]
    ])
</script>

<template>
  <div :class="ROW_CLASS">
    <SidebarDisclosure
      :expanded="expanded"
      :label="environment.name"
      :empty="!agentCount"
      @toggle="emit('toggle')"
    />

    <NuxtLink
      :to="`/environments/${environment.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-sm"
      active-class="row-active"
      :title="environment.name"
    >
      <EnvironmentIcon :status="environment.status" />
      <span class="min-w-0 flex-1 truncate" :class="retired ? 'text-dimmed' : ''">{{ label ?? environment.name }}</span>
    </NuxtLink>

    <span v-if="agentCount && !expanded" class="px-1 text-xs tabular-nums text-dimmed" :class="ROW_BADGE_CLASS">
      {{ agentCount }}
    </span>

    <UButton
      v-if="!retired"
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`New agent in ${environment.name}`"
      :class="ROW_QUICK_ACTION_CLASS"
      @click="emit('newAgent')"
    />

    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="busy"
        :aria-label="`Actions for ${environment.name}`"
        :class="ROW_MENU_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="renaming"
      title="Rename environment"
      description="Changes the name shown in Domo, and the folder it is grouped in. The container, its worktree and its branch keep the names they were created with."
      :initial="environment.name"
      @submit="rename"
    />

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${environment.name}?`"
      :description="`Destroys the container, its worktree and any Docker-in-Docker volume, so uncommitted work in it is lost. ${branchOnRetirement(environment)} The records are kept — this environment and the full transcript of every coding agent that ran in it stay readable — but those agents can never be started again.`"
      confirm-label="Retire environment"
      :loading="busy"
      @confirm="retire"
    />
  </div>
</template>

<script setup lang="ts">
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
}>()

const emit = defineEmits<{ toggle: [], newAgent: [] }>()

const toast = useToast()
const busy = ref(false)
const exporting = ref(false)
const importing = ref(false)
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
    await $fetch(`/api/dev-environments/${props.environment.id}`, { method: 'DELETE' })
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
        { label: 'Export branch', icon: 'i-lucide-git-branch', disabled: !running.value, onSelect: () => { exporting.value = true } },
        // Labelled by direction, beside its opposite: "out of" and "into" are the
        // only thing that tells these two apart at a glance.
        { label: 'Import branch', icon: 'i-lucide-git-branch-plus', disabled: !running.value, onSelect: () => { importing.value = true } },
        { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } }
      ],
      [
        { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
      ]
    ])
</script>

<template>
  <div class="group flex items-center gap-0.5 rounded-md pe-1 hover:bg-elevated has-[a.row-active]:bg-elevated has-[a.row-active]:font-medium">
    <UButton
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="ghost"
      size="xs"
      class="shrink-0"
      :ui="{ leadingIcon: ['transition-transform', expanded ? 'rotate-90' : ''] }"
      :aria-expanded="expanded"
      :aria-label="expanded ? `Collapse ${environment.name}` : `Expand ${environment.name}`"
      @click="emit('toggle')"
    />

    <NuxtLink
      :to="`/environments/${environment.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-sm"
      active-class="row-active"
    >
      <EnvironmentIcon :status="environment.status" />
      <span class="min-w-0 flex-1 truncate">{{ environment.name }}</span>
    </NuxtLink>

    <UBadge
      v-if="agentCount"
      size="sm"
      color="neutral"
      variant="subtle"
      :label="agentCount"
      :class="ROW_BADGE_CLASS"
    />

    <UButton
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`New agent in ${environment.name}`"
      :class="ROW_ACTIONS_CLASS"
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
        :class="ROW_ACTIONS_CLASS"
      />
    </UDropdownMenu>

    <ExportBranchModal v-model:open="exporting" :environment="environment" :trigger="false" />

    <ImportBranchModal v-model:open="importing" :environment="environment" :trigger="false" />

    <RenameModal
      v-model:open="renaming"
      title="Rename environment"
      description="Changes the name shown in Domo. The container and its volume keep the names they were created with."
      :initial="environment.name"
      @submit="rename"
    />

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${environment.name}?`"
      description="Destroys the container, its copy of the checkout and any Docker-in-Docker volume. The records are kept — this environment and the full transcript of every coding agent that ran in it stay readable — but those agents can never be started again, and work that has not been pushed or exported is lost."
      confirm-label="Retire environment"
      :loading="busy"
      @confirm="retire"
    />
  </div>
</template>

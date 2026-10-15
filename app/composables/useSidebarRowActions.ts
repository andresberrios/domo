import { branchOnRetirement, describeBranchOutcome } from '~~/shared/dev-environments'
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * What a sidebar row's "…" menu does, apart from the row that shows it: an
 * environment with one session is a single row whose menu carries both sets
 * (`SidebarEnvironmentAgentRow`), and the separate rows carry one each.
 * The modals these open are the row's own, bound to `renaming` and
 * `confirmingRetire`.
 */

function report(toast: ReturnType<typeof useToast>, error: any, failure: string) {
  toast.add({ title: failure, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
}

export function useAgentRowActions(agent: MaybeRefOrGetter<AgentSession>) {
  const toast = useToast()
  const renaming = ref(false)
  const busy = ref(false)

  async function patch(body: Record<string, unknown>, failure: string) {
    busy.value = true
    try {
      await $fetch(`/api/agents/${toValue(agent).id}`, { method: 'PATCH', body })
    } catch (error: any) {
      report(toast, error, failure)
    } finally {
      busy.value = false
    }
  }

  async function rename(title: string) {
    renaming.value = false
    await patch({ title }, 'Could not rename the agent')
  }

  async function archive() {
    // The row leaves the tree unless "Show archived" is on, and its
    // transcript is kept either way.
    const archived = toValue(agent).archived
    await patch({ archived: !archived }, archived ? 'Could not unarchive the agent' : 'Could not archive the agent')
  }

  async function stop() {
    busy.value = true
    try {
      await $fetch(`/api/agents/${toValue(agent).id}/cancel`, { method: 'POST' })
    } catch (error: any) {
      report(toast, error, 'Could not stop the turn')
    } finally {
      busy.value = false
    }
  }

  /** One group. `qualified` names what it acts on, for a menu that also acts on the environment. */
  function items(qualified = false) {
    return [
      { label: qualified ? 'Rename session' : 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } },
      { label: 'Stop the turn', icon: 'i-lucide-square', onSelect: () => stop() },
      toValue(agent).archived
        ? { label: 'Unarchive', icon: 'i-lucide-archive-restore', onSelect: () => archive() }
        : { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => archive() }
    ]
  }

  return { busy, renaming, rename, items }
}

export function useEnvironmentRowActions(environment: MaybeRefOrGetter<DevEnvironment>, newAgent: () => void) {
  const toast = useToast()
  const busy = ref(false)
  const renaming = ref(false)
  const confirmingRetire = ref(false)

  const { href: vscodeHref } = useVsCodeHref(environment)
  const retired = computed(() => !!toValue(environment).retiredAt)
  const running = computed(() => toValue(environment).status === 'running')

  async function lifecycle(action: 'start' | 'stop') {
    busy.value = true
    try {
      await $fetch(`/api/dev-environments/${toValue(environment).id}/${action}`, { method: 'POST' })
    } catch (error: any) {
      report(toast, error, `Could not ${action} the environment`)
    } finally {
      busy.value = false
    }
  }

  async function rename(name: string) {
    renaming.value = false
    busy.value = true
    try {
      await $fetch(`/api/dev-environments/${toValue(environment).id}`, { method: 'PATCH', body: { name } })
    } catch (error: any) {
      report(toast, error, 'Could not rename the environment')
    } finally {
      busy.value = false
    }
  }

  async function retire() {
    confirmingRetire.value = false
    busy.value = true
    const { id, name } = toValue(environment)
    try {
      const result = await $fetch(`/api/dev-environments/${id}`, { method: 'DELETE' })
      toast.add(result.leftovers.length
        ? { title: 'Environment retired, but not everything could be removed', description: result.leftovers[0]!.error, color: 'warning' }
        : { title: `${name} retired`, description: describeBranchOutcome(result.branch) || 'Its records stay readable.', color: 'neutral' })
    } catch (error: any) {
      report(toast, error, 'Could not retire the environment')
    } finally {
      busy.value = false
    }
  }

  const retireDescription = computed(() => `Destroys the container, its worktree and everything it made in Docker, so uncommitted work in it is lost. ${branchOnRetirement(toValue(environment))} The records are kept — this environment and the full transcript of every coding agent that ran in it stay readable — but those agents can never be started again.`)

  // A retired environment has no container behind it, so it offers nothing but
  // its name: every other entry here would be a call into something that is gone.
  /** `qualified` names what each acts on, for a menu that also acts on a session. */
  function items(qualified = false) {
    const what = qualified ? ' environment' : ''
    const renameItem = { label: `Rename${what}`, icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } }
    return retired.value
      ? [[renameItem]]
      : [
          [
            { label: 'New session here', icon: 'i-lucide-plus', onSelect: newAgent }
          ],
          [
            running.value
              ? { label: `Stop${what}`, icon: 'i-lucide-square', onSelect: () => lifecycle('stop') }
              : { label: `Start${what}`, icon: 'i-lucide-play', onSelect: () => lifecycle('start') },
            // A link, not a button: the menu item carries the `vscode://` URL itself.
            { label: 'Open in VS Code', icon: 'i-lucide-code-xml', to: vscodeHref.value, target: '_self', disabled: !vscodeHref.value },
            renameItem
          ],
          [
            { label: `Retire${what}`, icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
          ]
        ]
  }

  return { busy, renaming, confirmingRetire, retired, rename, retire, retireDescription, items }
}

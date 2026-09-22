import type { DevEnvironment } from '~~/shared/types'

/**
 * The "Open in VS Code" target for an environment.
 *
 * Extracted from `OpenInVsCode.vue` so the sidebar's action menu can offer the
 * same link without nesting a button inside one: the menu item needs the URL,
 * not the button. The settings fetch is keyed, so every caller on a page shares
 * one request.
 */
export function useVsCodeHref(environment: MaybeRefOrGetter<DevEnvironment | null | undefined>) {
  const { data: settings } = useFetch('/api/settings', { key: 'settings', lazy: true })

  const ready = computed(() => {
    const value = toValue(environment)
    return !!value && value.status === 'running' && !!value.containerName?.trim()
  })

  const href = computed(() => {
    const value = toValue(environment)
    if (!ready.value || !value) return undefined
    try {
      return vscodeAttachUri({
        containerName: value.containerName,
        workspacePath: value.workspacePath,
        sshHost: settings.value?.vscodeSshHost
      })
    } catch {
      // A workspace path that is not absolute is a broken environment, not a crash.
      return undefined
    }
  })

  const tooltip = computed(() => ready.value
    ? 'Attaches VS Code to the container. Needs the "Dev Containers" extension.'
    : 'Start the environment first — VS Code attaches to a running container.')

  return { href, ready, tooltip }
}

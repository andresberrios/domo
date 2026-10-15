/**
 * Reloading an open tab onto a new build of Domo, at a moment that loses
 * nothing. The composer keeps its own draft; what a reload would cut off is
 * asked here.
 */

/** The id of the build the server serves now: Nuxt's app manifest, never from a cache. */
export async function fetchLatestBuildId(app: { baseURL: string, buildAssetsDir: string }): Promise<string | null> {
  const url = `${app.baseURL}/${app.buildAssetsDir}/builds/latest.json`.replace(/\/{2,}/g, '/')
  const latest = await $fetch<{ id?: string }>(`${url}?${Date.now()}`)
  return latest?.id ?? null
}

/** Things a reload must wait for: a recording, speech being played. One key per holder. */
const holds = reactive(new Set<symbol>())

/** Holds off the reload for as long as `active` says, and lets go with the scope. */
export function holdReload(active: () => boolean): void {
  const key = Symbol('reload-hold')
  watchEffect(() => {
    if (active()) holds.add(key)
    else holds.delete(key)
  })
  onScopeDispose(() => holds.delete(key))
}

export function reloadHeld(): boolean {
  return holds.size > 0
}

const FIELDS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable="true"]'

/**
 * An open dialog (modal or slideover) with something typed into it. A form
 * filled in from a saved record counts too: there is no telling which edits
 * were made, so the person decides.
 */
export function dialogHasInput(root: ParentNode = document): boolean {
  for (const dialog of root.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    for (const field of dialog.querySelectorAll<HTMLElement>(FIELDS)) {
      const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value
        : field.textContent ?? ''
      if (value.trim()) return true
    }
  }
  return false
}

export type ReloadMoment = 'now' | 'wait' | 'ask'

/** What to do about a new build right now. */
export function reloadMoment({ held, dialogInput }: { held: boolean, dialogInput: boolean }): ReloadMoment {
  if (held) return 'wait'
  if (dialogInput) return 'ask'
  return 'now'
}

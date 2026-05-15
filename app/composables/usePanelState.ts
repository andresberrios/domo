/**
 * Boolean panel-visibility state (right panel, bottom terminal) persisted
 * server-side in the `settings` table so the layout survives reloads and
 * is the same across devices. Optimistic: the ref starts at `def`, then
 * rehydrates from the server, then writes back on every change.
 */
export function usePanelState(key: string, def: boolean): Ref<boolean> {
  const settingKey = `panel:${key}`
  const state = useState(`panelState:${key}`, () => def)
  const wired = useState(`panelState:${key}:wired`, () => false)

  if (import.meta.client && !wired.value) {
    wired.value = true
    apiClient.settings.get
      .call({ key: settingKey })
      .then((r) => {
        if (r.value === '0' || r.value === '1') state.value = r.value === '1'
      })
      .catch(() => {})
    watch(state, (v) => {
      apiClient.settings.set
        .call({ key: settingKey, value: v ? '1' : '0' })
        .catch(() => {})
    })
  }

  return state
}

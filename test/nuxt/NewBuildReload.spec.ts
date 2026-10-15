import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { computed, effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NewBuildReload from '~/components/NewBuildReload.vue'
import { dialogHasInput, holdReload, reloadMoment } from '~/utils/newBuild'

const reload = vi.hoisted(() => vi.fn())
mockNuxtImport('reloadNuxtApp', () => reload)

const toasts = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }))
mockNuxtImport('useToast', () => () => toasts)

const updateRow = ref<{ state: string, installedCommit: string } | null>(null)
mockNuxtImport('useAppUpdate', () => () => ({ update: computed(() => updateRow.value), headline: computed(() => null) }))

let latestId = ''
let fetches = 0
// The test runtime answers `builds/latest.json` itself, with its own build.
mockNuxtImport('fetchLatestBuildId', () => async () => {
  fetches++
  return latestId
})

const mounted: { unmount: () => void }[] = []
async function mount() {
  const component = await mountSuspended(NewBuildReload)
  mounted.push(component)
  return component
}

function becomeVisible() {
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Lets the fetch answer and the decision timer run. */
async function settle(ms = 5_000) {
  for (let i = 0; i < 10; i++) await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
  reload.mockClear()
  toasts.add.mockClear()
  toasts.remove.mockClear()
  updateRow.value = null
  latestId = 'build-new'
  fetches = 0
})

afterEach(() => {
  for (const component of mounted.splice(0)) component.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('reloading onto a new build', () => {
  it('does nothing while the server serves the build this tab runs', async () => {
    latestId = useRuntimeConfig().app.buildId
    await mount()
    becomeVisible()
    await settle()
    expect(fetches).toBe(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads by itself, with a brief notice, when nothing would be lost', async () => {
    await mount()
    becomeVisible()
    await settle()
    expect(toasts.add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Reloading for the new version…' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks instead while a dialog has something typed into it, and reloads once it is gone', async () => {
    document.body.innerHTML = '<div role="dialog"><input value="half a name"></div>'
    await mount()
    becomeVisible()
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(toasts.add).toHaveBeenCalledTimes(1)
    const notice = toasts.add.mock.calls[0]![0]
    expect(notice).toMatchObject({ title: 'Domo was updated', duration: 0 })
    notice.actions[0].onClick()
    expect(reload).toHaveBeenCalledTimes(1)

    reload.mockClear()
    document.body.innerHTML = ''
    await settle()
    // The person chose already; the dialog closing does not reload twice.
    expect(reload).not.toHaveBeenCalled()
  })

  it('waits for the voice to finish', async () => {
    const speaking = ref(true)
    const scope = effectScope()
    scope.run(() => holdReload(() => speaking.value))
    await mount()
    becomeVisible()
    await settle()
    expect(reload).not.toHaveBeenCalled()

    speaking.value = false
    await settle()
    expect(reload).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('asks every few seconds while the server restarts for an update', async () => {
    latestId = useRuntimeConfig().app.buildId
    updateRow.value = { state: 'ready', installedCommit: 'aaa' }
    await mount()
    updateRow.value = { state: 'restarting', installedCommit: 'aaa' }
    await settle(10_000)
    expect(fetches).toBeGreaterThanOrEqual(3)
    expect(reload).not.toHaveBeenCalled()

    latestId = 'build-new'
    await settle()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('checks after a chunk failed to load', async () => {
    await mount()
    await useNuxtApp().hooks.callHook('app:chunkError', { error: new Error('Failed to fetch dynamically imported module') })
    await settle()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the moment to reload', () => {
  it('counts only a dialog with something typed', () => {
    document.body.innerHTML = '<div role="dialog"><input value=""><input type="checkbox" checked></div><textarea>outside</textarea>'
    expect(dialogHasInput()).toBe(false)
    document.body.innerHTML = '<div role="dialog"><textarea>a prompt</textarea></div>'
    expect(dialogHasInput()).toBe(true)
  })

  it('waits for a hold before anything else', () => {
    expect(reloadMoment({ held: true, dialogInput: true })).toBe('wait')
    expect(reloadMoment({ held: false, dialogInput: true })).toBe('ask')
    expect(reloadMoment({ held: false, dialogInput: false })).toBe('now')
  })
})

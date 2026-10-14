const SELECTED_KEY = 'domo:agent-voice:input-device'

export interface AudioInputOption {
  /** '' is the system's default, whichever device that is at the moment. */
  deviceId: string
  label: string
}

/** Chrome lists the system's default and the communications device again under these ids. */
const ALIASES = new Set(['default', 'communications'])

const devices = ref<Array<{ deviceId: string, label: string }>>([])
const selected = ref('')
let started = false

async function refresh() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    devices.value = all
      .filter(device => device.kind === 'audioinput')
      .map(device => ({ deviceId: device.deviceId, label: device.label }))
  } catch {
    devices.value = []
  }
}

/**
 * The microphones this browser has, as it names them, and the one chosen for
 * the voice bar on this device (kept in the browser: a deviceId means nothing
 * on another one). Shared by the bar, its quick settings and Settings, and
 * refreshed when a device comes or goes.
 *
 * A browser names its devices only once the page has been allowed the
 * microphone; before that `named` is false and `allow` asks.
 */
export function useAudioInputs() {
  if (import.meta.client && !started) {
    started = true
    try {
      selected.value = window.localStorage.getItem(SELECTED_KEY) ?? ''
    } catch {
      /* private mode */
    }
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', () => void refresh())
      void refresh()
    }
  }

  const named = computed(() => devices.value.some(device => device.label))

  const options = computed<AudioInputOption[]>(() => {
    // Chrome's "default" entry names the device it stands for.
    const systemDefault = devices.value.find(device => device.deviceId === 'default')?.label.replace(/^Default - /, '')
    const real = devices.value.filter(device => device.deviceId && !ALIASES.has(device.deviceId))
    const list: AudioInputOption[] = [
      { deviceId: '', label: systemDefault ? `System default (${systemDefault})` : 'System default' },
      ...real.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
    ]
    // A chosen device that is not plugged in stays chosen, for when it is back.
    if (selected.value && named.value && !real.some(device => device.deviceId === selected.value)) {
      list.push({ deviceId: selected.value, label: 'The chosen microphone (not connected)' })
    }
    return list
  })

  function select(deviceId: string) {
    selected.value = deviceId
    try {
      window.localStorage.setItem(SELECTED_KEY, deviceId)
    } catch {
      /* private mode */
    }
  }

  /** Ask for the microphone once, only so the browser names its devices. From a tap. */
  async function allow(): Promise<string | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())
      await refresh()
      return null
    } catch (error) {
      return microphoneError(error)
    }
  }

  return { options, selected, named, refresh, select, allow }
}

/**
 * What to tell someone whose microphone would not open, by what the browser
 * threw. The browser's own message alone is often empty (an
 * OverconstrainedError has none) or says "denied" when the system is what
 * refused.
 */
export function microphoneError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? ''
  const message = (error as { message?: string })?.message ?? String(error)
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return /system/i.test(message)
        ? 'The system will not let this browser use the microphone. On a Mac: System Settings, Privacy & Security, Microphone, turn the browser on, then quit and reopen it.'
        : 'The browser blocked the microphone for this page. Allow it from the icon at the left of the address bar, then tap again.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Plug one in, or check the system\'s sound input.'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return `The microphone is there but would not start${message ? ` (${message})` : ''}. Another app may be holding it; close it, or pick another microphone.`
    case 'OverconstrainedError':
      return 'The chosen microphone is not available. Pick another one in the voice settings.'
    case 'SecurityError':
      return 'This page may not use the microphone. Open Domo at its https:// address.'
    case 'TypeError':
      if (!navigator.mediaDevices) return 'This page cannot reach a microphone: browsers allow it only on https:// or localhost. Open Domo at its https:// address.'
  }
  return `Could not open the microphone: ${name ? `${name}: ` : ''}${message || 'no reason given'}`
}

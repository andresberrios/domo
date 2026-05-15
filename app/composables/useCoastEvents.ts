import type { CoastEvent } from '~~/server/lib/coast/types'

/**
 * Singleton WebSocket subscription to `/api/coast-events` (which itself
 * tails coastd's `/api/v1/events`). One connection per browser tab —
 * components register handlers and they fan out from the singleton.
 *
 * Frames that don't pass the `CoastEvent` discriminator are dropped
 * (logged at debug). Reconnect is intentionally simple: we close on
 * unmount of the *last* listener, and re-open on the next subscribe.
 */
type Handler = (event: CoastEvent) => void

interface CoastEventsState {
  ws: WebSocket | null
  listeners: Set<Handler>
  connected: boolean
}

// SPA mode — single shared singleton per browser tab.
const state: CoastEventsState = {
  ws: null,
  listeners: new Set<Handler>(),
  connected: false,
}

function getState(): CoastEventsState { return state }

function ensureConnected(state: CoastEventsState): void {
  if (state.ws && state.ws.readyState <= 1) return
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/coast-events`
  const ws = new WebSocket(url)
  state.ws = ws
  ws.addEventListener('open', () => { state.connected = true })
  ws.addEventListener('close', () => { state.connected = false; state.ws = null })
  ws.addEventListener('message', (ev) => {
    let raw: unknown
    try { raw = JSON.parse(String(ev.data)) } catch { return }
    const e = raw as CoastEvent
    if (!e || typeof (e as { event?: unknown }).event !== 'string') return
    for (const fn of state.listeners) {
      try { fn(e) } catch { /* swallow */ }
    }
  })
}

function maybeDisconnect(state: CoastEventsState): void {
  if (state.listeners.size === 0 && state.ws) {
    try { state.ws.close() } catch { /* ignore */ }
    state.ws = null
  }
}

export function useCoastEvents(handler: Handler): { connected: Ref<boolean> } {
  const state = getState()
  const connected = ref(false)
  state.listeners.add(handler)
  ensureConnected(state)
  onScopeDispose(() => {
    state.listeners.delete(handler)
    maybeDisconnect(state)
  })
  connected.value = state.connected
  // Simple sync via an interval is enough for the indicator badge; <1Hz events.
  const t = setInterval(() => { connected.value = state.connected }, 1000)
  onScopeDispose(() => clearInterval(t))
  return { connected }
}

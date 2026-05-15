/**
 * WS pass-through for coastd's `/api/v1/events` stream.
 *
 * One upstream WS to coastd is opened per connected peer (cheap; coastd
 * accepts many concurrent listeners). Frames are forwarded as-is — the
 * client-side composable validates them against the `CoastEvent` schema.
 */
const upstreams = new WeakMap<object, WebSocket>()

export default defineWebSocketHandler({
  open(peer) {
    const config = useRuntimeConfig()
    const wsUrl = `${(config.coastApiUrl as string).replace(/^http/, 'ws')}/api/v1/events`
    const upstream = new WebSocket(wsUrl)
    upstreams.set(peer, upstream)
    upstream.addEventListener('message', (e: MessageEvent) => {
      try { peer.send(String(e.data)) } catch { /* peer gone */ }
    })
    upstream.addEventListener('close', () => {
      try { peer.close() } catch { /* already closed */ }
    })
    upstream.addEventListener('error', () => {
      try { peer.close() } catch { /* already closed */ }
    })
  },
  close(peer) {
    const u = upstreams.get(peer)
    if (u) {
      try { u.close() } catch { /* already closed */ }
    }
    upstreams.delete(peer)
  },
})

/**
 * WS pass-through for an interactive shell *inside* the selected env's
 * Coast instance — `coast exec <env>` over a websocket.
 *
 * Client connects to `WS /api/terminal?envId=<id>`. We resolve the env →
 * `{ project, coastInstanceName }` and proxy to coastd's
 * `WS /api/v1/exec/interactive?project=…&name=…`. The frame protocol is
 * coastd's own (first frame `{ session_id }` JSON, then raw PTY text;
 * client sends keystrokes as text, resize as `\x01`+JSON, clear as
 * `\x02clear`) — the proxy stays dumb and forwards both directions
 * verbatim, exactly like `coast-events.ts`. The xterm component on the
 * client speaks that protocol directly.
 */
import { getEnv } from '../lib/envs'
import { getProject } from '../lib/projects'

interface Conn {
  upstream: WebSocket
  /** Buffer client→coastd frames sent before the upstream is OPEN. */
  pending: (string | ArrayBufferLike)[]
}

const conns = new WeakMap<object, Conn>()

function envIdFromPeer(peer: { request?: { url?: string } }): string | null {
  const raw = peer.request?.url
  if (!raw) return null
  try {
    return new URL(raw, 'http://localhost').searchParams.get('envId')
  } catch {
    return null
  }
}

export default defineWebSocketHandler({
  open(peer) {
    const envId = envIdFromPeer(peer)
    if (!envId) {
      try { peer.send('envId query param is required\r\n') } catch { /* gone */ }
      peer.close()
      return
    }
    const env = getEnv(envId)
    const project = env ? getProject(env.projectId) : null
    if (!env || !project) {
      try { peer.send('env or project not found\r\n') } catch { /* gone */ }
      peer.close()
      return
    }

    const config = useRuntimeConfig()
    const qs = new URLSearchParams({
      project: project.name,
      name: env.coastInstanceName,
    })
    const wsUrl = `${(config.coastApiUrl as string).replace(/^http/, 'ws')}/api/v1/exec/interactive?${qs}`

    const upstream = new WebSocket(wsUrl)
    const conn: Conn = { upstream, pending: [] }
    conns.set(peer, conn)

    upstream.addEventListener('open', () => {
      for (const m of conn.pending) {
        try { upstream.send(m) } catch { /* upstream gone */ }
      }
      conn.pending = []
    })
    upstream.addEventListener('message', (e: MessageEvent) => {
      try { peer.send(e.data as string) } catch { /* peer gone */ }
    })
    upstream.addEventListener('close', () => {
      try { peer.close() } catch { /* already closed */ }
    })
    upstream.addEventListener('error', () => {
      try { peer.send('\r\n[coast exec connection error]\r\n') } catch { /* gone */ }
      try { peer.close() } catch { /* already closed */ }
    })
  },

  message(peer, message) {
    const conn = conns.get(peer)
    if (!conn) return
    const data: string | ArrayBufferLike =
      typeof message.rawData === 'string' ? message.rawData : message.text()
    if (conn.upstream.readyState === 1 /* OPEN */) {
      try { conn.upstream.send(data) } catch { /* upstream gone */ }
    } else {
      conn.pending.push(data)
    }
  },

  close(peer) {
    const conn = conns.get(peer)
    if (conn) {
      try { conn.upstream.close() } catch { /* already closed */ }
    }
    conns.delete(peer)
  },
})

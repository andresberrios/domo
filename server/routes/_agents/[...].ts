import { proxyRequest } from 'h3'
import { electricConfig } from '../../lib/electric/config'

/**
 * Transparent same-origin reverse proxy: `/_agents/**` → agents-server.
 *
 * The chat surface subscribes to the entity's durable stream *directly
 * from the browser* (design: stream consumption is not a procedure). But
 * agents-server is VPS-local (`127.0.0.1:4437`) and Domo has no auth — the
 * browser must reach it through Domo's own origin (same model as the
 * coastd WS/SSE pass-throughs), so it keeps working over Tailscale /
 * Cloudflare Tunnel with nothing else exposed.
 *
 * `@electric-ax/agents-runtime`'s client resolves everything as
 * `baseUrl + path` (the `_electric` control GETs *and* the durable-stream
 * long-poll/SSE), so a single catch-all that strips the `/_agents` prefix
 * and streams the response through (h3 `proxyRequest`) covers all of it.
 */
export default defineEventHandler(async (event) => {
  const { serverUrl } = electricConfig()
  const suffix = event.path.replace(/^\/_agents/, '') || '/'
  return proxyRequest(event, serverUrl + suffix)
})

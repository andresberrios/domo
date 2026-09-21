const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * Where a coding agent reaches Domo's own HTTP endpoints (the agent mesh).
 *
 * Built from the port Nitro listens on, never from a request's `Host` header:
 * that names the address the *browser* used — behind `pnpm dev` it is Caddy's
 * HTTPS port — and says nothing about how a container gets here. An operator's
 * `NUXT_INTERNAL_URL` wins, but a loopback host in it still means "this
 * machine", which from inside an environment is `host.docker.internal`.
 */
export function internalBaseUrl(fromContainer = false, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(env.NUXT_INTERNAL_URL || `http://127.0.0.1:${env.PORT || env.NITRO_PORT || 3000}`)
  if (fromContainer && LOOPBACK.has(url.hostname)) url.hostname = 'host.docker.internal'
  return url.origin
}

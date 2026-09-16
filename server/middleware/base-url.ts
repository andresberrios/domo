/**
 * Remember the origin the app is actually served on, so spawned MCP servers can
 * call back into us regardless of which port Nitro picked.
 */
export default defineEventHandler((event) => {
  if (process.env.NUXT_INTERNAL_URL) return
  const host = getRequestHeader(event, 'host')
  if (host) process.env.NUXT_INTERNAL_URL = `http://${host.replace('0.0.0.0', '127.0.0.1')}`
})

import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from '@electric-sql/client'

const ELECTRIC_URL = process.env.ELECTRIC_URL || process.env.NUXT_ELECTRIC_URL || 'http://localhost:30000'

/** Only these tables may be synced to the browser. */
const ALLOWED_TABLES = new Set([
  'voice_sessions',
  'voice_messages',
  'agent_sessions',
  'agent_events',
  'agent_permissions',
  'agent_inbox',
  'cron_jobs',
  'mcp_servers',
  'projects',
  'dev_environments',
  // Account-wide, and deliberately free of anything secret: no token, no
  // header and no raw response body is ever written to either of them.
  'usage_limits',
  'usage_providers'
])

/**
 * Reverse proxy in front of Electric so the browser talks to one origin and we
 * keep a single place to add auth later. Shape definitions (table/where) are
 * validated here, protocol params (offset, handle, live, cursor) pass through.
 */
export default defineEventHandler(async (event) => {
  const incoming = getQuery(event) as Record<string, string>
  const table = incoming.table

  if (!table || !ALLOWED_TABLES.has(table)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown shape table: ${table}` })
  }

  const url = new URL('/v1/shape', ELECTRIC_URL)
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue
    const isProtocol = (ELECTRIC_PROTOCOL_QUERY_PARAMS as readonly string[]).includes(key)
    const isShape = key === 'table' || key === 'where' || key === 'columns' || key.startsWith('params[')
    if (isProtocol || isShape) url.searchParams.set(key, String(value))
  }
  // Full rows on update keep the UI's local cache coherent without re-fetching.
  // `replica` is neither a protocol param nor part of the shape definition, so
  // the loop above never forwards a client-supplied one: this is the only value.
  url.searchParams.set('replica', 'full')

  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw createError({
      statusCode: 503,
      statusMessage: `Electric is not reachable at ${ELECTRIC_URL}. Run \`docker compose up -d\`.`,
      data: { message: error instanceof Error ? error.message : String(error) }
    })
  }

  // fetch() already decompressed the body; leaving these on breaks the browser.
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')

  setResponseStatus(event, response.status, response.statusText)
  for (const [key, value] of headers.entries()) setResponseHeader(event, key, value)

  return response.body ? sendStream(event, response.body as any) : null
})

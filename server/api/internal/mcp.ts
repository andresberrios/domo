import { handleMeshMcpRequest } from '../../lib/mesh/server'

/**
 * The built-in `domo` MCP server, over Streamable HTTP. Every coding agent Domo
 * spawns is pointed here with a bearer token that names it; see
 * `server/lib/mesh/server.ts` for the transport and `tools.ts` for the tools.
 */
export default defineEventHandler(async (event) => {
  const method = event.method
  const body = method === 'GET' || method === 'DELETE' ? undefined : await readRawBody(event)

  const headers = new Headers()
  for (const [name, value] of Object.entries(getRequestHeaders(event))) {
    // `content-length` is the one header that can no longer be true: the body
    // was read here and is handed on as a string.
    if (value === undefined || name === 'content-length') continue
    headers.set(name, value)
  }

  const response = await handleMeshMcpRequest(
    new Request(new URL(event.path, 'http://mesh.internal'), { method, headers, body })
  )

  setResponseStatus(event, response.status)
  for (const [name, value] of response.headers) setResponseHeader(event, name, value)
  return response.text()
})

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { callMeshTool, MESH_TOOLS } from './tools'
import { verifyMeshToken } from './token'

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

function meshServer(agentSessionId: string): Server {
  const server = new Server(
    { name: 'domo-agent-mesh', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MESH_TOOLS as unknown as any[] }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callMeshTool(agentSessionId, request.params.name, request.params.arguments)
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      // A tool that fails is a tool result the agent can read and react to, not
      // a transport error that would abort its turn.
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      }
    }
  })

  return server
}

/**
 * The agent-mesh MCP endpoint, as a plain `Request` → `Response` function so it
 * can be driven without a listening server.
 *
 * Stateless: a fresh MCP server and transport per request, no session id, JSON
 * responses. The caller is whoever their bearer token says they are — nothing
 * in the body is trusted.
 */
export async function handleMeshMcpRequest(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization') ?? ''
  const agentSessionId = verifyMeshToken(authorization.replace(/^Bearer\s+/i, '').trim())
  if (!agentSessionId) return jsonRpcError(401, -32001, 'Unauthorized')

  // Stateless servers have nothing to stream and nothing to delete.
  if (request.method === 'GET' || request.method === 'DELETE') {
    return jsonRpcError(405, -32000, 'Method not allowed.')
  }

  const server = meshServer(agentSessionId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    // Buffered before the server is torn down: `enableJsonResponse` means the
    // whole body is already decided by the time `handleRequest` resolves.
    const body = await response.text()
    return new Response(body || null, { status: response.status, headers: response.headers })
  } finally {
    await server.close().catch(() => {})
  }
}

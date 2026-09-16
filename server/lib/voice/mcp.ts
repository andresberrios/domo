import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { mcpToTool, type CallableTool } from '@google/genai'

import { listMcpServers } from '../repo'
import type { McpServer } from '../../../shared/types'

export interface ConnectedMcp {
  server: McpServer
  client: Client
  close: () => Promise<void>
}

async function connectOne(server: McpServer): Promise<ConnectedMcp> {
  const client = new Client({ name: 'domo-voice', version: '1.0.0' })

  if (server.transport === 'stdio') {
    if (!server.command) throw new Error(`MCP server "${server.name}" has no command`)
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) }
    })
    await client.connect(transport)
  } else {
    if (!server.url) throw new Error(`MCP server "${server.name}" has no URL`)
    const url = new URL(server.url)
    const requestInit = { headers: server.headers ?? {} }
    const transport = server.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit })
    await client.connect(transport)
  }

  return {
    server,
    client,
    close: async () => {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Connect every MCP server configured for the voice agent and expose them as
 * Gemini callable tools. Failures are reported but never block the session.
 */
export async function connectVoiceMcpServers(): Promise<{
  tools: CallableTool[]
  connections: ConnectedMcp[]
  errors: Array<{ name: string, message: string }>
}> {
  const servers = (await listMcpServers()).filter(
    server => server.enabled && (server.scope === 'voice' || server.scope === 'both')
  )

  const connections: ConnectedMcp[] = []
  const errors: Array<{ name: string, message: string }> = []

  for (const server of servers) {
    try {
      connections.push(await connectOne(server))
    } catch (error) {
      errors.push({
        name: server.name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // mcpToTool's variadic tuple signature can't be satisfied by a spread, but
  // the runtime contract is simply "one or more connected MCP clients".
  const clients = connections.map(connection => connection.client)
  const tools: CallableTool[] = clients.length
    ? [(mcpToTool as (...args: Client[]) => CallableTool)(...clients)]
    : []

  return { tools, connections, errors }
}

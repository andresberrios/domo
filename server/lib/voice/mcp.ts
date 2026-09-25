import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { mcpToTool, type CallableTool } from '@google/genai'

import { listMcpServers } from '../repo'
import type { OpenAiFunctionTool } from './tool-schema'
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

/**
 * The same connected servers, as plain function tools Domo executes itself.
 *
 * Gemini's SDK takes MCP clients directly (`mcpToTool`) and runs the calls;
 * OpenAI's Live delegation takes a list of function declarations and hands the
 * calls back for the application to run. So the same servers reach the two
 * providers by different roads, and this is the second one: declare the tools,
 * keep a handler per name, and dispatch through the client when one is called.
 *
 * Names are the servers' own and are not prefixed, because the model is told
 * about them by name and a mangled one is a name the user cannot ask for. Two
 * servers offering the same tool name is therefore a real collision: the first
 * wins and the second is skipped with a warning, rather than one silently
 * shadowing the other on every call.
 */
export async function mcpFunctionTools(connections: ConnectedMcp[]): Promise<{
  tools: OpenAiFunctionTool[]
  handlers: Record<string, (args: any) => Promise<unknown>>
}> {
  const tools: OpenAiFunctionTool[] = []
  const handlers: Record<string, (args: any) => Promise<unknown>> = {}

  for (const connection of connections) {
    let listed: Awaited<ReturnType<Client['listTools']>>
    try {
      listed = await connection.client.listTools()
    } catch (error) {
      console.warn(
        `[voice] could not list tools on MCP server "${connection.server.name}": `
        + (error instanceof Error ? error.message : String(error))
      )
      continue
    }

    for (const tool of listed.tools ?? []) {
      if (handlers[tool.name]) {
        console.warn(
          `[voice] MCP server "${connection.server.name}" also offers a tool called `
          + `"${tool.name}"; keeping the first one`
        )
        continue
      }
      tools.push({
        type: 'function',
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: (tool.inputSchema as any) ?? { type: 'object', properties: {} }
      })
      handlers[tool.name] = async (args: any) =>
        connection.client.callTool({ name: tool.name, arguments: args ?? {} })
    }
  }

  return { tools, handlers }
}

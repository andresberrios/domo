import { updateMcpServer } from '../../lib/repo'
import type { McpServer } from '../../../shared/types'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<McpServer>>(event)
  const server = await updateMcpServer(id, body ?? {})
  if (!server) throw createError({ statusCode: 404, statusMessage: 'MCP server not found' })
  return server
})

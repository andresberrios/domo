import { createMcpServer } from '../../lib/repo'
import type { McpServer } from '../../../shared/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<McpServer>>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  if (!body.transport) throw createError({ statusCode: 400, statusMessage: 'transport is required' })
  if (body.transport === 'stdio' && !body.command?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'command is required for stdio servers' })
  }
  if (body.transport !== 'stdio' && !body.url?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'url is required for http/sse servers' })
  }
  return createMcpServer({ ...body, name: body.name.trim(), transport: body.transport })
})

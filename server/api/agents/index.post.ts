import { acpManager } from '../../lib/acp/manager'
import { isAgentAdapter } from '../../../shared/agent-adapters'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: string
    adapter?: 'claude-code' | 'codex' | 'opencode'
    cwd?: string
    modeId?: string | null
    model?: string | null
    config?: Record<string, string> | null
    devEnvironmentId?: string | null
    initialPrompt?: string
    /** Prompt content, attachments included; see `firstMessage` on `acpManager.create`. */
    firstMessage?: any[]
  }>(event)

  if (body?.firstMessage !== undefined && !Array.isArray(body.firstMessage)) {
    throw createError({ statusCode: 400, statusMessage: 'firstMessage must be a list of content blocks' })
  }
  const config = body?.config && typeof body.config === 'object'
    ? Object.fromEntries(Object.entries(body.config).filter(([, value]) => typeof value === 'string'))
    : null

  return acpManager.create({
    adapter: isAgentAdapter(body?.adapter) ? body.adapter : 'claude-code',
    title: body?.title,
    cwd: body?.cwd,
    modeId: body?.modeId ?? null,
    model: body?.model ?? null,
    config,
    devEnvironmentId: body?.devEnvironmentId ?? null,
    initialPrompt: body?.initialPrompt,
    firstMessage: body?.firstMessage
  })
})

import { acpManager } from '../../lib/acp/manager'
import { isAgentAdapter } from '../../../shared/agent-adapters'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: string
    adapter?: 'claude-code' | 'codex' | 'opencode'
    cwd?: string
    voiceSessionId?: string | null
    modeId?: string | null
    model?: string | null
    devEnvironmentId?: string | null
    initialPrompt?: string
  }>(event)

  return acpManager.create({
    adapter: isAgentAdapter(body?.adapter) ? body.adapter : 'claude-code',
    title: body?.title,
    cwd: body?.cwd,
    voiceSessionId: body?.voiceSessionId ?? null,
    modeId: body?.modeId ?? null,
    model: body?.model ?? null,
    devEnvironmentId: body?.devEnvironmentId ?? null,
    initialPrompt: body?.initialPrompt
  })
})

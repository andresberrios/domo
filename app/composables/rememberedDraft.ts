import type { AgentDraft } from '~~/shared/types'
import { isAgentAdapter } from '~~/shared/agent-adapters'
import type { DraftAgentSettings } from '~/utils/agentDraft'

const REMEMBERED_KEY = 'domo:new-session:agent'

/** The settings the last session started from a draft used; null when there are none worth reading. */
export function rememberedDraftSettings(): DraftAgentSettings | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(REMEMBERED_KEY) ?? 'null')
    if (!stored || !isAgentAdapter(stored.adapter)) return null
    const config = stored.config && typeof stored.config === 'object' ? stored.config : {}
    return {
      adapter: stored.adapter,
      model: typeof stored.model === 'string' ? stored.model : '',
      modeId: typeof stored.modeId === 'string' ? stored.modeId : '',
      config: Object.fromEntries(Object.entries(config).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    }
  } catch {
    return null
  }
}

export function rememberDraftSettings(draft: AgentDraft): void {
  const { adapter, model, modeId, config } = draft
  try {
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ adapter, model, modeId, config }))
  } catch {
    /* private mode */
  }
}

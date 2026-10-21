import type { AgentAdapter } from './types'

/**
 * The adapters Domo can launch, and the small amount of product copy that is
 * inherently adapter-specific. Capability lists still come from ACP at
 * runtime; this registry only names the harness and explains what its ACP
 * "mode" means.
 */
export const AGENT_ADAPTERS: Array<{
  id: AgentAdapter
  label: string
  icon: string
  defaultMode: string
  modeLabel: string
  modeDescription: string
}> = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: 'i-lucide-sparkles',
    defaultMode: 'default',
    modeLabel: 'Permission mode',
    modeDescription: 'How much this agent may do before it asks.'
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: 'i-lucide-terminal',
    defaultMode: 'agent',
    modeLabel: 'Permission mode',
    modeDescription: 'How much this agent may do before it asks.'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    icon: 'i-lucide-code-xml',
    defaultMode: 'build',
    modeLabel: 'Agent',
    modeDescription: 'Which visible OpenCode agent handles the session.'
  },
  {
    id: 'copilot',
    label: 'Copilot',
    icon: 'i-lucide-github',
    // Copilot names its modes by ACP's own URLs. Permissions are its separate
    // "Allow All" setting, so the mode is how it works, not how much it asks.
    defaultMode: 'https://agentclientprotocol.com/protocol/session-modes#agent',
    modeLabel: 'Mode',
    modeDescription: 'Whether Copilot works with you, plans first, or runs on autopilot.'
  },
  {
    id: 'grok',
    label: 'Grok',
    icon: 'i-lucide-zap',
    // Grok publishes no modes over ACP; Domo's four are in server/lib/acp/grok.ts.
    defaultMode: 'default',
    modeLabel: 'Mode',
    modeDescription: 'Whether Grok asks before acting, runs without asking, plans first, or only answers.'
  }
]

export const AGENT_ADAPTER_IDS = AGENT_ADAPTERS.map(entry => entry.id)

export function isAgentAdapter(value: unknown): value is AgentAdapter {
  return AGENT_ADAPTER_IDS.includes(value as AgentAdapter)
}

export function agentAdapterInfo(adapter: AgentAdapter) {
  return AGENT_ADAPTERS.find(entry => entry.id === adapter)!
}

/** Each harness's cheap model, which writes session titles unless Settings names another. */
export const TITLE_MODELS: Record<AgentAdapter, string> = {
  'claude-code': 'haiku',
  codex: 'gpt-5.6-luna',
  opencode: 'opencode-go/glm-5.3-flash',
  // The one model every Copilot plan offers: Free has nothing else. Its router
  // picks a small model for a short request.
  copilot: 'auto',
  // The older of the two models every Grok account lists. Neither is a small
  // model, so Grok is not a default titler (`session-title.ts`).
  grok: 'grok-4.5'
}

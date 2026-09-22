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
  }
]

export const AGENT_ADAPTER_IDS = AGENT_ADAPTERS.map(entry => entry.id)

export function isAgentAdapter(value: unknown): value is AgentAdapter {
  return AGENT_ADAPTER_IDS.includes(value as AgentAdapter)
}

export function agentAdapterInfo(adapter: AgentAdapter) {
  return AGENT_ADAPTERS.find(entry => entry.id === adapter)!
}

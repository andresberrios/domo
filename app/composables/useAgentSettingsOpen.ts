/**
 * Whether the composer's settings panel is open, shared so the agent page's
 * header can open it from the coding agent's chip. One composer per page, so
 * one flag.
 */
export function useAgentSettingsOpen() {
  return useState('agent-settings-open', () => false)
}

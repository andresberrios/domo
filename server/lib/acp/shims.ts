import { copilotModels, withCopilotModels } from './copilot'
import { withGrok } from './grok'
import type { AgentAdapter } from '../../../shared/types'

/**
 * What an adapter's ACP lacks, added on its connection so the rest of Domo
 * treats every adapter the same: Copilot's model option (`copilot.ts`),
 * Grok's sign-in with a key, modes and steering (`grok.ts`). `env` is the
 * adapter process's own environment.
 */
export function adaptConnection<T extends { agent: { request: (...args: any[]) => Promise<any>, notify: (...args: any[]) => Promise<void> } }>(
  adapter: AgentAdapter,
  connection: T,
  env: NodeJS.ProcessEnv
): T {
  if (adapter === 'copilot') return withCopilotModels(connection, () => copilotModels())
  if (adapter === 'grok') return withGrok(connection, { apiKey: !!env.XAI_API_KEY, provider: !!env.GROK_AUTH_PROVIDER_COMMAND })
  return connection
}

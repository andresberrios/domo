import type { SetupStatus } from '~~/shared/types'

/**
 * Each coding agent and voice as they are right now: installed, signed in and
 * on what, and what the setup guide remembers. Shared by the guide, the
 * General page and each agent's settings page.
 */
export function useSetupStatus() {
  return useFetch<SetupStatus>('/api/setup', { key: 'setup-status', lazy: true, server: false })
}

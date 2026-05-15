/**
 * Electric Agents runtime config. agents-server + Postgres run via
 * docker-compose (see docker-compose.yml); Domo's Nuxt process hosts the
 * `claude-code-cli` entity runtime in-process and connects OUT to
 * agents-server via a pull-wake runner.
 */
export interface ElectricConfig {
  /** agents-server control-plane base URL. */
  serverUrl: string
  /** Stable id for this Domo runtime's pull-wake runner. */
  runnerId: string
  /** Human-readable runtime name (agents-server /api/runtimes key). */
  runtimeName: string
}

export function electricConfig(): ElectricConfig {
  return {
    serverUrl: (
      process.env.DOMO_AGENTS_SERVER_URL || 'http://127.0.0.1:4437'
    ).replace(/\/+$/, ''),
    runnerId: process.env.DOMO_AGENTS_RUNNER_ID || 'domo-runtime',
    runtimeName: process.env.DOMO_AGENTS_RUNTIME_NAME || 'domo',
  }
}

export const CLAUDE_CODE_CLI_ENTITY = 'claude-code-cli'

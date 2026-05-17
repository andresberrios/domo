/**
 * Operator-facing host config — `<domoHome>/config.json`.
 *
 * Distinct from `settings.ts` (the SQLite UX-prefs store): this is
 * deploy-level configuration the operator edits, lives in the data dir so
 * it survives app updates, and is read fresh on every use so edits apply
 * without a restart (callers are infrequent — a per-turn `claude` spawn).
 *
 * The one knob today is the spawn environment for the host-side `claude`
 * (Decided #11: Domo orchestrates `claude` in its own process env).
 * Because Domo ships as a host install + compose'd infra (Decided #19),
 * letting people declaratively extend that env — without editing the
 * service unit — is the clean customization seam.
 */
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { domoHome } from './paths'

const configSchema = z.object({
  claude: z
    .object({
      /**
       * Extra env vars for the `claude` spawn. Applied after the host env
       * but the security scrub still wins (Decided #9) — this can NOT
       * reintroduce a stripped credential like `ANTHROPIC_API_KEY`.
       */
      env: z.record(z.string(), z.string()).optional(),
      /**
       * Dirs prepended to `PATH` for the `claude` spawn — e.g. a language
       * runtime a configured MCP server needs on the host.
       */
      extraPath: z.array(z.string()).optional(),
    })
    .optional(),
})

export type DomoConfig = z.infer<typeof configSchema>

export function domoConfigPath(): string {
  return join(domoHome(), 'config.json')
}

/**
 * Missing file → defaults (the common case). Malformed → defaults + a
 * warning; never throw into a turn.
 */
export function loadDomoConfig(): DomoConfig {
  let raw: string
  try {
    raw = readFileSync(domoConfigPath(), 'utf8')
  } catch {
    return {}
  }
  try {
    return configSchema.parse(JSON.parse(raw))
  } catch (e) {
    console.warn(
      `[domo] ignoring invalid ${domoConfigPath()}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return {}
  }
}

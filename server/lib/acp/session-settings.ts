import { acpManager } from './manager'
import { assertSessionLive } from './retirement'
import { updateAgentSession } from '../repo'
import type { AgentSession } from '../../../shared/types'

/**
 * Any mix of the four things a session's own settings panel changes. Shared
 * by `PATCH /api/agents/[id]`, the voice tool and the mesh tool of the same
 * name (`manage_agent_session`) so "what these four fields mean, and in what
 * order to apply them" is written once rather than three times.
 */
export interface AgentSessionPatch {
  title?: string
  modeId?: string
  model?: string
  /**
   * The adapter's own settings, by config option id — `{ effort: 'high' }` on
   * Claude Code, `{ reasoning_effort: 'high' }` on Codex. The ids come from
   * the session's own `configOptions`, so nothing here has to know them.
   */
  config?: Record<string, string>
  /** `true` stops the session and hides it; `false` brings it back into the list. */
  archived?: boolean
}

export interface AgentSessionPatchResult {
  id: string
  title: string
  mode?: string
  model?: string
  config?: Record<string, string>
  archived?: boolean
}

/**
 * Apply a patch to an already-resolved session and report what took.
 *
 * Live adapter requests (`modeId`, `model`, `config`) run before the plain
 * column writes (`title`, `archived`): both can fail against a real process
 * (unsupported mode, no matching model) in a way a rename cannot, and a
 * caller changing two fields at once should not end up with a title or an
 * archived flag written next to a mode or model change that never took.
 *
 * "Live" is the case, not the requirement: none of the three starts an
 * adapter. On a stopped session they are recorded on the row and applied at
 * the next attach (see `AgentRuntime.liveConnection`), so a caller may set up
 * a session — rename it, put it in plan mode, move it to Opus — without a
 * process running anywhere, and `result.mode` / `result.model` / `result.config`
 * then report what was asked for rather than what an adapter confirmed.
 *
 * Resolving *which* session this is and deciding *whether* the caller may
 * touch it (voice's fuzzy id-or-title lookup and default to the most
 * recently active session; the mesh's default to the caller's own session
 * and its refusal to archive that same session) stay with each tool — they
 * differ enough between an unrestricted human-facing surface and a
 * bearer-token-scoped agent-facing one that folding them in here would cost
 * more clarity than the duplication itself does.
 */
export async function applyAgentSessionPatch(target: AgentSession, patch: AgentSessionPatch): Promise<AgentSessionPatchResult> {
  const result: AgentSessionPatchResult = { id: target.id, title: target.title }

  // A retired session is a record, and a record can be relabelled but not
  // reconfigured: the mode, the model and the adapter's own settings are all
  // requests to a process that no longer exists, and un-archiving one would
  // put it back on the live list without ever reviving it.
  if (target.retiredAt && (patch.modeId || patch.model || patch.config || patch.archived !== undefined)) {
    assertSessionLive(target, 'changing anything but its title')
  }

  if (patch.modeId) {
    await acpManager.setMode(target.id, patch.modeId)
    result.mode = patch.modeId
  }
  if (patch.model) {
    await acpManager.setModel(target.id, patch.model)
    result.model = patch.model
  }
  // After the model, never before: both adapters publish these per model, and
  // Claude Code drops the effort option entirely on a model that has none. A
  // value set against the outgoing model would be applied and then thrown away.
  for (const [configId, value] of Object.entries(patch.config ?? {})) {
    await acpManager.setConfigOption(target.id, configId, value)
    result.config = { ...result.config, [configId]: value }
  }
  if (patch.title) {
    await updateAgentSession(target.id, { title: patch.title })
    result.title = patch.title
  }
  // `false` is a real instruction here and not an absent one — it is how a
  // session comes back out of the archive — so this asks whether the field was
  // sent, not whether it was truthy. Only archiving stops anything: bringing a
  // session back leaves it stopped until somebody prompts it.
  if (patch.archived !== undefined) {
    if (patch.archived) acpManager.stop(target.id)
    await updateAgentSession(target.id, {
      archived: patch.archived,
      ...(patch.archived ? { status: 'stopped' as const } : {})
    })
    result.archived = patch.archived
  }
  return result
}

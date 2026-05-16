import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { getEnv } from '../../lib/envs'
import { insertSession, type SessionRow } from '../../lib/sessions'
import { CLAUDE_CODE_CLI_ENTITY } from '../../lib/electric/config'
import {
  durableStreamUrl,
  ensureRuntimeReady,
  runnerDispatchPolicy,
} from '../../lib/electric/client'

/**
 * Create a chat session: spawn a `claude-code-cli` Electric Agents entity
 * for the env's worktree, then record the Domo-side pointer row. The
 * entity is spawned with an explicit runner dispatch policy so its wakes
 * reach Domo's in-process pull-wake runtime (agents-server has no
 * route-to-any-local-runner fallback — see lib/electric/client.ts).
 *
 * No prompt is sent here — `sessions.prompt` drives the first turn, which
 * is also what auto-titles the session (the entity tags `title` from the
 * first message; Domo's DB `title` is the user-editable override).
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    title: z.string().optional(),
  }),
  output: Session,
  handler: async ({ input }) => {
    const env = getEnv(input.envId)
    if (!env) {
      throw createError({ statusCode: 404, statusMessage: 'env not found' })
    }
    if (!env.worktreePath) {
      throw createError({
        statusCode: 409,
        statusMessage: 'env has no worktree yet — provision it first',
      })
    }

    const id = crypto.randomUUID()
    const client = await ensureRuntimeReady()
    const info = await client.spawnEntity({
      type: CLAUDE_CODE_CLI_ENTITY,
      id,
      args: {
        sessionId: id,
        envId: env.id,
        coastInstance: env.coastInstanceName,
        cwd: env.worktreePath,
      },
      dispatch_policy: runnerDispatchPolicy(),
      ...(input.title ? { tags: { title: input.title } } : {}),
    })

    const row: SessionRow = {
      id,
      envId: env.id,
      title: input.title ?? null,
      status: 'waiting',
      done: false,
      entityId: info.entityUrl,
      durableStreamUrl: durableStreamUrl(info.streamPath),
      nativeClaudeSessionId: null,
      createdAt: Date.now(),
      lastEventAt: null,
      viewedAtPerDevice: {},
    }
    insertSession(row)
    return row
  },
})

import { getEnv, updateEnvFields } from '../../lib/envs'
import { getProject } from '../../lib/projects'

/**
 * SSE pass-through for coastd's `POST /api/v1/stream/run`. Provisions the
 * Coast instance for an existing env row (must be created via the
 * `envs.create` procedure first).
 *
 * Request body: `{ envId: string, forceRemoveDangling?: boolean, buildId?: string }`.
 *
 * On `complete`, the upstream stream ends naturally. The next `envs.list`
 * / `envs.overview` call picks up the live `Running` status from coastd —
 * the live-events WS subscription will also reflect the change without
 * polling.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    envId?: string
    forceRemoveDangling?: boolean
    buildId?: string
  }>(event)
  if (!body?.envId) {
    throw createError({ statusCode: 400, statusMessage: 'envId is required' })
  }

  const env = getEnv(body.envId)
  if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
  const project = getProject(env.projectId)
  if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })

  const config = useRuntimeConfig()
  const upstream = await fetch(`${config.coastApiUrl}/api/v1/stream/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      name: env.coastInstanceName,
      project: project.name,
      worktree: env.coastInstanceName,
      branch: env.branch ?? undefined,
      build_id: body.buildId,
      force_remove_dangling: !!body.forceRemoveDangling,
    }),
  })

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => 'unknown error')
    updateEnvFields(env.id, { status: 'error' })
    throw createError({ statusCode: upstream.status, statusMessage: txt })
  }

  // Optimistically mark as provisioning; the client + live events will
  // settle the row to `running` once coastd reports the instance up.
  updateEnvFields(env.id, { status: 'provisioning' })

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  return upstream.body
})

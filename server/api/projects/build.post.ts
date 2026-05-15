import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getProject } from '../../lib/projects'

/**
 * SSE pass-through for coastd's `POST /api/v1/stream/build`. Streaming
 * doesn't fit the procedure shape (request/response only), so this remains
 * a classic Nitro handler.
 *
 * Request body: `{ projectId: string, refresh?: boolean }`.
 *
 * The response is the raw `text/event-stream` body from coastd —
 * `progress` / `complete` / `error` event frames — passed through
 * untouched so the UI can render Coast's progress output verbatim.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ projectId?: string; refresh?: boolean }>(event)
  if (!body?.projectId) {
    throw createError({ statusCode: 400, statusMessage: 'projectId is required' })
  }

  const project = getProject(body.projectId)
  if (!project) {
    throw createError({ statusCode: 404, statusMessage: 'project not found' })
  }

  const coastfilePath = ['Coastfile', 'Coastfile.toml']
    .map((c) => join(project.rootPath, c))
    .find((p) => existsSync(p))
  if (!coastfilePath) {
    throw createError({ statusCode: 400, statusMessage: 'project has no Coastfile' })
  }

  const config = useRuntimeConfig()
  const upstream = await fetch(`${config.coastApiUrl}/api/v1/stream/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ coastfile_path: coastfilePath, refresh: !!body.refresh }),
  })

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => 'unknown error')
    throw createError({ statusCode: upstream.status, statusMessage: txt })
  }

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  return upstream.body
})

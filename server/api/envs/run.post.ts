/**
 * SSE endpoint that drives `devcontainer up` for an env. Replaces
 * Coast's `/api/v1/stream/run` pass-through. Streams the CLI's
 * stdout + stderr as `progress` frames; emits a `complete` frame on
 * success carrying `{ containerId, publishedPorts }` and an `error`
 * frame on failure. The client's `useBuildProgress.consume()` already
 * understands the frame shape — we just normalize each chunk into a
 * single "Provision" step with detail lines (the per-phase plan-fold
 * the Coast stream had is gone for v1; can be re-introduced when we
 * parse the CLI's structured progress).
 *
 * Request body: `{ envId: string }`.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { requireActiveUser } from '../../lib/auth'
import { getEnv, resolveContainerId, updateEnvFields } from '../../lib/envs'
import { domoHome } from '../../lib/paths'
import * as portForwarder from '../../lib/portForwarder'
import { getProject } from '../../lib/projects'
import {
  inspect,
  loadDevcontainer,
  resolveForwardPorts,
  up,
  DevcontainerNotFoundError,
} from '../../lib/devcontainer'
import * as dc from '../../lib/devcontainer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ envId?: string }>(event)
  if (!body?.envId) {
    throw createError({ statusCode: 400, statusMessage: 'envId is required' })
  }
  const user = await requireActiveUser(event)

  const env = getEnv(body.envId)
  if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
  const project = getProject(env.projectId)
  if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })
  if (!env.worktreePath) {
    throw createError({ statusCode: 500, statusMessage: 'env has no worktree path' })
  }

  // Per-Domo-user shared `~/.claude` (Decided #3 / step 3b). Created on
  // first up; subsequent ups for the same user reuse it. The user runs
  // `claude /login` once from inside any env's terminal — OAuth + slash
  // commands + MCP definitions then propagate to every env they open.
  // Mode 0700 since it holds OAuth credentials.
  const claudeHomeHost = join(domoHome(), 'claude-home', user.id)
  await mkdir(claudeHomeHost, { recursive: true, mode: 0o700 })
  // The mount target depends on the container's `remoteUser`. We read
  // it from the parsed devcontainer.json below; default to `vscode`
  // (the Microsoft base image's default) when unset.
  let bindMounts: { hostPath: string; containerPath: string }[] = []

  // Read forwardPorts + remoteUser from the project's devcontainer.json
  // so we can publish ports at create time and target the right home
  // directory for the shared `~/.claude` bind-mount.
  let publishPorts: { innerPort: number; protocol: 'tcp' | 'udp' }[] = []
  let devcontainerPath: string
  let remoteUser = 'vscode'
  try {
    const resolved = await loadDevcontainer(project.rootPath)
    devcontainerPath = resolved.path
    publishPorts = resolveForwardPorts(resolved.config).map((p) => ({
      innerPort: p.innerPort,
      protocol: p.protocol,
    }))
    if (typeof resolved.config.remoteUser === 'string' && resolved.config.remoteUser.length > 0) {
      remoteUser = resolved.config.remoteUser
    }
  } catch (e) {
    if (e instanceof DevcontainerNotFoundError) {
      throw createError({ statusCode: 400, statusMessage: 'project has no devcontainer.json' })
    }
    throw e
  }
  bindMounts = [
    { hostPath: claudeHomeHost, containerPath: `/home/${remoteUser}/.claude` },
  ]

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')

  const { Readable } = await import('node:stream')
  const stream = new Readable({ read() {} })

  function emitProgress(detail: string, status: 'started' | 'ok' | 'warn' | 'fail' = 'started') {
    const payload = JSON.stringify({ step: 'Provision', detail, status })
    stream.push(`event: progress\ndata: ${payload}\n\n`)
  }
  function emitComplete(data: Record<string, unknown>) {
    stream.push(`event: complete\ndata: ${JSON.stringify(data)}\n\n`)
    stream.push(null)
  }
  function emitError(msg: string) {
    stream.push(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`)
    stream.push(null)
  }

  // Optimistically mark provisioning; the row settles to a live status
  // (`running` / `error`) after `up` resolves.
  updateEnvFields(env.id, { status: 'provisioning', devcontainerPath })

  // Fire-and-forget the up call; the stream is the user-facing channel.
  ;(async () => {
    try {
      // Make sure a worktree exists on disk. `devcontainer up` itself
      // doesn't create git worktrees — Domo does.
      const { existsSync } = await import('node:fs')
      if (!existsSync(env.worktreePath!)) {
        emitProgress(`Creating worktree at ${env.worktreePath}`, 'started')
        const { execFile: execFileCb } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFile = promisify(execFileCb)
        const args = ['-C', project.rootPath, 'worktree', 'add']
        if (env.branch) args.push('-B', env.branch, env.worktreePath!)
        else args.push(env.worktreePath!)
        await execFile('git', args)
        emitProgress(`Worktree ready`, 'ok')
      }

      emitProgress('Running `devcontainer up`…')
      const reused = await resolveContainerId(env)
      const result = await up({
        workspaceFolder: env.worktreePath!,
        envId: env.id,
        projectId: project.id,
        publishPorts,
        bindMounts,
        onLog: ({ stream: s, text }) => {
          // CLI emits many lines; we forward each non-empty one. The
          // JSON outcome envelope is the final line and is handled by
          // the resolver; we still surface intermediate JSON status
          // lines as plain text — operators expect to see them.
          for (const ln of text.split('\n')) {
            const t = ln.trim()
            if (t) emitProgress(t, s === 'stderr' ? 'warn' : 'started')
          }
        },
      })

      const info = await inspect(result.containerId)
      const liveStatus = info ? dc.toEnvLiveStatus(info.status) : 'unknown'
      updateEnvFields(env.id, { containerId: result.containerId, status: liveStatus })

      // Container's host loopback ports may have changed (recreate
      // reassigns the random side); rebind any external forwarders for
      // this env so the user-facing 0.0.0.0:<chosen> listener still
      // points at the right loopback target.
      await portForwarder.rebindForEnv(env.id).catch((e) => {
        emitProgress(`port forwarder rebind warning: ${e instanceof Error ? e.message : String(e)}`, 'warn')
      })

      emitComplete({
        containerId: result.containerId,
        reused: reused === result.containerId,
        publishedPorts: info?.publishedPorts ?? [],
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      updateEnvFields(env.id, { status: 'error' })
      emitError(msg)
    }
  })()

  return stream
})

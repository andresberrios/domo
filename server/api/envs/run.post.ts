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

import { getEnv, resolveContainerId, updateEnvFields } from '../../lib/envs'
import { domoHome } from '../../lib/paths'
import * as portForwarder from '../../lib/portForwarder'
import { getProject } from '../../lib/projects'
import {
  inspect,
  resolveDevcontainerConfig,
  resolveForwardPorts,
  up,
} from '../../lib/devcontainer'
import * as dc from '../../lib/devcontainer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ envId?: string }>(event)
  if (!body?.envId) {
    throw createError({ statusCode: 400, statusMessage: 'envId is required' })
  }

  const env = getEnv(body.envId)
  if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
  const project = getProject(env.projectId)
  if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })
  if (!env.worktreePath) {
    throw createError({ statusCode: 500, statusMessage: 'env has no worktree path' })
  }

  // Installation-wide shared `~/.claude` (Decided #3 — single-user
  // install for v1). Created on first up; reused for every env.
  // Domo user runs `claude /login` once from inside any env's
  // terminal — OAuth + slash commands + MCP definitions then
  // propagate to every env across the install. Mode 0700 since it
  // holds OAuth credentials.
  const claudeHomeHost = join(domoHome(), 'claude-home')
  await mkdir(claudeHomeHost, { recursive: true, mode: 0o700 })
  // The mount target depends on the container's `remoteUser`. We read
  // it from the parsed devcontainer.json below; default to `vscode`
  // (the Microsoft base image's default) when unset.
  let bindMounts: { hostPath: string; containerPath: string }[] = []

  // Read forwardPorts + remoteUser from the project's devcontainer.json,
  // falling back to the Domo default when the project has none (step 8).
  // We resolve here in addition to `client.ts:up()` because the
  // publishPorts + remoteUser-derived bind-mount target are needed
  // BEFORE the up call — the up itself re-resolves to build the
  // merged config. Two reads, both cached by the FS layer, cheap.
  const resolved = await resolveDevcontainerConfig(env.worktreePath!, env.name)
  const devcontainerPath = resolved.path
  const publishPorts = resolveForwardPorts(resolved.config).map((p) => ({
    innerPort: p.innerPort,
    protocol: p.protocol,
  }))
  const remoteUser =
    typeof resolved.config.remoteUser === 'string' && resolved.config.remoteUser.length > 0
      ? resolved.config.remoteUser
      : 'vscode'
  bindMounts = [
    { hostPath: claudeHomeHost, containerPath: `/home/${remoteUser}/.claude` },
  ]
  if (!env.isRoot) {
    // Non-root envs bind-mount a `git worktree add`-created directory,
    // whose `.git` file points at an absolute host-path gitdir inside
    // the project's main `.git/worktrees/<name>/`. That absolute path
    // is unreachable from inside the container without the extra
    // mount; every `git ...` command (including the ones `claude` runs
    // as part of a turn) fails with "fatal: not a git repository".
    // The gitdir's own `commondir` is relative (`../..`), so this
    // single mount makes the worktree's git operations fully functional.
    //
    // Side-effects (acceptable for v1): the container can see every
    // env's worktree refs via the project's `.git/worktrees/` —
    // information disclosure across envs of the same project, not
    // privilege escalation.
    //
    // The root env (step 8) skips this mount: its `worktreePath` IS
    // `project.rootPath`, so `.git/` already lives inside the
    // workspace bind-mount as a normal subdirectory — no second
    // mount needed.
    bindMounts.push({
      hostPath: `${project.rootPath}/.git`,
      containerPath: `${project.rootPath}/.git`,
    })
  }

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
      // Non-root envs need a git worktree on disk before `devcontainer
      // up`. Root env (step 8) skips this — its `worktreePath` IS the
      // project root, which obviously already exists.
      //
      // Branch model: `env.branch` (== `env.name`) is a NEW branch
      // forked from `env.baseBranch` (the project default, unless
      // overridden at create time). `-B` would *reset* an existing
      // branch to HEAD and check it out — which collides with the
      // base branch being checked out at the project root. We use
      // `-b <branch> <path> <baseBranch>` instead: create branch,
      // start-point fork, check out into the new worktree.
      if (!env.isRoot) {
        const { existsSync } = await import('node:fs')
        if (!existsSync(env.worktreePath!)) {
          emitProgress(`Creating worktree at ${env.worktreePath}`, 'started')
          const { execFile: execFileCb } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFile = promisify(execFileCb)
          const args = ['-C', project.rootPath, 'worktree', 'add']
          if (env.branch) {
            args.push('-b', env.branch, env.worktreePath!)
            if (env.baseBranch) args.push(env.baseBranch)
          } else {
            args.push(env.worktreePath!)
          }
          await execFile('git', args)
          emitProgress(`Worktree ready`, 'ok')
        }
      }

      // `@devcontainers/cli` writes `devcontainer-lock.json` to
      // `<workspaceFolder>/.devcontainer/` while resolving Feature
      // dependencies — even when `--override-config` points to a
      // config outside the workspace. If the project has no
      // `.devcontainer/` (the step 8 "devcontainer.json optional"
      // case), the CLI fails with ENOENT before any container action.
      // Pre-create the directory so the lock can land. Mode 0755;
      // the lock file is harmless and small. (User can `.gitignore`
      // it if they prefer.) BUGS.md #19.
      await mkdir(join(env.worktreePath!, '.devcontainer'), { recursive: true })

      emitProgress('Running `devcontainer up`…')
      const reused = await resolveContainerId(env)
      const result = await up({
        workspaceFolder: env.worktreePath!,
        envId: env.id,
        envName: env.name,
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
      updateEnvFields(env.id, {
        containerId: result.containerId,
        // `devcontainerPath` is null when the Domo default config was
        // used (step 8). Persisting the null is important: the env
        // overview reads this field to decide whether to label the
        // env as "Using project's devcontainer.json" or "(default
        // config)", and drift detection re-resolves against the same
        // origin we used last time.
        devcontainerPath: result.devcontainerPath,
        // sha256 of the merged config we just handed the CLI — drift
        // detection compares against a recompute on overview load.
        devcontainerConfigHash: result.configHash,
        status: liveStatus,
      })

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

/**
 * Thin wrapper over `@devcontainers/cli` (lifecycle) + raw `docker`
 * (inspection / port discovery / terminal exec). The CLI is shelled out
 * via its packaged binary — there's no stable programmatic Node API, so
 * subprocess-with-JSON-output is the contract.
 *
 * Conventions:
 * - Domo tags every env container with two labels for discovery:
 *     - `domo.envId=<envId>` — our DB env id
 *     - `domo.projectId=<projectId>`
 *   Set via `--label` in injected `runArgs` at `up` time. We can then
 *   find a container even after a Domo restart without storing the
 *   Docker container id (we do store it, but the label is the
 *   reconciliation fallback).
 * - All published ports are bound to `127.0.0.1` (Decided #9). The
 *   "expose externally" toggle (step 4) layers a Domo-side TCP forwarder
 *   on top — published-port shape never changes.
 * - `workspaceFolder` for the CLI is the host worktree path
 *   (`<projectRoot>/.worktrees/<envName>`). The CLI bind-mounts it to
 *   `/workspaces/<name>` inside the container by default.
 */
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { hashResolvedConfig, resolveDevcontainerConfig } from './defaults'
import { detectHostRuntime } from './runtime'
import { parseForwardPort } from './parser'
import type { ContainerInfo, DevcontainerConfig, ForwardPortEntry } from './types'

const exec = promisify(execFile)

const DEVCONTAINER_BIN = (() => {
  // Resolve the packaged CLI binary. The package declares no `exports`
  // or `main` — only `bin: { devcontainer: "devcontainer.js" }` — so
  // `require.resolve('@devcontainers/cli/devcontainer.js')` is an
  // unsupported subpath under Node's ESM resolver (and silently throws
  // under Nitro's `createRequire` shim).
  //
  // Base the resolver on `process.argv[1]` (the actual entry file
  // path) rather than `import.meta.url`. Nitro bundles all server code
  // and rewrites `import.meta.url` to the virtual string
  // `"file:///_entry.js"` — `createRequire` then walks `node_modules`
  // up from `/` and finds nothing, breaking the release tarball even
  // when `traceInclude` placed the dep at
  // `.output/server/node_modules/`. `process.argv[1]` survives the
  // bundle: it's the path of `index.mjs` (or the file passed to
  // `node`) at runtime, next to the `node_modules` we want.
  try {
    const entry = process.argv[1] || import.meta.url
    const req = createRequire(entry)
    const pkgPath = req.resolve('@devcontainers/cli/package.json')
    // Hard-coded "devcontainer.js" — matches the package's `bin` entry
    // (verified at install time by the dep version pin).
    return join(pkgPath, '..', 'devcontainer.js')
  } catch (e) {
    // Log once at module load so we know the resolve failed (Nitro's
    // bundled require.resolve doesn't always find the same paths as a
    // plain node REPL; the surfaced error gives `install.sh` /
    // troubleshooting docs a concrete hook).
    console.error('[devcontainer] cli resolve failed:', (e as Error)?.message ?? e)
    return null
  }
})()

export interface UpOptions {
  /** Host worktree path bound into the container as the workspace.
   * For the root env (step 8) this is `project.rootPath` directly;
   * for non-root envs it's the freshly-created git worktree. */
  workspaceFolder: string
  /** Domo env id — also written as a container label for reconciliation. */
  envId: string
  /** Domo env name — used to pin `workspaceFolder: /workspaces/<envName>`
   * in the merged config so the engine's path-translation
   * (`toHostPath()` + friends) stays stable regardless of the host
   * directory basename. Without this, root env's container mount
   * target would default to `basename(project.rootPath)` and break
   * the convention. Step 8 decision #8. */
  envName: string
  /** Domo project id — container label for grouping. */
  projectId: string
  /**
   * Inner ports to publish at create time. Each becomes a `-p
   * 127.0.0.1:0:<inner>` runArg in the merged config; Docker picks a
   * random free host port. Discover the assignment via `inspect()`
   * after `up`. Empty = no ports published (caller can still attach a
   * userland forwarder for ad-hoc cases in step 4).
   */
  publishPorts?: { innerPort: number; protocol: 'tcp' | 'udp' }[]
  /**
   * Mount `<hostPath>` from the host into `<containerPath>` inside the
   * container. Step 3b uses this for the per-Domo-user shared
   * `~/.claude` (`<DOMO_HOME>/claude-home/<userId>` → `~/.claude` in
   * the env container) so OAuth + slash commands + MCP propagate
   * across all of one user's envs.
   */
  bindMounts?: { hostPath: string; containerPath: string; readOnly?: boolean }[]
  /** Container env vars merged into devcontainer.json's `containerEnv`. */
  containerEnv?: Record<string, string>
  /** AbortSignal for long-running provisioning. */
  signal?: AbortSignal
  /** Streamed stdout/stderr from the CLI — surface in the build/run SSE
   * route once it exists. */
  onLog?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
}

export interface UpResult {
  containerId: string
  outcome: 'success' | 'error'
  /** sha256 of the merged config we handed the CLI. Persisted on the
   * env row as `devcontainer_config_hash`; drift detection (step 8)
   * recomputes this on overview load and surfaces a Rebuild banner
   * when it differs. */
  configHash: string
  /** Path to the project's `devcontainer.json` that was used, or null
   * when the Domo default config was applied. Persisted so the UI can
   * surface "(default config)" on the env overview. */
  devcontainerPath: string | null
  /** True iff the merged config was built on top of the Domo default
   * rather than the project's `devcontainer.json`. */
  usedDefaultConfig: boolean
  /** Raw `devcontainer up` JSON envelope, kept for debugging. */
  raw: unknown
}

export class DevcontainerCliMissingError extends Error {
  constructor() {
    super('`@devcontainers/cli` not installed; reinstall Domo dependencies')
    this.name = 'DevcontainerCliMissingError'
  }
}

export class DevcontainerUpError extends Error {
  readonly stderr: string
  constructor(message: string, stderr: string) {
    super(message)
    this.name = 'DevcontainerUpError'
    this.stderr = stderr
  }
}

function cliBin(): string {
  if (!DEVCONTAINER_BIN) throw new DevcontainerCliMissingError()
  return DEVCONTAINER_BIN
}

/**
 * Provision (or reuse) and start the env container. Spawns the CLI in
 * its own subprocess; the CLI itself shells out to `docker`. Emits
 * stdout/stderr chunks via `onLog` for the build/run SSE consumer.
 *
 * The CLI prints multiple JSON envelopes; the final one (`outcome:
 * success` or `error`) carries the `containerId`. We parse the last
 * non-empty line of stdout as JSON.
 */
export async function up(opts: UpOptions): Promise<UpResult> {
  const bin = cliBin()
  const runtime = await detectHostRuntime()

  // `devcontainer up` does not take freeform run-args on its CLI — they
  // live in devcontainer.json's `runArgs` field. `--override-config`
  // *replaces* (not merges) the project's devcontainer.json — so we
  // load the parent ourselves, splice our `runArgs`/`containerEnv` /
  // labels into a copy, and hand the merged result to the CLI. (An
  // earlier version of this code assumed deep-merge; the v0.87.0 CLI
  // surfaced the bug as "missing one of image/dockerFile/
  // dockerComposeFile" — our overlay-only config was being treated as
  // the whole thing.)
  //
  // Step 8: `devcontainer.json` is optional. `resolveDevcontainerConfig`
  // returns the project's config if present, the Domo default
  // otherwise. The merged config is identical in shape either way.
  const resolved = await resolveDevcontainerConfig(opts.workspaceFolder, opts.envName)
  const parent = resolved.config
  const extra = (parent as { extra?: Record<string, unknown> }).extra ?? {}
  const parentRunArgs = Array.isArray(parent.runArgs) ? parent.runArgs : []
  const parentContainerEnv =
    parent.containerEnv && typeof parent.containerEnv === 'object'
      ? (parent.containerEnv as Record<string, string>)
      : {}

  const domoRunArgs: string[] = [
    '--label', `domo.envId=${opts.envId}`,
    '--label', `domo.projectId=${opts.projectId}`,
    ...runtime.extraRunArgs,
    ...(opts.publishPorts ?? []).flatMap((p) =>
      // `127.0.0.1:0:<inner>/<proto>` — host loopback, random free port.
      ['-p', `127.0.0.1:0:${p.innerPort}/${p.protocol}`],
    ),
    ...(opts.bindMounts ?? []).flatMap((m) => [
      '--mount',
      `type=bind,source=${m.hostPath},target=${m.containerPath}${m.readOnly ? ',readonly' : ''}`,
    ]),
  ]

  // Domo's runArgs go AFTER the user's so our labels/ports/mounts win
  // on docker-cli last-wins flags. The same applies to containerEnv
  // (Domo's overlay overrides the user's for our pinned keys).
  //
  // `workspaceMount` + `workspaceFolder` are pinned to
  // `/workspaces/<envName>` regardless of any user override. Without
  // both, the CLI defaults `workspaceMount` to
  // `/workspaces/<basename(hostPath)>` — fine for non-root envs (host
  // basename == env.name) but wrong for the root env (host basename
  // == project dir). The engine's path translation
  // (`toHostPath()` in `server/lib/sessionEngine/engine.ts`) assumes
  // the `/workspaces/<envName>` convention everywhere. Step 8 decision
  // #8 — supersedes the earlier "warn on workspaceFolder override"
  // behavior. `workspaceFolder` alone is not enough: it sets the cwd
  // inside the container but doesn't move the bind-mount target;
  // `workspaceMount` is the lever for that.
  const containerWorkspace = `/workspaces/${opts.envName}`
  const merged: Record<string, unknown> = {
    ...extra,
    ...(parent as unknown as Record<string, unknown>),
    workspaceMount: `source=${opts.workspaceFolder},target=${containerWorkspace},type=bind`,
    workspaceFolder: containerWorkspace,
    runArgs: [...parentRunArgs, ...domoRunArgs],
    containerEnv: { ...parentContainerEnv, ...(opts.containerEnv ?? {}) },
  }
  // `extra` was a parser-only field; don't leak it into the on-disk
  // config we hand the CLI.
  delete (merged as { extra?: unknown }).extra

  const overlayJson = JSON.stringify(merged, null, 2)
  // Drift hash tracks the user's intent — the resolved devcontainer
  // config (project's or Domo default), not the merged overlay. The
  // overlay carries Domo-side runtime info (labels, ports, mounts,
  // env) that's deterministic per env and shouldn't surface as drift.
  // Step 8 decision #6.
  const configHash = hashResolvedConfig(resolved.config)

  const tmp = await mkdtemp(join(tmpdir(), 'domo-dc-'))
  const overlayPath = join(tmp, 'devcontainer.json')
  await writeFile(overlayPath, overlayJson, 'utf8')

  const args: string[] = [
    bin,
    'up',
    '--workspace-folder', opts.workspaceFolder,
    '--override-config', overlayPath,
  ]

  try {
    const r = await runCli(args, opts.onLog, opts.signal)
    return {
      ...r,
      configHash,
      devcontainerPath: resolved.path,
      usedDefaultConfig: resolved.isDefault,
    }
  } finally {
    // Best-effort cleanup; the temp dir isn't load-bearing.
    void exec('rm', ['-rf', tmp], { timeout: 5000 }).catch(() => {})
  }
}

/** The subset of `UpResult` that depends on the CLI subprocess output —
 * the rest of the fields (configHash, devcontainerPath, etc.) are
 * computed at the call site in `up()`. */
interface CliRunResult {
  containerId: string
  outcome: 'success'
  raw: unknown
}

async function runCli(
  args: string[],
  onLog: UpOptions['onLog'],
  signal: AbortSignal | undefined,
): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, { signal })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      onLog?.({ stream: 'stdout', text: chunk })
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      onLog?.({ stream: 'stderr', text: chunk })
    })
    child.once('error', reject)
    child.once('close', (code) => {
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      let envelope: { outcome?: 'success' | 'error'; containerId?: string; message?: string } | undefined
      try {
        envelope = lastLine ? JSON.parse(lastLine) : undefined
      } catch {
        envelope = undefined
      }
      if (code !== 0 || envelope?.outcome !== 'success' || !envelope.containerId) {
        reject(new DevcontainerUpError(
          envelope?.message ?? `devcontainer up exited with code ${code}`,
          stderr,
        ))
        return
      }
      resolve({ containerId: envelope.containerId, outcome: 'success', raw: envelope })
    })
  })
}

/**
 * Inspect a container by id; returns null if it's been removed.
 * Mirrors what we need from `docker inspect` flattened into our shape.
 */
export async function inspect(containerId: string): Promise<ContainerInfo | null> {
  try {
    const { stdout } = await exec('docker', ['inspect', containerId], { timeout: 5000 })
    const arr = JSON.parse(stdout) as Array<{
      Id: string
      State: { Status: string; StartedAt: string }
      NetworkSettings: {
        Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>
        Networks?: Record<string, { IPAddress: string }>
      }
    }>
    const c = arr[0]
    if (!c) return null
    const status = mapDockerStatus(c.State?.Status)
    const startedRaw = c.State?.StartedAt
    const startedAt = startedRaw && startedRaw !== '0001-01-01T00:00:00Z'
      ? new Date(startedRaw).getTime()
      : null

    const publishedPorts: ContainerInfo['publishedPorts'] = []
    for (const [innerSpec, bindings] of Object.entries(c.NetworkSettings?.Ports ?? {})) {
      if (!bindings) continue
      const [portStr, proto] = innerSpec.split('/')
      if (!portStr) continue
      const innerPort = Number.parseInt(portStr, 10)
      if (!Number.isFinite(innerPort)) continue
      for (const b of bindings) {
        // Only loopback bindings — we always publish to 127.0.0.1
        // (Decided #9), and external exposure is via a Domo-side
        // forwarder on top, not a wider Docker bind.
        if (b.HostIp !== '127.0.0.1' && b.HostIp !== '') continue
        const hostPort = Number.parseInt(b.HostPort, 10)
        if (!Number.isFinite(hostPort)) continue
        publishedPorts.push({
          innerPort,
          protocol: proto === 'udp' ? 'udp' : 'tcp',
          hostPort,
        })
      }
    }

    const nets = c.NetworkSettings?.Networks ?? {}
    const ipAddress = Object.values(nets).map((n) => n.IPAddress).find(Boolean) ?? null

    return { containerId: c.Id, status, startedAt, publishedPorts, ipAddress }
  } catch {
    return null
  }
}

function mapDockerStatus(s: string | undefined): ContainerInfo['status'] {
  switch (s) {
    case 'running':
    case 'created':
    case 'exited':
    case 'paused':
    case 'restarting':
    case 'dead':
    case 'removing':
      return s
    default:
      return 'unknown'
  }
}

/** Find a container by its `domo.envId` label — used to reconcile after
 * a Domo restart where the stored container id may be stale. */
export async function findByEnvId(envId: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'docker',
      ['ps', '-a', '--filter', `label=domo.envId=${envId}`, '--format', '{{.ID}}'],
      { timeout: 5000 },
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    return lines[0] ?? null
  } catch {
    return null
  }
}

/** Stop a container (graceful, default 10 s timeout). */
export async function stop(containerId: string, timeoutSec = 10): Promise<void> {
  await exec('docker', ['stop', '--time', String(timeoutSec), containerId], { timeout: (timeoutSec + 5) * 1000 })
}

/** Start a stopped container. */
export async function start(containerId: string): Promise<void> {
  await exec('docker', ['start', containerId], { timeout: 30000 })
}

/** Remove a container (force-stops first). Returns true on success,
 * false if it was already gone. */
export async function remove(containerId: string): Promise<boolean> {
  try {
    await exec('docker', ['rm', '--force', containerId], { timeout: 30000 })
    return true
  } catch (err) {
    // `docker rm` exits non-zero with "No such container" if it's already
    // been removed; surface that as a no-op success.
    const msg = err instanceof Error ? err.message : String(err)
    if (/no such container/i.test(msg)) return false
    throw err
  }
}

/**
 * Spawn `docker exec` against an env container. Used for `claude` in
 * step 3b and the terminal WS once we cut over. Returns the raw
 * ChildProcess so the caller can wire stdio.
 *
 * `tty` toggles `-t`; the terminal path uses it, claude (stream-json)
 * does not.
 */
export interface ExecOptions {
  containerId: string
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  tty?: boolean
  /** Default `true`; pipes stdin to the child. */
  interactive?: boolean
}

export function execContainer(opts: ExecOptions): ChildProcess {
  const args: string[] = ['exec']
  if (opts.interactive !== false) args.push('-i')
  if (opts.tty) args.push('-t')
  if (opts.cwd) args.push('-w', opts.cwd)
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`)
  }
  args.push(opts.containerId, ...opts.cmd)
  return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * Read forwardPorts from a parsed config + resolve each entry to
 * inner-port + protocol. Convenience for call sites.
 */
export function resolveForwardPorts(
  cfg: DevcontainerConfig,
): { innerPort: number; protocol: 'tcp' | 'udp'; name: string; label: string | null; appProtocol: 'http' | 'https' | 'tcp' | 'udp' | null }[] {
  const out: ReturnType<typeof resolveForwardPorts> = []
  const entries: ForwardPortEntry[] = cfg.forwardPorts ?? []
  const attrs = cfg.portsAttributes ?? {}
  for (const e of entries) {
    const parsed = parseForwardPort(e)
    if (!parsed) continue
    // Match `portsAttributes` by inner port (the spec keys these by
    // the same string that appears in `forwardPorts`).
    const key = typeof e === 'number' ? String(e) : e.toString()
    const attr = attrs[key] ?? attrs[String(parsed.innerPort)]
    const proto = attr?.protocol
    const appProtocol = proto === 'http' || proto === 'https' || proto === 'tcp' || proto === 'udp'
      ? proto
      : null
    out.push({
      innerPort: parsed.innerPort,
      protocol: parsed.protocol,
      name: attr?.label ?? `port-${parsed.innerPort}`,
      label: attr?.label ?? null,
      appProtocol,
    })
  }
  return out
}

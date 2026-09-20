import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ResolvedDevcontainerConfig } from './config'
import type { DevcontainerConfig, PortAttributes, ResolvedPortConfig } from './types'

const DEVCONTAINER_BIN = (() => {
  try {
    const require = createRequire(process.argv[1] || import.meta.url)
    return join(dirname(require.resolve('@devcontainers/cli/package.json')), 'devcontainer.js')
  } catch (error) {
    console.error('[devcontainer] could not resolve CLI:', error)
    return null
  }
})()

/** Prefix of the Docker resources Domo creates itself (workspace volume, compose project). */
export function resourcePrefix(): string {
  return process.env.NUXT_DEV_ENV_RESOURCE_PREFIX || 'domo-dev-'
}

export interface ContainerInspection {
  id: string
  name: string
  running: boolean
  ipAddress: string | null
  labels: Record<string, string>
  /** Names of the named (not anonymous) volumes mounted into the container. */
  namedVolumes: string[]
  publishedPorts: Array<{ innerPort: number, protocol: 'tcp' | 'udp', hostPort: number }>
}

function hasFeature(features: DevcontainerConfig['features'], fragment: string): boolean {
  return Object.keys(features ?? {}).some(key => key.includes(fragment))
}

function absoluteSourcePaths(config: DevcontainerConfig, configPath: string | null): DevcontainerConfig {
  if (!configPath) return { ...config }
  const base = dirname(configPath)
  const absolutize = (path: string) => isAbsolute(path) ? path : resolve(base, path)
  const next = { ...config }
  if (next.dockerFile) next.dockerFile = absolutize(next.dockerFile)
  if (next.context) next.context = absolutize(next.context)
  if (typeof next.build === 'object' && next.build) {
    next.build = {
      ...next.build,
      dockerfile: absolutize(next.build.dockerfile),
      context: next.build.context ? absolutize(next.build.context) : base
    }
  }
  if (next.dockerComposeFile) {
    next.dockerComposeFile = Array.isArray(next.dockerComposeFile)
      ? next.dockerComposeFile.map(absolutize)
      : absolutize(next.dockerComposeFile)
  }
  return next
}

function mergedConfig(input: {
  resolved: ResolvedDevcontainerConfig
  environmentId: string
  projectId: string
  environmentName: string
  workspaceVolume: string
  composeOverridePath: string | null
  ports: ResolvedPortConfig[]
  claudeConfigDir: string | null
  codexConfigDir: string | null
}): DevcontainerConfig {
  const parent = absoluteSourcePaths(input.resolved.config, input.resolved.path)
  const features = { ...(parent.features ?? {}) }
  if (!hasFeature(features, '/node:')) {
    features['ghcr.io/devcontainers/features/node:1'] = { version: '22' }
  }
  if (!hasFeature(features, 'docker-in-docker')) {
    features['ghcr.io/devcontainers/features/docker-in-docker:2'] = { version: 'latest' }
  }

  const safeName = input.environmentName.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()
  const domoWorkspaceFolder = `/workspaces/${safeName || input.environmentId}`
  const runArgs = [
    ...(parent.runArgs ?? []),
    '--privileged',
    '--label', `domo.envId=${input.environmentId}`,
    '--label', `domo.projectId=${input.projectId}`,
    '--add-host', 'host.docker.internal:host-gateway'
  ]
  if (!parent.dockerComposeFile) {
    for (const port of input.ports) {
      runArgs.push('-p', `127.0.0.1:0:${port.innerPort}/${port.protocol}`)
    }
  }

  const mounts = [...(parent.mounts ?? [])]
  if (input.claudeConfigDir) {
    const user = parent.remoteUser ?? parent.containerUser ?? 'root'
    const target = user === 'root' ? '/root/.claude' : `/home/${user}/.claude`
    mounts.push({ source: input.claudeConfigDir, target, type: 'bind' })
  }
  if (input.codexConfigDir) {
    const user = parent.remoteUser ?? parent.containerUser ?? 'root'
    const target = user === 'root' ? '/root/.codex' : `/home/${user}/.codex`
    mounts.push({ source: input.codexConfigDir, target, type: 'bind' })
  }

  const merged: DevcontainerConfig = {
    ...parent,
    name: parent.name ?? `Domo: ${input.environmentName}`,
    privileged: true,
    features,
    runArgs,
    mounts,
    containerEnv: {
      ...(parent.containerEnv ?? {}),
      DOMO_DEV_ENVIRONMENT_ID: input.environmentId
    }
  }
  if (parent.dockerComposeFile) {
    // The compose file mounts the host checkout itself; the override swaps those mounts for the volume.
    if (input.composeOverridePath) {
      merged.dockerComposeFile = [
        ...(Array.isArray(parent.dockerComposeFile) ? parent.dockerComposeFile : [parent.dockerComposeFile]),
        input.composeOverridePath
      ]
    }
  } else {
    const folder = parent.workspaceFolder ?? domoWorkspaceFolder
    merged.workspaceMount = `source=${input.workspaceVolume},target=${folder},type=volume`
    merged.workspaceFolder = folder
  }
  return merged
}

interface ComposeService {
  volumes?: Array<{ type?: string, source?: string, target?: string }>
}

/**
 * Compose files bind the checkout with a relative path (`..:/workspaces/app`).
 * That resolves to the host checkout, which is exactly what the volume replaces.
 * Ask compose what every service mounts, and emit an override that mounts the
 * volume at the same target instead. A bind of a sub-directory becomes a
 * `subpath` mount of the same volume (Docker Engine 26+), so the whole tree stays
 * inside the environment. Returns null when nothing mounts the checkout.
 */
export async function composeWorkspaceOverride(
  composeFiles: string[],
  repoPath: string,
  volume: string
): Promise<string | null> {
  const { stdout } = await run('docker', [
    'compose', ...composeFiles.flatMap(file => ['-f', file]), 'config', '--format', 'json'
  ])
  const root = await realpath(repoPath)
  const services: Record<string, ComposeService> = JSON.parse(stdout).services ?? {}
  const overridden: Record<string, { volumes: unknown[] }> = {}
  for (const [name, service] of Object.entries(services)) {
    for (const mount of service.volumes ?? []) {
      if (mount.type !== 'bind' || !mount.source || !mount.target) continue
      const source = await realpath(mount.source).catch(() => resolve(mount.source!))
      const rel = relative(root, source)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      const entry = {
        type: 'volume',
        source: volume,
        target: mount.target,
        ...(rel && { volume: { subpath: rel.split(sep).join('/') } })
      }
      ;(overridden[name] ??= { volumes: [] }).volumes.push(entry)
    }
  }
  if (!Object.keys(overridden).length) return null
  // JSON is valid YAML, so compose reads it without us needing a YAML writer.
  return JSON.stringify({ services: overridden, volumes: { [volume]: { external: true } } }, null, 2)
}

export interface DevcontainerLaunch {
  resolved: ResolvedDevcontainerConfig
  environmentId: string
  projectId: string
  environmentName: string
  /** Named volume that holds the checkout; the caller has already populated it. */
  workspaceVolume: string
  /** The project's own checkout on the host: build contexts and compose files are read from here. */
  repoPath: string
  ports: ResolvedPortConfig[]
  claudeConfigDir: string | null
  codexConfigDir: string | null
  /** Runs once the container exists, before lifecycle commands (chown the volume here). */
  afterCreate?: (result: { containerId: string, workspacePath: string, remoteUser: string | null }) => Promise<void>
}

export async function devcontainerUp(
  input: DevcontainerLaunch
): Promise<{ containerId: string, workspacePath: string, remoteUser: string | null }> {
  if (!DEVCONTAINER_BIN) throw new Error('The packaged Dev Container CLI could not be found.')
  // Scratch dir: config, compose override, and the CLI's --workspace-folder. It only has to
  // be unique (the CLI derives the image tag from it) and it never holds the checkout.
  const directory = await mkdtemp(join(tmpdir(), 'domo-devcontainer-'))
  try {
    const parent = absoluteSourcePaths(input.resolved.config, input.resolved.path)
    let composeOverridePath: string | null = null
    if (parent.dockerComposeFile) {
      const files = Array.isArray(parent.dockerComposeFile) ? parent.dockerComposeFile : [parent.dockerComposeFile]
      const override = await composeWorkspaceOverride(files, input.repoPath, input.workspaceVolume)
      if (override) {
        composeOverridePath = join(directory, 'compose.workspace.yml')
        await writeFile(composeOverridePath, override, 'utf8')
      }
    }
    const config = mergedConfig({ ...input, composeOverridePath })
    const path = join(directory, 'devcontainer.json')
    await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
    // One compose project per environment, otherwise every environment of a compose-based
    // project shares `<folder>_devcontainer` and `compose up` recreates the other's container.
    const env = { ...process.env, COMPOSE_PROJECT_NAME: `${resourcePrefix()}${input.environmentId}`.toLowerCase() }
    const common = [
      '--workspace-folder', directory,
      '--id-label', `domo.envId=${input.environmentId}`,
      '--override-config', path
    ]
    const output = await run(process.execPath, [
      DEVCONTAINER_BIN, 'up', ...common,
      // Lifecycle commands wait until the volume is owned by the remote user.
      '--skip-post-create',
      // 0.89 tries to write `<workspace>/.devcontainer/devcontainer-lock.json` and dies with
      // ENOENT when the workspace has no .devcontainer (default and .domo.json sources).
      '--no-lockfile'
    ], { env })
    const line = output.stdout.trim().split('\n').filter(Boolean).pop()
    const result = line ? JSON.parse(line) as {
      outcome?: string
      containerId?: string
      message?: string
      remoteUser?: string
      remoteWorkspaceFolder?: string
    } : null
    if (result?.outcome !== 'success' || !result.containerId) {
      throw new Error(result?.message || output.stderr || 'Dev Container CLI did not return a container id.')
    }
    const created = {
      containerId: result.containerId,
      workspacePath: result.remoteWorkspaceFolder ?? config.workspaceFolder ?? '/workspaces/repo',
      remoteUser: result.remoteUser ?? config.remoteUser ?? config.containerUser ?? null
    }
    await input.afterCreate?.(created)
    await run(process.execPath, [DEVCONTAINER_BIN, 'run-user-commands', ...common], { env })
    return created
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Stream the host checkout into a named volume: `tar` on the host into `tar -x` in a throwaway
 * container. No bind mount of the host tree, so it does not depend on Docker Desktop file
 * sharing (or on the daemon being on this machine at all).
 */
export async function populateWorkspaceVolume(input: {
  source: string
  volume: string
  helperImage: string
  /** Paths relative to `source` to leave out (the data directory when it lives in the project). */
  exclude?: string[]
}): Promise<void> {
  const tarArgs = [
    '-C', input.source,
    ...(input.exclude ?? []).flatMap(path => ['--exclude', `./${path}`]),
    '-cf', '-', '.'
  ]
  await new Promise<void>((resolvePromise, reject) => {
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble `._*` companion files.
    const producer = spawn('tar', tarArgs, {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const consumer = spawn('docker', [
      'run', '--rm', '--interactive', '--volume', `${input.volume}:/workspace`, input.helperImage,
      'tar', '-xf', '-', '-C', '/workspace', '--no-same-owner'
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    for (const child of [producer, consumer]) {
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', chunk => (stderr += chunk))
      child.once('error', reject)
    }
    producer.stdout!.pipe(consumer.stdin!)
    const codes: number[] = []
    const done = (code: number | null) => {
      codes.push(code ?? 1)
      if (codes.length < 2) return
      if (codes.every(value => value === 0)) resolvePromise()
      else reject(new Error(`copying the checkout into ${input.volume} failed: ${stderr.trim() || `exit ${codes}`}`))
    }
    producer.once('close', done)
    consumer.once('close', done)
  })
}

/** What the Dev Container CLI recorded on the container: the merged `devcontainer.metadata` label. */
export function devcontainerMetadata(labels: Record<string, string>): {
  portsAttributes: Record<string, PortAttributes>
  otherPortsAttributes?: PortAttributes
} {
  let entries: Array<Partial<DevcontainerConfig>> = []
  try {
    const parsed = JSON.parse(labels['devcontainer.metadata'] ?? '[]')
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch { /* an unreadable label just means no port attributes */ }
  const portsAttributes: Record<string, PortAttributes> = {}
  let otherPortsAttributes: PortAttributes | undefined
  for (const entry of entries) {
    Object.assign(portsAttributes, entry.portsAttributes)
    otherPortsAttributes = entry.otherPortsAttributes ?? otherPortsAttributes
  }
  return { portsAttributes, otherPortsAttributes }
}

export async function run(
  program: string,
  args: string[],
  options: { cwd?: string, env?: NodeJS.ProcessEnv, input?: string, allowFailure?: boolean, trimOutput?: boolean } = {}
): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise({
          stdout: options.trimOutput === false ? stdout : stdout.trim(),
          stderr: stderr.trim()
        })
      } else {
        reject(new Error(`${basename(program)} ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${code}`}`))
      }
    })
    child.stdin.end(options.input)
  })
}

export async function inspectContainer(reference: string): Promise<ContainerInspection | null> {
  const output = await run('docker', ['inspect', reference], { allowFailure: true })
  if (!output.stdout) return null
  try {
    const container = JSON.parse(output.stdout)[0] as any
    const publishedPorts: ContainerInspection['publishedPorts'] = []
    for (const [spec, bindings] of Object.entries(container.NetworkSettings?.Ports ?? {})) {
      if (!Array.isArray(bindings)) continue
      const [rawPort, rawProtocol] = spec.split('/')
      for (const binding of bindings as Array<{ HostIp: string, HostPort: string }>) {
        const innerPort = Number(rawPort)
        const hostPort = Number(binding.HostPort)
        if (Number.isInteger(innerPort) && Number.isInteger(hostPort)) {
          publishedPorts.push({
            innerPort,
            hostPort,
            protocol: rawProtocol === 'udp' ? 'udp' : 'tcp'
          })
        }
      }
    }
    const networks = Object.values(container.NetworkSettings?.Networks ?? {}) as Array<{ IPAddress?: string }>
    return {
      id: container.Id,
      name: String(container.Name ?? '').replace(/^\//, ''),
      running: container.State?.Running === true,
      ipAddress: networks.find(network => network.IPAddress)?.IPAddress ?? null,
      labels: container.Config?.Labels ?? {},
      namedVolumes: ((container.Mounts ?? []) as Array<{ Type?: string, Name?: string }>)
        .filter(mount => mount.Type === 'volume' && mount.Name && !/^[0-9a-f]{64}$/.test(mount.Name))
        .map(mount => mount.Name!),
      publishedPorts
    }
  } catch {
    return null
  }
}

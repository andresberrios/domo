import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { ResolvedDevcontainerConfig } from './config'
import type { DevcontainerConfig, ResolvedPortConfig } from './types'

const DEVCONTAINER_BIN = (() => {
  try {
    const require = createRequire(process.argv[1] || import.meta.url)
    return join(dirname(require.resolve('@devcontainers/cli/package.json')), 'devcontainer.js')
  } catch (error) {
    console.error('[devcontainer] could not resolve CLI:', error)
    return null
  }
})()

export interface ContainerInspection {
  id: string
  name: string
  running: boolean
  ipAddress: string | null
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
  hostWorkspace: string
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
  if (input.resolved.source !== 'devcontainer') {
    merged.workspaceMount = `source=${input.hostWorkspace},target=${domoWorkspaceFolder},type=bind`
    merged.workspaceFolder = domoWorkspaceFolder
  }
  return merged
}

export async function devcontainerUp(input: {
  resolved: ResolvedDevcontainerConfig
  environmentId: string
  projectId: string
  environmentName: string
  hostWorkspace: string
  ports: ResolvedPortConfig[]
  claudeConfigDir: string | null
  codexConfigDir: string | null
}): Promise<{ containerId: string, workspacePath: string, remoteUser: string | null }> {
  if (!DEVCONTAINER_BIN) throw new Error('The packaged Dev Container CLI could not be found.')
  const config = mergedConfig(input)
  const directory = await mkdtemp(join(tmpdir(), 'domo-devcontainer-'))
  const path = join(directory, 'devcontainer.json')
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  try {
    const output = await run(process.execPath, [
      DEVCONTAINER_BIN,
      'up',
      '--workspace-folder', input.hostWorkspace,
      '--override-config', path
    ])
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
    return {
      containerId: result.containerId,
      workspacePath: result.remoteWorkspaceFolder ?? config.workspaceFolder ?? '/workspaces/repo',
      remoteUser: result.remoteUser ?? config.remoteUser ?? config.containerUser ?? null
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function run(
  program: string,
  args: string[],
  options: { cwd?: string, input?: string, allowFailure?: boolean, trimOutput?: boolean } = {}
): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
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
      publishedPorts
    }
  } catch {
    return null
  }
}

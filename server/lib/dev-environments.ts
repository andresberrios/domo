import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { newId } from './db'
import {
  createDevEnvironmentRow,
  deleteDevEnvironmentRow,
  getDevEnvironment,
  getProject,
  updateDevEnvironment
} from './repo'
import type { DevEnvironment } from '../../shared/types'

const IMAGE = process.env.NUXT_DEV_ENV_IMAGE || 'domo-dev-environment:latest'
const WORKSPACE = '/workspace/repo'

interface CommandOptions {
  cwd?: string
  input?: string
  allowFailure?: boolean
  trimOutput?: boolean
}

async function command(program: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        return resolvePromise(options.trimOutput === false ? stdout : stdout.trim())
      }
      reject(new Error(`${program} ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${code}`}`))
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

let imageBuild: Promise<void> | null = null

async function ensureImage(): Promise<void> {
  try {
    await command('docker', ['image', 'inspect', IMAGE])
    return
  } catch {
    // Build once when several environment requests arrive together.
  }
  if (!imageBuild) {
    imageBuild = command('docker', [
      'build',
      '--file',
      join(process.cwd(), 'docker/dev-environment.Dockerfile'),
      '--tag',
      IMAGE,
      process.cwd()
    ]).then(() => undefined).finally(() => {
      imageBuild = null
    })
  }
  await imageBuild
}

function containerName(id: string): string {
  return `domo-dev-${id.replace(/[^a-zA-Z0-9_.-]/g, '-')}`.toLowerCase()
}

async function containerRunning(name: string): Promise<boolean> {
  const value = await command(
    'docker',
    ['inspect', '--format', '{{.State.Running}}', name],
    { allowFailure: true }
  )
  return value === 'true'
}

export async function createEnvironment(input: {
  projectId: string
  name: string
}): Promise<DevEnvironment> {
  const project = await getProject(input.projectId)
  if (!project) throw new Error('Project not found')
  await access(join(project.repoPath, '.git'))

  const id = newId('env')
  const name = containerName(id)
  const environment = await createDevEnvironmentRow({
    id,
    projectId: project.id,
    name: input.name.trim(),
    containerName: name,
    workspacePath: WORKSPACE
  })

  try {
    await ensureImage()
    const volume = `${name}-workspace`
    const args = [
      'run', '--detach', '--privileged',
      '--name', name,
      '--hostname', name,
      '--label', `com.domo.dev-environment=${environment.id}`,
      '--add-host', 'host.docker.internal:host-gateway',
      '--volume', `${volume}:/workspace`,
      '--env', 'DOCKER_TLS_CERTDIR=',
      '--env', `DOMO_AGENT_UID=${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
      '--env', `DOMO_AGENT_GID=${typeof process.getgid === 'function' ? process.getgid() : 1000}`,
      IMAGE
    ]
    const claudeConfig = process.env.NUXT_CLAUDE_CONFIG_DIR
      || (process.env.HOME ? join(process.env.HOME, '.claude') : '')
    if (claudeConfig) {
      await access(claudeConfig).then(() => {
        args.splice(args.length - 1, 0, '--volume', `${claudeConfig}:/home/node/.claude`)
      }).catch(() => {})
    }
    await command('docker', args)
    await command('docker', ['exec', name, 'docker', 'info'])
    await command('docker', ['cp', `${project.repoPath}/.`, `${name}:${WORKSPACE}`])
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
    await command('docker', ['exec', name, 'chown', '-R', `${uid}:${gid}`, '/workspace'])
    await command('docker', [
      'exec', '--user', `${uid}:${gid}`, '--env', 'HOME=/home/node', name,
      'git', 'config', '--global', '--add', 'safe.directory', WORKSPACE
    ])
    return (await updateDevEnvironment(environment.id, { status: 'running', lastError: null }))!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDevEnvironment(environment.id, { status: 'error', lastError: message })
    await command('docker', ['rm', '--force', name], { allowFailure: true }).catch(() => {})
    await command('docker', ['volume', 'rm', `${name}-workspace`], { allowFailure: true }).catch(() => {})
    throw error
  }
}

export async function startEnvironment(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  if (!(await containerRunning(environment.containerName))) {
    await command('docker', ['start', environment.containerName])
  }
  return (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
}

export async function stopEnvironment(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  if (await containerRunning(environment.containerName)) {
    await command('docker', ['stop', environment.containerName])
  }
  return (await updateDevEnvironment(id, { status: 'stopped' }))!
}

export async function ensureEnvironmentRunning(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  if (await containerRunning(environment.containerName)) {
    if (environment.status !== 'running') {
      return (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
    }
    return environment
  }
  return startEnvironment(id)
}

export async function removeEnvironment(id: string): Promise<void> {
  const environment = await getDevEnvironment(id)
  if (!environment) return
  await command('docker', ['rm', '--force', '--volumes', environment.containerName], { allowFailure: true }).catch(() => {})
  await command('docker', ['volume', 'rm', `${environment.containerName}-workspace`], { allowFailure: true }).catch(() => {})
  await deleteDevEnvironmentRow(id)
}

export function containerExecArgs(environment: DevEnvironment, env: NodeJS.ProcessEnv = {}): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const args = ['exec', '--interactive', '--user', `${uid}:${gid}`, '--workdir', environment.workspacePath]
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push('--env', `${key}=${value}`)
  }
  args.push(environment.containerName)
  return args
}

export async function readEnvironmentFile(environment: DevEnvironment, path: string): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  return command(
    'docker',
    ['exec', '--user', `${uid}:${gid}`, environment.containerName, 'cat', path],
    { trimOutput: false }
  )
}

export async function writeEnvironmentFile(
  environment: DevEnvironment,
  path: string,
  content: string
): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  await command('docker', [
    'exec', '--interactive', '--user', `${uid}:${gid}`, environment.containerName,
    'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path
  ], { input: content })
}

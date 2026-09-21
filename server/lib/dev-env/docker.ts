import { spawn } from 'node:child_process'
import { basename } from 'node:path'

/** Prefix of the Docker resources Domo creates itself (containers, images, volumes). */
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

/** The daemon's architecture, which decides what an image built or pulled for it contains. */
export async function dockerServerArch(): Promise<string> {
  const { stdout } = await run('docker', ['version', '--format', '{{.Server.Arch}}'], { allowFailure: true })
  return stdout || 'unknown'
}

/**
 * `tar` on the host piped into a `tar -x` that Docker runs, wherever that is.
 *
 * The host tree is never bind-mounted, so this does not depend on Docker Desktop
 * file sharing — or on the daemon being on this machine at all.
 */
async function tarInto(input: {
  source: string
  /** Paths relative to `source` to copy. `['.']` is the whole tree. */
  entries: string[]
  exclude?: string[]
  /** The `docker` argv that receives the archive on stdin. */
  consumerArgs: string[]
  label: string
}): Promise<void> {
  const tarArgs = [
    '-C', input.source,
    ...(input.exclude ?? []).flatMap(path => ['--exclude', `./${path}`]),
    '-cf', '-', ...input.entries
  ]
  await new Promise<void>((resolvePromise, reject) => {
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble `._*` companion files.
    const producer = spawn('tar', tarArgs, {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const consumer = spawn('docker', input.consumerArgs, { stdio: ['pipe', 'ignore', 'pipe'] })
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
      else reject(new Error(`copying ${input.label} failed: ${stderr.trim() || `exit ${codes}`}`))
    }
    producer.once('close', done)
    consumer.once('close', done)
  })
}

/** The checkout, into the named volume that becomes the environment's workspace. */
export async function populateWorkspaceVolume(input: {
  source: string
  volume: string
  helperImage: string
  /** Paths relative to `source` to leave out (the data directory when it lives in the project). */
  exclude?: string[]
}): Promise<void> {
  await tarInto({
    source: input.source,
    entries: ['.'],
    exclude: input.exclude,
    label: `the checkout into ${input.volume}`,
    consumerArgs: [
      'run', '--rm', '--interactive', '--volume', `${input.volume}:/workspace`, input.helperImage,
      'tar', '-xf', '-', '-C', '/workspace', '--no-same-owner'
    ]
  })
}

/**
 * Named entries of a host directory into a path in a running container, owned by
 * the user the extraction runs as.
 */
export async function copyIntoContainer(input: {
  source: string
  entries: string[]
  containerId: string
  user: string
  target: string
}): Promise<void> {
  await tarInto({
    source: input.source,
    entries: input.entries,
    label: `${input.entries.join(', ')} into ${input.target}`,
    consumerArgs: [
      'exec', '--interactive', '--user', input.user, input.containerId,
      'tar', '-xf', '-', '-C', input.target, '--no-same-owner'
    ]
  })
}

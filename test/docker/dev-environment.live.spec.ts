import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment, WorkingTreeMode } from '~~/shared/types'

/**
 * Creating a development environment for real: the real Dev Container CLI building a
 * real image, a real `docker run`, the real `createEnvironment` / `retireEnvironment`.
 * Only what is backed by Postgres (`repo`) is replaced, by an in-memory map that behaves
 * like the tables, and the port scanner, which reads them.
 *
 * `dev-environments.spec.ts` asserts on the argv handed to `docker`; that is how
 * "`devcontainer up` dies on a missing lockfile directory" got through — the argv was
 * right and the CLI still refused it. Nothing short of running it against a checkout
 * that looks like a real project can say.
 *
 * Slow (it pulls base images, builds Features and populates the runtime volume on the
 * first run) and needs the network. Opt in: `pnpm test:docker`.
 */

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  ports: [] as any[],
  project: null as any,
  homeMounts: [] as string[],
  // Off for the layer: the browser volume is several hundred megabytes and
  // only the two tests below have anything to say about it.
  browserTools: false
}))

vi.mock('../../server/lib/repo', () => ({
  getProject: async () => state.project,
  createDevEnvironmentRow: async (input: any) => {
    const now = new Date().toISOString()
    const row = {
      containerId: null,
      configSource: 'default',
      configPath: null,
      remoteUser: null,
      status: 'creating',
      lastError: null,
      createdAt: now,
      updatedAt: now,
      ...input
    }
    state.rows.set(input.id, row)
    return row
  },
  updateDevEnvironment: async (id: string, patch: any) => {
    const row = state.rows.get(id)
    if (!row) return null
    Object.assign(row, patch)
    return row
  },
  getDevEnvironment: async (id: string) => state.rows.get(id) ?? null,
  retireDevEnvironmentRow: async (id: string) => { state.rows.delete(id) },
  pruneRetiredRecords: async () => ({ environments: 0, projects: 0 }),
  upsertDevEnvironmentPort: async (port: any) => { state.ports.push(port) },
  // The import tells every agent session in the environment where the changes
  // are; this project has no Postgres, and no session ever runs in these.
  listAgentSessions: async () => [],
  enqueueInboxMessage: async () => ({})
}))
// Settings live in Postgres, which this project does not have. The home
// overlay is the only thing under test that reads them.
vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({ homeMounts: state.homeMounts, browserTools: state.browserTools })
}))
vi.mock('../../server/lib/dev-environment-ports', () => ({
  refreshEnvironmentPorts: async () => [],
  stopEnvironmentForwarders: () => {}
}))

// Every Docker resource Domo creates for these tests is named with this, so a
// crashed run is easy to find and sweep by hand.
const PREFIX = 'domo-live-test-'
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = PREFIX

const { run, inspectContainer, populateWorkspaceVolume } = await import('../../server/lib/dev-env/docker')
const { DEFAULT_IMAGE } = await import('../../server/lib/dev-env/config')
const { environmentImageName } = await import('../../server/lib/dev-env/image')
const { ensureRuntimeVolume, runtimeVolumeName } = await import('../../server/lib/dev-env/runtime-volume')
const {
  createEnvironment,
  readEnvironmentFile,
  retireEnvironment,
  workspaceVolumeName
} = await import('../../server/lib/dev-environments')
const { exportBranch, listEnvironmentBranches } = await import('../../server/lib/dev-env/git-sync')
const { importBranchIntoEnvironment } = await import('../../server/lib/branch-import')
const { BROWSER_ROOT } = await import('../../server/lib/dev-env/browser-volume')
const { doodSocketDir, stopDoodProxy, sweepEnvironmentResources } = await import('../../server/lib/dood/manager')
const { portHelperImage, portHelperName } = await import('../../server/lib/dev-env/port-helper')

const HOUR = 60 * 60 * 1000
const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
/** A glibc image with git and no Node of its own — the case the runtime volume exists for. */
const BARE_IMAGE_DOCKERFILE = 'FROM debian:bookworm-slim\n'
  + 'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates '
  + '&& rm -rf /var/lib/apt/lists/*\n'
  + 'RUN useradd --create-home --shell /bin/bash dev\n'

const created: string[] = []
const scratch: string[] = []
const volumes: string[] = []
const servers: Array<{ close: (done: () => void) => void }> = []

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `domo-live-${prefix}-`))
  scratch.push(path)
  return path
}

async function git(repo: string, ...args: string[]) {
  await run('git', ['-C', repo, '-c', 'user.name=Domo Test', '-c', 'user.email=test@example.com', ...args])
}

async function writeIn(repo: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true })
    await writeFile(join(repo, name), content, 'utf8')
  }
}

/** A committed git checkout, the way a project is when someone adds it in Domo. */
async function checkout(files: Record<string, string> = {}): Promise<string> {
  const repo = await temp('repo')
  await run('git', ['init', '--quiet', '--initial-branch=main', repo])
  await writeIn(repo, { 'README.md': '# fixture\n', 'src/index.ts': 'export {}\n', ...files })
  await git(repo, 'add', '--all')
  await git(repo, 'commit', '--quiet', '-m', 'fixture')
  return repo
}

/** What is inside the container, as the environment's own user. */
async function inContainer(environment: DevEnvironment, ...command: string[]): Promise<string> {
  const output = await run('docker', [
    'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
    environment.containerId!, ...command
  ], { allowFailure: true })
  return output.stdout
}

async function mounts(containerId: string): Promise<Array<{ Type: string, Name?: string, Source: string, Destination: string }>> {
  const output = await run('docker', ['inspect', '--format', '{{json .Mounts}}', containerId])
  return JSON.parse(output.stdout)
}

async function isPrivileged(containerId: string): Promise<boolean> {
  const output = await run('docker', ['inspect', '--format', '{{.HostConfig.Privileged}}', containerId])
  return output.stdout === 'true'
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function create(name = 'Live Test', workingTree?: WorkingTreeMode): Promise<DevEnvironment> {
  const environment = await createEnvironment({ projectId: 'prj_live', name, workingTree })
  created.push(environment.id)
  return environment
}

/**
 * A stand-in for the host user's home: a git identity, an SSH directory and a
 * `gh` config. Never the real one — the whole point of the overlay is that it
 * mounts the developer's actual credentials.
 */
async function hostHome(): Promise<string> {
  const home = await temp('home')
  await writeIn(home, {
    '.gitconfig': '[user]\n\tname = Domo Live Test\n\temail = live@example.com\n'
      // A helper the container does not have, which is the reason the host file
      // is included rather than used as the container's own config.
      + '[credential]\n\thelper = osxkeychain\n',
    // `UseKeychain` is Apple's alone, and Linux OpenSSH calls an unknown
    // option fatal — this is the line that used to abort every `ssh` in the
    // container, `git push` included.
    '.ssh/config': 'Host github.com\n  UseKeychain yes\n  IdentityFile ~/.ssh/id_ed25519\n',
    '.ssh/id_ed25519': 'not a real key\n',
    '.ssh/known_hosts': 'github.com ssh-ed25519 AAAAdummy\n',
    '.config/gh/hosts.yml': 'github.com:\n  user: domo-live-test\n'
  })
  return home
}

/** A real listening unix socket, standing in for the host's SSH agent. */
async function agentSocket(): Promise<string> {
  const path = join(await temp('agent'), 'agent.sock')
  const server = createServer()
  await new Promise<void>(ready => server.listen(path, ready))
  servers.push(server)
  return path
}

beforeAll(async () => {
  // `docker info` first: with no daemon every test below would fail with a much less
  // helpful message from several layers down.
  await run('docker', ['info', '--format', '{{.ServerVersion}}'])

  process.env.NUXT_DATA_DIR = await temp('data')
  // The tools mounted into an environment are the developer's own config; never
  // hand a test the real ones.
  process.env.NUXT_CLAUDE_CONFIG_DIR = await temp('claude')
  process.env.NUXT_CODEX_CONFIG_DIR = await temp('codex')
  process.env.NUXT_HOME_OVERLAY_DIR = await hostHome()
  process.env.SSH_AUTH_SOCK = await agentSocket()
  state.homeMounts = ['.ssh', '.gitconfig', '.config/gh', '.kube']
})

afterEach(async () => {
  // Whatever a failed assertion left behind.
  for (const id of created.splice(0)) {
    const found = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`], {
      allowFailure: true
    })
    for (const container of found.stdout.split('\n').filter(Boolean)) {
      const named = (await mounts(container).catch(() => []))
        .filter(mount => mount.Type === 'volume' && mount.Name?.includes('dind-var-lib-docker'))
        .map(mount => mount.Name!)
      await run('docker', ['rm', '--force', '--volumes', container], { allowFailure: true })
      for (const volume of named) await run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true })
    }
    await stopDoodProxy(id)
    await sweepEnvironmentResources(id)
    await run('docker', ['volume', 'rm', '--force', workspaceVolumeName(id)], { allowFailure: true })
    await run('docker', ['image', 'rm', '--force', environmentImageName(id)], { allowFailure: true })
  }
  for (const volume of volumes.splice(0)) {
    await run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true })
  }
})

afterAll(async () => {
  // The port helper serves every environment, so no environment's teardown
  // takes it; this run's is named for the test prefix, image included.
  await run('docker', ['rm', '--force', portHelperName()], { allowFailure: true })
  await run('docker', ['image', 'rm', portHelperImage()], { allowFailure: true })
  delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
  // The proxies' sockets live under the home directory, in a folder named for
  // this run's scratch data directory.
  await rm(doodSocketDir(), { recursive: true, force: true })
  delete process.env.NUXT_DATA_DIR
  delete process.env.NUXT_CLAUDE_CONFIG_DIR
  delete process.env.NUXT_CODEX_CONFIG_DIR
  delete process.env.NUXT_HOME_OVERLAY_DIR
  delete process.env.SSH_AUTH_SOCK
  for (const server of servers) await new Promise<void>(done => server.close(() => done()))
  for (const path of scratch) await rm(path, { recursive: true, force: true })
})

describe('an environment for a project with no .domo.json', () => {
  it('comes up with the built-in definition and tears down completely', async () => {
    const repo = await checkout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create()

    expect(environment).toMatchObject({
      status: 'running',
      lastError: null,
      workspacePath: '/workspaces/live-test',
      configSource: 'default',
      configPath: null
    })
    expect((await inspectContainer(environment.containerId!))?.running).toBe(true)

    // The checkout is the environment's own volume, and nothing binds the developer's
    // tree or Domo's data into it.
    const all = await mounts(environment.containerId!)
    expect(all).toContainEqual(expect.objectContaining({
      Type: 'volume',
      Name: workspaceVolumeName(environment.id),
      Destination: '/workspaces/live-test'
    }))
    expect(all.filter(mount => mount.Type === 'bind').map(mount => mount.Source).join('\n')).not.toContain(repo)

    // The project is in there, owned by the environment's user, and git is happy with it.
    await expect(readEnvironmentFile(environment, '/workspaces/live-test/README.md')).resolves.toBe('# fixture\n')
    await expect(inContainer(environment, 'stat', '-c', '%U', '.')).resolves.toBe(environment.remoteUser)
    await expect(inContainer(environment, 'git', 'log', '--oneline')).resolves.toMatch(/fixture/)
    await expect(inContainer(environment, 'git', 'status', '--porcelain')).resolves.toBe('')

    // Work in the environment stays in the environment.
    await inContainer(environment, 'sh', '-c', 'echo scribble > written-inside.txt')
    expect(await exists(join(repo, 'written-inside.txt'))).toBe(false)

    // The default definition asks for Node and Docker, so both are there —
    // and Docker is the *host's* daemon, reached through Domo's proxy socket,
    // so there is no privilege and no nested image store.
    await expect(inContainer(environment, 'node', '--version')).resolves.toMatch(/^v22\./)
    expect(await isPrivileged(environment.containerId!)).toBe(false)
    expect(all.map(mount => mount.Name ?? '').join('\n')).not.toContain('dind-var-lib-docker')
    expect(all).toContainEqual(expect.objectContaining({ Type: 'bind', Destination: '/var/run/docker.sock' }))
    const hostDaemon = await run('docker', ['info', '--format', '{{.ID}}'])
    await expect(inContainer(environment, 'docker', 'info', '--format', '{{.ID}}'))
      .resolves.toBe(hostDaemon.stdout)

    // The case the proxy exists for, as the environment's own user: a compose
    // stack mounting the checkout, brought up from inside the environment.
    await inContainer(environment, 'sh', '-c', [
      'mkdir -p site && echo from-the-checkout > site/index.html',
      'printf "%s\\n" "services:" "  web:" "    image: busybox:1.37"'
      + ' "    command: [\\"httpd\\", \\"-f\\", \\"-p\\", \\"8080\\", \\"-h\\", \\"/site\\"]"'
      + ' "    volumes: [\\"./site:/site:ro\\"]" "    ports: [\\"8080:8080\\"]" > compose.yaml'
    ].join(' && '))
    const up = await run('docker', [
      'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, 'docker', 'compose', '-p', 'livestack', 'up', '-d'
    ])
    expect(up.stderr).toMatch(/Started/)
    // On the host daemon, stamped with the environment, publishing nothing.
    const stack = (await run('docker', ['ps', '-q', '--filter', `label=domo.env=${environment.id}`])).stdout
    expect(stack.split('\n').filter(Boolean)).toHaveLength(1)
    const bindings = await run('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', stack])
    expect(bindings.stdout).toBe('{}')
    // The checkout reached the service, and the environment can reach the
    // service by name because it joined the stack's network.
    await expect(inContainer(environment, 'sh', '-c', 'curl -s http://web:8080/index.html'))
      .resolves.toBe('from-the-checkout')
    // …and at `localhost:8080`, where `ports:` published it: on the
    // environment's own localhost, not the daemon's host.
    await expect(inContainer(environment, 'sh', '-c',
      'for i in $(seq 1 40); do curl -sf http://localhost:8080/index.html && exit 0; sleep 0.25; done; exit 1'))
      .resolves.toBe('from-the-checkout')
    // A service calling back to a dev server the agent bound to loopback.
    await run('docker', [
      'exec', '--detach', '--user', environment.remoteUser!, environment.containerId!,
      'node', '-e', 'require("http").createServer((q, r) => r.end("dev-server")).listen(5173, "127.0.0.1")'
    ])
    await expect(inContainer(environment, 'sh', '-c',
      'for i in $(seq 1 40); do docker compose -p livestack exec -T web wget -qO- http://host.docker.internal:5173 && exit 0; sleep 0.25; done; exit 1'))
      .resolves.toBe('dev-server')
    // An attached run's output arrives, through the proxy, as the remote user.
    await expect(inContainer(environment, 'docker', 'run', '--rm', 'busybox:1.37', 'echo', 'attached-ok'))
      .resolves.toBe('attached-ok')

    // The host's login state is in there, at the container user's home.
    const home = `/home/${environment.remoteUser}`
    expect(all).toContainEqual(expect.objectContaining({
      Type: 'bind',
      // By suffix: Docker Desktop reports a bind source as the VM sees it,
      // `/host_mnt/private/var/folders/…` for a `/var/folders/…` temp dir.
      Source: expect.stringMatching(new RegExp(`${join(process.env.NUXT_HOME_OVERLAY_DIR!, '.ssh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
      Destination: `${home}/.ssh-host`
    }))
    // `.kube` was asked for and this host has none: skipped, not a failure.
    expect(all.map(mount => mount.Destination)).not.toContain(`${home}/.kube`)
    // Docker created `~/.config` as root for the `gh` mount; gcloud has to be
    // able to write beside it.
    await expect(inContainer(environment, 'stat', '-c', '%U', `${home}/.config`))
      .resolves.toBe(environment.remoteUser)

    // The host gitconfig is included, never mounted in place: VS Code's attach
    // writes its own credential helper into the container's own file.
    expect(all.map(mount => mount.Destination)).toContain(`${home}/.gitconfig-host`)
    expect(all.map(mount => mount.Destination)).not.toContain(`${home}/.gitconfig`)
    const gitconfig = await readEnvironmentFile(environment, `${home}/.gitconfig`)
    expect(gitconfig).toContain('path = ~/.gitconfig-host')
    expect(gitconfig).toContain(`directory = ${environment.workspacePath}`)
    // The identity arrives through the include, and the host's own helper is
    // reset rather than inherited — `osxkeychain` does not exist in here.
    await expect(inContainer(environment, 'git', 'config', 'user.name')).resolves.toBe('Domo Live Test')
    // `--get-all` still lists the included `osxkeychain`: git applies the
    // empty-value reset when it *uses* the list, so what matters is that the
    // last two entries are the reset and gh's helper, in that order.
    const helpers = (await inContainer(environment, 'git', 'config', '--get-all', 'credential.helper')).split('\n')
    expect(helpers.at(-3)).toBe('osxkeychain')
    expect(helpers.slice(-2)).toEqual(['', '!gh auth git-credential'])
    await expect(inContainer(environment, 'git', 'config', 'commit.gpgsign')).resolves.toBe('false')
    // safe.directory is the reason the `git status` above answered at all.

    // `~/.ssh` is Domo's own directory, not a mount: a macOS config would abort
    // every `ssh` in here before it connected.
    expect(all.map(mount => mount.Destination)).not.toContain(`${home}/.ssh`)
    await expect(inContainer(environment, 'stat', '-c', '%F %a', `${home}/.ssh`)).resolves.toBe('directory 700')
    const sshConfig = await readEnvironmentFile(environment, `${home}/.ssh/config`)
    expect(sshConfig.split('\n')[1]).toBe('IgnoreUnknown UseKeychain')
    expect(sshConfig).toContain('Include ~/.ssh-host/config')
    // The host's own entries resolve under `~/.ssh`, which is what its
    // `IdentityFile ~/.ssh/id_ed25519` and ssh's own defaults name.
    await expect(inContainer(environment, 'readlink', `${home}/.ssh/id_ed25519`))
      .resolves.toBe(`${home}/.ssh-host/id_ed25519`)
    await expect(readEnvironmentFile(environment, `${home}/.ssh/id_ed25519`)).resolves.toBe('not a real key\n')
    await expect(inContainer(environment, 'test', '-e', `${home}/.ssh/known_hosts`)).resolves.toBe('')
    // The measurement that matters: ssh parses the whole config and exits 0
    // instead of dying on `UseKeychain`. `-G` stops before connecting, and
    // `run` rejects on a non-zero exit, which is what used to happen here.
    const parsed = await run('docker', [
      'exec', '--user', environment.remoteUser!, environment.containerId!,
      'ssh', '-G', 'github.com'
    ])
    // The line only exists in the *host's* config, so the Include was read too.
    expect(parsed.stdout).toMatch(/^identityfile .*\.ssh\/id_ed25519$/m)

    // The agent socket is forwarded, named in the container's environment so
    // every `docker exec` inherits it, and reachable by the remote user.
    await expect(inContainer(environment, 'printenv', 'SSH_AUTH_SOCK'))
      .resolves.toBe('/run/host-services/ssh-auth.sock')
    await expect(inContainer(environment, 'test', '-S', '/run/host-services/ssh-auth.sock')).resolves.toBe('')
    await expect(inContainer(environment, 'stat', '-c', '%a', '/run/host-services/ssh-auth.sock'))
      .resolves.toBe('666')

    // The project's own checkout was only read.
    await expect(run('git', ['-C', repo, 'status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })

    const kept = all.filter(mount => mount.Type === 'volume' && mount.Name).map(mount => mount.Name!)
    await retireEnvironment(environment.id)

    expect(await inspectContainer(environment.containerId!)).toBeNull()
    // What it made on the shared daemon went with it.
    for (const kind of ['container', 'network'] as const) {
      const left = await run('docker', [kind === 'container' ? 'ps' : 'network', ...(kind === 'container' ? ['-aq'] : ['ls', '-q']),
        '--filter', `label=domo.env=${environment.id}`])
      expect(left.stdout, `a ${kind} outlived its environment`).toBe('')
    }
    for (const name of kept) {
      if (name.startsWith(`${PREFIX}runtime-`)) continue // shared, and deliberately kept
      const left = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${name}$`])
      expect(left.stdout, `volume ${name} outlived its environment`).toBe('')
    }
    const image = await run('docker', ['images', '--quiet', environmentImageName(environment.id)])
    expect(image.stdout, 'the environment image outlived its environment').toBe('')
  }, HOUR / 4)
})

describe('an environment for a bare glibc image with no Node of its own', () => {
  it('runs unprivileged, and Domo\'s runtime works in it anyway', async () => {
    const repo = await checkout({
      'Dockerfile.dev': BARE_IMAGE_DOCKERFILE,
      '.domo.json': JSON.stringify({
        devEnvironment: {
          build: { dockerfile: 'Dockerfile.dev', context: '.' },
          docker: false,
          remoteUser: 'dev',
          containerEnv: { FROM_PROJECT: 'yes' },
          forwardPorts: [3000],
          portsAttributes: { 3000: { label: 'Web app', protocol: 'http' } },
          postCreateCommand: 'echo ran > /tmp/post-create'
        }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create()

    expect(environment).toMatchObject({
      status: 'running',
      remoteUser: 'dev',
      configSource: 'domo',
      configPath: '.domo.json'
    })
    // `docker: false` means exactly that: no nested daemon, no privileges.
    expect(await isPrivileged(environment.containerId!)).toBe(false)
    expect((await mounts(environment.containerId!)).map(mount => mount.Name).join('\n'))
      .not.toContain('dind-var-lib-docker')
    await expect(inContainer(environment, 'sh', '-c', 'command -v node || echo none')).resolves.toBe('none')

    // The workspace belongs to the remote user, and postCreateCommand ran as them.
    await expect(inContainer(environment, 'stat', '-c', '%U', '.')).resolves.toBe('dev')
    await expect(inContainer(environment, 'stat', '-c', '%U', '/tmp/post-create')).resolves.toBe('dev')
    await expect(inContainer(environment, 'printenv', 'FROM_PROJECT')).resolves.toBe('yes')
    await expect(inContainer(environment, 'printenv', 'DOMO_DEV_ENVIRONMENT_ID')).resolves.toBe(environment.id)

    // The declared port is published, and its attributes rode along on the container.
    const inspection = await inspectContainer(environment.containerId!)
    expect(inspection!.publishedPorts).toContainEqual(
      expect.objectContaining({ innerPort: 3000, protocol: 'tcp', hostPort: expect.any(Number) })
    )
    expect(JSON.parse(inspection!.labels['domo.portsAttributes']!))
      .toEqual({ 3000: { label: 'Web app', protocol: 'http' } })
    expect(state.ports).toContainEqual(expect.objectContaining({
      environmentId: environment.id, innerPort: 3000, source: 'declared'
    }))

    // The point of the whole runtime volume: an ACP adapter starts and answers, in an
    // image that has no Node. `initialize` needs no account.
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }
    })
    const answer = await run('docker', [
      'exec', '--interactive', '--user', 'dev', '--workdir', environment.workspacePath,
      environment.containerId!, '/opt/domo/bin/claude-agent-acp'
    ], { input: `${initialize}\n` })
    expect(JSON.parse(answer.stdout.split('\n')[0]!)).toMatchObject({
      id: 1,
      result: { agentInfo: { name: '@agentclientprotocol/claude-agent-acp' } }
    })

    await retireEnvironment(environment.id)
    expect(await inspectContainer(environment.containerId!)).toBeNull()
  }, HOUR / 4)
})

describe('an environment with the headless browser', () => {
  // Every other test in this file runs without one, and a stray `true` here
  // would make each of them build and mount several hundred megabytes.
  afterEach(() => { state.browserTools = false })

  it('mounts it, and the preflight proves the image can actually run it', async () => {
    const repo = await checkout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.browserTools = true

    const environment = await create('Live Test Browser')

    expect(environment.status).toBe('running')
    // Read-only, beside the runtime volume and not inside it.
    const mounts = await run('docker', [
      'inspect', '--format', '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}', environment.containerId!
    ])
    expect(mounts.stdout).toContain(`${BROWSER_ROOT}:false`)

    // The same probe the preflight just ran, from the outside: if this works,
    // an agent's browser will start.
    const version = await run('docker', [
      'exec', '--user', environment.remoteUser!,
      '--env', `LD_LIBRARY_PATH=${BROWSER_ROOT}/lib`,
      environment.containerId!, `${BROWSER_ROOT}/bin/chrome-headless-shell`, '--version'
    ])
    expect(version.stdout).toMatch(/Chrome/)
  }, HOUR / 2)

  it('refuses an image whose glibc is too old, rather than leaving it to fail later', async () => {
    // Ubuntu 22.04 is glibc 2.35, and the browser's libraries come from the
    // builder image (Debian 12, 2.36). The bundled Node runs here quite
    // happily, so without this check creation would succeed and the failure
    // would land on the first agent to open a page. With git, so the preflight
    // gets past the check before it.
    const repo = await checkout({
      'Dockerfile.old': 'FROM ubuntu:22.04\nRUN apt-get update '
        + '&& apt-get install -y --no-install-recommends git ca-certificates '
        + '&& rm -rf /var/lib/apt/lists/*\n',
      '.domo.json': JSON.stringify({
        devEnvironment: { build: { dockerfile: 'Dockerfile.old' }, docker: false }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.browserTools = true

    let id = ''
    await expect(
      createEnvironment({ projectId: 'prj_live', name: 'Live Test Old glibc' })
        .catch((error) => {
          id = [...state.rows.keys()].at(-1)!
          throw error
        })
    ).rejects.toThrow(/headless browser/)

    created.push(id)
    expect(state.rows.get(id)).toMatchObject({ status: 'error' })
    const containers = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`])
    expect(containers.stdout, 'a container outlived a failed creation').toBe('')
  }, HOUR / 2)
})

describe('an environment whose image cannot run Domo\'s runtime', () => {
  it('fails creation with a readable message and leaves nothing behind', async () => {
    // With git, so the preflight gets as far as the bundled Node and reports the real
    // problem: the binary is glibc-linked and musl has no loader for it.
    const repo = await checkout({
      'Dockerfile.alpine': 'FROM alpine:3\nRUN apk add --no-cache git\n',
      '.domo.json': JSON.stringify({
        devEnvironment: { build: { dockerfile: 'Dockerfile.alpine' }, docker: false }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }

    let id = ''
    await expect(
      createEnvironment({ projectId: 'prj_live', name: 'Live Test Alpine' })
        .catch((error) => {
          // The newest row, not the first: rows of earlier tests are still in
          // the map whenever one of them failed before its teardown ran.
          id = [...state.rows.keys()].at(-1)!
          throw error
        })
    ).rejects.toThrow(/glibc-based/)

    created.push(id)
    expect(state.rows.get(id)).toMatchObject({ status: 'error' })
    const containers = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`])
    expect(containers.stdout, 'a container outlived a failed creation').toBe('')
    const volume = await run('docker', [
      'volume', 'ls', '--quiet', '--filter', `name=^${workspaceVolumeName(id)}$`
    ])
    expect(volume.stdout, 'the workspace volume outlived a failed creation').toBe('')
    const image = await run('docker', ['images', '--quiet', environmentImageName(id)])
    expect(image.stdout, 'the image outlived a failed creation').toBe('')
  }, HOUR / 4)
})

describe('two environments of the same project', () => {
  it('share one runtime volume, built once', async () => {
    const repo = await checkout({
      '.domo.json': JSON.stringify({
        devEnvironment: {
          image: DEFAULT_IMAGE,
          docker: false,
          remoteUser: 'vscode',
          features: { 'ghcr.io/devcontainers/features/node:1': { version: '20' } }
        }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }

    const first = await create('Live Test One')
    const second = await create('Live Test Two')
    const shared = await ensureRuntimeVolume()

    expect(shared).toBe(runtimeVolumeName((await run('docker', ['version', '--format', '{{.Server.Arch}}'])).stdout))
    for (const environment of [first, second]) {
      expect((await mounts(environment.containerId!))).toContainEqual(expect.objectContaining({
        Type: 'volume', Name: shared, Destination: '/opt/domo', RW: false
      }))
      // The Feature the project asked for was baked into the image.
      await expect(inContainer(environment, 'node', '--version')).resolves.toMatch(/^v20\./)
    }
    const built = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${PREFIX}runtime-`])
    expect(built.stdout.split('\n').filter(Boolean)).toEqual([shared])
  }, HOUR / 2)
})

describe('exporting a branch out of an environment', () => {
  it('fetches it straight from the container into the project\'s own checkout', async () => {
    const repo = await checkout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create('Export Live')
    /** A command in the environment that must succeed — `inContainer` swallows failures. */
    const exec = (...command: string[]) => run('docker', [
      'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, ...command
    ])

    // Work done in the environment, on its own branch and with its own identity
    // (which arrives through the included host gitconfig).
    await exec('git', 'checkout', '--quiet', '-b', 'from-the-environment')
    await exec('sh', '-c', 'echo shipped > shipped.txt')
    await exec('git', 'add', 'shipped.txt')
    await exec('git', 'commit', '--quiet', '-m', 'shipped from the environment')
    const sha = (await exec('git', 'rev-parse', 'HEAD')).stdout

    const branches = await listEnvironmentBranches(environment.id)
    expect(branches.current).toBe('from-the-environment')
    expect(branches.branches).toContainEqual({
      name: 'from-the-environment',
      sha,
      subject: 'shipped from the environment'
    })

    const result = await exportBranch({
      environmentId: environment.id,
      branch: 'from-the-environment',
      into: 'from-the-environment'
    })

    expect(result).toMatchObject({
      ref: 'refs/remotes/domo-env/export-live/from-the-environment',
      sha,
      result: 'created'
    })
    expect(result.commits.map(commit => commit.subject)).toEqual(['shipped from the environment'])

    // It really is in the host checkout: the branch, the tracking ref and the blob.
    const host = (...args: string[]) => run('git', ['-C', repo, ...args])
    await expect(host('rev-parse', 'refs/heads/from-the-environment')).resolves.toMatchObject({ stdout: sha })
    await expect(host('rev-parse', 'refs/remotes/domo-env/export-live/from-the-environment'))
      .resolves.toMatchObject({ stdout: sha })
    await expect(host('show', 'from-the-environment:shipped.txt')).resolves.toMatchObject({ stdout: 'shipped' })
    // The checked-out branch was not the target and was left exactly as it was.
    await expect(host('symbolic-ref', '--short', 'HEAD')).resolves.toMatchObject({ stdout: 'main' })
    await expect(host('status', '--porcelain')).resolves.toMatchObject({ stdout: '' })
    // `protocol.ext.allow` is passed per invocation and written nowhere: this
    // repository did not gain a transport that runs arbitrary commands.
    await expect(host('config', '--get', 'protocol.ext.allow')).rejects.toThrow()

    await retireEnvironment(environment.id)
  }, HOUR / 4)
})

/**
 * The incident this exists for: two environments were created while the host tree
 * was dirty, the agents inside committed on top, and the branches that came back
 * carried a stale copy of somebody else's UI work — which, merged, would have
 * reverted a colour palette to an earlier version of itself. The export's whole
 * value is that its diff can be trusted, so this is asserted end to end, against
 * real git on both sides of the fetch.
 */
describe('an environment created while the host checkout is dirty', () => {
  /** A checkout with committed work, ignored files the environment needs, and uncommitted work on top. */
  async function dirtyCheckout(): Promise<string> {
    const repo = await checkout({
      '.gitignore': 'node_modules\n.env\n',
      'palette.css': '--green: #118657;\n'
    })
    await writeIn(repo, {
      // Uncommitted, tracked: the palette that nearly got reverted.
      'palette.css': '--green: #02ab49;\n',
      // Uncommitted, untracked, not ignored: `git add -A` would take this too.
      'scratch.md': 'half an idea\n',
      // Ignored: what the volume exists for, and what the environment needs to run.
      'node_modules/pkg/index.js': 'module.exports = 1\n',
      '.env': 'NUXT_SECRET=hunter2\n'
    })
    return repo
  }

  it('starts from HEAD, keeps the ignored files, and exports only the agent\'s own work', async () => {
    const repo = await dirtyCheckout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create('Dirty Discard')
    const exec = (...command: string[]) => run('docker', [
      'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, ...command
    ])

    // git and the filesystem agree, which is the whole property.
    await expect(exec('git', 'status', '--porcelain')).resolves.toMatchObject({ stdout: '' })
    await expect(exec('cat', 'palette.css')).resolves.toMatchObject({ stdout: '--green: #118657;' })
    await expect(exec('git', 'rev-parse', 'HEAD')).resolves.toMatchObject({
      stdout: (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout
    })
    // The untracked-but-not-ignored file is on the side of the line `git add -A` takes.
    await expect(exec('test', '-e', 'scratch.md')).rejects.toThrow()
    // The ignored ones are not, and they are what the environment needs.
    await expect(exec('cat', '.env')).resolves.toMatchObject({ stdout: 'NUXT_SECRET=hunter2' })
    await expect(exec('cat', 'node_modules/pkg/index.js')).resolves.toMatchObject({ stdout: 'module.exports = 1' })

    // An agent does its own, unrelated work and it comes home alone.
    await exec('git', 'checkout', '--quiet', '-b', 'agent-work')
    await exec('sh', '-c', 'echo shipped > shipped.txt')
    await exec('git', 'add', '--all')
    await exec('git', 'commit', '--quiet', '-m', 'the work the agent was asked for')

    const result = await exportBranch({ environmentId: environment.id, branch: 'agent-work' })

    expect(result.commits.map(commit => commit.subject)).toEqual(['the work the agent was asked for'])
    const diff = await run('git', ['-C', repo, 'diff', '--name-only', 'HEAD', result.ref])
    expect(diff.stdout.split('\n').filter(Boolean)).toEqual(['shipped.txt'])

    await retireEnvironment(environment.id)
  }, HOUR / 4)

  it('commits what it carries, so the work arrives labelled instead of disguised', async () => {
    const repo = await dirtyCheckout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create('Dirty Carry', 'carry')
    const exec = (...command: string[]) => run('docker', [
      'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, ...command
    ])

    await expect(exec('git', 'status', '--porcelain')).resolves.toMatchObject({ stdout: '' })
    // The files are the host's, and git now says so.
    await expect(exec('cat', 'palette.css')).resolves.toMatchObject({ stdout: '--green: #02ab49;' })
    await expect(exec('git', 'log', '-1', '--format=%s')).resolves.toMatchObject({
      stdout: expect.stringContaining('carry the host\'s uncommitted changes into Dirty Carry')
    })
    const carried = await exec('git', 'show', '--name-only', '--format=', 'HEAD')
    expect(carried.stdout.split('\n').filter(Boolean).sort()).toEqual(['palette.css', 'scratch.md'])
    // Ignored files stayed out of the commit and stayed on disk.
    await expect(exec('cat', '.env')).resolves.toMatchObject({ stdout: 'NUXT_SECRET=hunter2' })

    await retireEnvironment(environment.id)
  }, HOUR / 4)
})

/**
 * The push half of the `ext::` transport, against a real container. The fetch
 * half proves `git-upload-pack` is reachable inside the image; nothing but this
 * says `git-receive-pack` is — nor that the commit-then-merge sequence really
 * runs through `docker exec` against a checkout owned by another user.
 */
describe('importing a branch into an environment', () => {
  it('commits the container\'s uncommitted work, then merges the host branch in', async () => {
    const repo = await checkout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create('Import Live')
    const exec = (...command: string[]) => run('docker', [
      'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, ...command
    ])

    const host = (...args: string[]) => run('git', [
      '-C', repo, '-c', 'user.name=Domo Test', '-c', 'user.email=test@example.com', ...args
    ])
    await writeIn(repo, { 'landed.txt': 'merged on the host\n' })
    await host('add', '--all')
    await host('commit', '--quiet', '-m', 'landed on the host')
    const sha = (await host('rev-parse', 'HEAD')).stdout

    // The environment is sitting on `main`, which is the whole point: an import
    // into a branch the agent is not on would never be noticed. And it has
    // uncommitted work, which is the normal state of an agent mid-task.
    await expect(exec('git', 'symbolic-ref', '--short', 'HEAD')).resolves.toMatchObject({ stdout: 'main' })
    await exec('sh', '-c', 'echo half-finished > agent.txt')

    const result = await importBranchIntoEnvironment({ environmentId: environment.id, branch: 'main' })

    expect(result).toMatchObject({ requested: 'main', result: 'merged' })
    expect(result.wip).toMatch(/^[0-9a-f]{40}$/)
    // The host's commit arrived, the agent's file is still there, and git is
    // not confused about any of it.
    await expect(exec('cat', 'landed.txt')).resolves.toMatchObject({ stdout: 'merged on the host' })
    await expect(exec('cat', 'agent.txt')).resolves.toMatchObject({ stdout: 'half-finished' })
    await expect(exec('git', 'status', '--porcelain')).resolves.toMatchObject({ stdout: '' })
    await expect(exec('git', 'merge-base', '--is-ancestor', sha, 'HEAD')).resolves.toMatchObject({ stdout: '' })
    // The agent's work is a real commit it can reset to, not a stash.
    await expect(exec('git', 'show', `${result.wip}:agent.txt`)).resolves.toMatchObject({ stdout: 'half-finished' })

    // `protocol.ext.allow` was passed per invocation on the push too, not written.
    await expect(host('config', '--get', 'protocol.ext.allow')).rejects.toThrow()

    await retireEnvironment(environment.id)
  }, HOUR / 4)
})

describe('populateWorkspaceVolume', () => {
  it('copies a checkout, keeping hidden files and leaving out a data dir that lives inside it', async () => {
    const repo = await checkout({
      '.hidden': 'dotfile\n',
      '.domo-data/dev-environments/env_old/repo/stale.txt': 'old\n',
      'tools/state/domo/uploads/photo.png': 'not a copy target\n'
    })
    const volume = `${PREFIX}populate-${Date.now()}`
    volumes.push(volume)
    await run('docker', ['volume', 'create', volume])

    await populateWorkspaceVolume({
      source: repo,
      volume,
      helperImage: HELPER_IMAGE,
      exclude: ['.domo-data', 'tools/state/domo']
    })

    const listing = (await run('docker', [
      'run', '--rm', '--volume', `${volume}:/w`, HELPER_IMAGE,
      'find', '/w', '-not', '-path', '/w/.git/*', '-type', 'f'
    ])).stdout.split('\n').sort()

    expect(listing).toEqual(expect.arrayContaining(['/w/README.md', '/w/src/index.ts', '/w/.hidden']))
    expect(listing.join('\n')).not.toMatch(/stale\.txt|photo\.png/)
    // macOS `tar` adds AppleDouble companions unless told not to.
    expect(listing.filter(path => path.split('/').pop()!.startsWith('._'))).toEqual([])
  }, 5 * 60 * 1000)
})

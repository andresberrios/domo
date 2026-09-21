import { access, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { dockerServerOs } from './docker'

/**
 * The host user's login state, projected into an environment's home directory.
 *
 * A dev environment is a parallelism and namespace mechanism, not a security
 * boundary: it runs on the same machine as Domo, for the same person, and an
 * agent in it is expected to `git push`, `gh pr create` and talk to whatever
 * cloud the developer is already logged into. So the credentials are shared,
 * by bind-mounting them, the same way `~/.codex` already is.
 *
 * Everything here is phrased as `{ sourceHome, containerHome, … } -> mounts`
 * rather than reading `process.env.HOME` in place, because the one thing a
 * multi-user Domo would have to change is *whose* home the overlay comes from.
 * Point `sourceHome` at that user's directory and the rest still holds.
 */

/** Where the forwarded SSH agent socket is offered inside every environment. */
export const CONTAINER_SSH_AUTH_SOCK = '/run/host-services/ssh-auth.sock'

/**
 * The entries mounted when the setting has never been touched.
 *
 * `.docker` is deliberately not here: Docker Desktop writes
 * `"credsStore": "desktop"` into `~/.docker/config.json`, and the helper binary
 * that names is on the host only — with the file mounted, every `docker pull`
 * inside the environment fails with `docker-credential-desktop: executable file
 * not found`.
 */
export const DEFAULT_HOME_MOUNTS = [
  '.ssh',
  '.gitconfig',
  '.config/gh',
  '.config/gcloud',
  '.aws',
  '.kube'
]

/**
 * Entries that are never mounted, however the setting is written.
 *
 * `.claude` is the important one: it holds `.credentials.json`, Anthropic
 * rotates the OAuth refresh token on every refresh, and the loser of a shared
 * chain would be the developer's own machine. A `claude setup-token` token
 * (`NUXT_CLAUDE_CODE_OAUTH_TOKEN`) is the supported way in, and the harmless
 * parts of the directory are copied — see `claude-home.ts`.
 */
const REFUSED: Record<string, string> = {
  '.claude': 'holds `.credentials.json`, and a second Claude Code refreshing that chain logs this machine out. '
    + 'Use `claude setup-token` and `NUXT_CLAUDE_CODE_OAUTH_TOKEN` instead; the safe parts are copied in already.',
  '.claude.json': 'is Claude Code\'s own state file, and Domo seeds one in the environment already.',
  '.codex': 'is already mounted into every environment by its own mechanism.'
}

export type SshAgentSource =
  /** Docker Desktop forwards the host agent itself, at a path only the VM has. */
  | { kind: 'docker-desktop' }
  /** A socket on this machine, usually the Domo process's own `SSH_AUTH_SOCK`. */
  | { kind: 'socket', path: string }

export interface HomeBindMount {
  type: 'bind'
  source: string
  target: string
  readonly?: boolean
}

export interface HomeOverlayInput {
  /** The host directory the entries are read from. Today the Domo process's `$HOME`. */
  sourceHome: string
  containerHome: string
  /** The checkout inside the environment, which the generated git config marks safe. */
  workspacePath: string
  /** The configured entries, relative to the home directory. */
  paths: string[]
  /** Which of `paths` this host actually has. Anything else is skipped silently. */
  present: string[]
  /** What the host's `.ssh` holds, listed by the caller so this stays pure. */
  sshEntries?: string[]
  sshAgent: SshAgentSource | null
}

/** The `~/.ssh` Domo builds in the container, wrapping the host's. */
export interface SshHome {
  /** `~/.ssh/config`, written as the remote user. */
  config: string
  /** Entries of the host directory to symlink into `~/.ssh`, `config` excluded. */
  links: string[]
}

export interface HomeOverlay {
  mounts: HomeBindMount[]
  /** Extra `docker run --env` entries, so `docker exec` sessions inherit them. */
  env: Record<string, string>
  /**
   * Directories Docker will create as root when it makes a mount target, and
   * that the remote user therefore has to be given back. Shallowest first.
   */
  parentDirectories: string[]
  /** The container's own global git config, written at creation. Never mounted. */
  gitconfig: string
  /** The container's own `~/.ssh`, or null when the host's is not being shared. */
  ssh: SshHome | null
}

/** One spelling per entry: no trailing slash, no backslashes, no doubled separators. */
export function normalizeHomeMount(entry: string): string {
  return entry.trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

/** Why this entry cannot be mounted, or null when it can. */
export function validateHomeMount(entry: string): string | null {
  const value = normalizeHomeMount(entry)
  if (!value) return 'An empty line is not a path — remove it.'
  if (value.startsWith('~')) {
    return `"${value}" is already relative to your home directory: drop the leading "~/".`
  }
  if (isAbsolute(value) || /^[a-zA-Z]:\//.test(value)) {
    return `"${value}" is an absolute path, and entries are relative to your home directory.`
  }
  const segments = value.split('/')
  if (segments.includes('..')) {
    return `"${value}" may not contain "..": entries have to stay inside your home directory.`
  }
  const refused = REFUSED[segments[0]!]
  if (refused) return `"${segments[0]}" ${refused}`
  return null
}

/** Every problem with a whole list, so the Settings page can report them at once. */
export function validateHomeMounts(entries: string[]): string[] {
  return entries.map(validateHomeMount).filter((problem): problem is string => problem !== null)
}

/**
 * The container's own `~/.gitconfig`, which *includes* the host's rather than
 * being it.
 *
 * Three reasons it is not simply mounted in place. The host file names
 * credential helpers the container does not have (`osxkeychain`, VS Code's own
 * helper script), so the multi-value helper list is reset with an empty
 * `helper =` and replaced with gh's, which works as soon as `GH_TOKEN` is in
 * the environment. VS Code's "attach to running container" writes *its* helper
 * and identity into the container's global config, and if that file were the
 * host's, the host would inherit a helper pointing at a container path. And the
 * signing keys are on the host, not in here, so signing is off.
 *
 * Identity (`user.name` / `user.email`) arrives through the include; nothing is
 * copied, so a change on the host is picked up by an existing environment.
 */
export function containerGitconfig(input: {
  containerHome: string
  workspacePath: string
  includeHostConfig: boolean
}): string {
  const lines: string[] = []
  if (input.includeHostConfig) {
    lines.push('[include]', '    path = ~/.gitconfig-host')
  }
  lines.push(
    '[safe]',
    `    directory = ${input.workspacePath}`,
    '[credential]',
    // An empty value resets the list a multi-value key accumulated.
    '    helper =',
    '    helper = !gh auth git-credential',
    '[commit]',
    '    gpgsign = false',
    '[tag]',
    '    gpgsign = false'
  )
  return `${lines.join('\n')}\n`
}

/**
 * The container's own `~/.ssh/config`, which *includes* the host's rather than
 * being it — for a harder reason than the git one.
 *
 * A macOS `~/.ssh/config` almost always says `UseKeychain yes`, and that
 * keyword only exists in Apple's OpenSSH. Linux OpenSSH treats an unknown
 * option as **fatal**: every `ssh` in the container dies with
 * `Bad configuration option: usekeychain` before it connects, and `git push`
 * reports it as "Please make sure you have the correct access rights".
 * `IgnoreUnknown` fixes it, but only when it is read *before* the unknown
 * option — and `/etc/ssh/ssh_config` is read after the user's file, so no
 * system-wide setting can do it. The user file itself has to open with it.
 *
 * Measured on ubuntu-24.04 / OpenSSH 9.6 against a real macOS home:
 * `ssh -o IgnoreUnknown=UseKeychain -T git@github.com` authenticates through
 * the forwarded agent where the bare `ssh` aborts.
 */
export function containerSshConfig(input: { includeHostConfig: boolean }): string {
  const lines = [
    '# Written by Domo. The host\'s ~/.ssh is mounted at ~/.ssh-host; this wraps its config.',
    // Before the Include, which is the whole point: ssh applies the first
    // value it reads for a keyword, and dies on an unknown one before that.
    'IgnoreUnknown UseKeychain'
  ]
  if (input.includeHostConfig) lines.push('Include ~/.ssh-host/config')
  return `${lines.join('\n')}\n`
}

/** Ancestors of a target below the container home, shallowest first. */
function ancestorsOf(target: string, containerHome: string): string[] {
  const prefix = `${containerHome}/`
  if (!target.startsWith(prefix)) return []
  const segments = target.slice(prefix.length).split('/')
  return segments.slice(0, -1).map((_segment, index) => `${prefix}${segments.slice(0, index + 1).join('/')}`)
}

/**
 * The mounts, env and generated git config for one environment. Pure: what
 * exists on the host and what kind of SSH agent there is are both inputs.
 */
export function homeOverlay(input: HomeOverlayInput): HomeOverlay {
  const mounts: HomeBindMount[] = []
  const seen = new Set<string>()
  let includeHostConfig = false
  let ssh: SshHome | null = null

  for (const raw of input.paths) {
    const entry = normalizeHomeMount(raw)
    if (validateHomeMount(entry)) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    if (!input.present.includes(entry)) continue
    if (entry === '.ssh') {
      // Beside the real one, like `.gitconfig`, but read-write: ssh appends to
      // `known_hosts` through it, and that belongs back on the host.
      const entries = input.sshEntries ?? []
      ssh = {
        config: containerSshConfig({ includeHostConfig: entries.includes('config') }),
        // Everything but `config`: the keys, `known_hosts`, certificates. An
        // `IdentityFile ~/.ssh/id_ed25519` in the host's config, and ssh's own
        // defaults, both name `~/.ssh` — so the names have to resolve there.
        links: entries.filter(name => name !== 'config')
      }
      mounts.push({
        type: 'bind',
        source: join(input.sourceHome, entry),
        target: `${input.containerHome}/.ssh-host`
      })
      continue
    }
    if (entry === '.gitconfig') {
      // Read-only, and beside the real one: Domo writes `~/.gitconfig` itself.
      includeHostConfig = true
      mounts.push({
        type: 'bind',
        source: join(input.sourceHome, entry),
        target: `${input.containerHome}/.gitconfig-host`,
        readonly: true
      })
      continue
    }
    // Read-write on purpose: gh and gcloud refresh their tokens in place, and a
    // read-only mount turns that into an error the CLI reports as a bad login.
    mounts.push({
      type: 'bind',
      source: join(input.sourceHome, entry),
      target: `${input.containerHome}/${entry}`
    })
  }

  const env: Record<string, string> = {}
  if (input.sshAgent) {
    mounts.push({
      type: 'bind',
      source: input.sshAgent.kind === 'docker-desktop' ? CONTAINER_SSH_AUTH_SOCK : input.sshAgent.path,
      target: CONTAINER_SSH_AUTH_SOCK
    })
    // On the container, not just on the adapter: every `docker exec` inherits it.
    env.SSH_AUTH_SOCK = CONTAINER_SSH_AUTH_SOCK
  }

  const parentDirectories: string[] = []
  for (const mount of mounts) {
    for (const ancestor of ancestorsOf(mount.target, input.containerHome)) {
      if (!parentDirectories.includes(ancestor)) parentDirectories.push(ancestor)
    }
  }
  parentDirectories.sort((a, b) => a.split('/').length - b.split('/').length)

  return {
    mounts,
    env,
    parentDirectories,
    gitconfig: containerGitconfig({
      containerHome: input.containerHome,
      workspacePath: input.workspacePath,
      includeHostConfig
    }),
    ssh
  }
}

/** An overlay that mounts nothing — what an environment gets when there is no home to read. */
export function emptyHomeOverlay(input: { containerHome: string, workspacePath: string }): HomeOverlay {
  return homeOverlay({ ...input, sourceHome: '', paths: [], present: [], sshEntries: [], sshAgent: null })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/**
 * Which SSH agent, if any, an environment can be given.
 *
 * Docker Desktop runs the daemon in a VM, so the host's own `SSH_AUTH_SOCK`
 * path is not a path the daemon can bind-mount. It forwards the agent itself to
 * a fixed path instead, and that is what gets mounted. Everywhere else the
 * daemon shares this filesystem and the process's own socket is mountable.
 */
export async function detectSshAgent(env: NodeJS.ProcessEnv = process.env): Promise<SshAgentSource | null> {
  const operatingSystem = await dockerServerOs().catch(() => 'unknown')
  if (/^docker desktop/i.test(operatingSystem)) return { kind: 'docker-desktop' }
  const socket = env.SSH_AUTH_SOCK
  if (socket && await exists(socket)) return { kind: 'socket', path: socket }
  return null
}

/** The host directory the overlay is read from. `NUXT_HOME_OVERLAY_DIR` overrides it. */
export function overlaySourceHome(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.NUXT_HOME_OVERLAY_DIR || env.HOME || null
}

/** `homeOverlay()` with the two things it cannot know asked of the host. */
export async function resolveHomeOverlay(input: {
  containerHome: string
  workspacePath: string
  paths: string[]
}): Promise<HomeOverlay> {
  const sshAgent = await detectSshAgent()
  const sourceHome = overlaySourceHome()
  if (!sourceHome) {
    return homeOverlay({ ...input, sourceHome: '', paths: [], present: [], sshEntries: [], sshAgent })
  }
  const paths = input.paths.map(normalizeHomeMount)
  const present: string[] = []
  for (const entry of paths) {
    if (validateHomeMount(entry)) continue
    if (await exists(join(sourceHome, entry))) present.push(entry)
  }
  // The one listing the overlay cannot do for itself: what to symlink into the
  // container's own `~/.ssh`.
  const sshEntries = present.includes('.ssh')
    ? await readdir(join(sourceHome, '.ssh')).catch(() => [] as string[])
    : []
  return homeOverlay({ ...input, sourceHome, paths, present, sshEntries, sshAgent })
}

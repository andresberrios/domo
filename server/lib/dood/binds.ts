import { posix } from 'node:path'

/**
 * Where a bind source an environment names really is, on the shared daemon.
 *
 * A container an agent starts is created by the *host* daemon, which resolves
 * a bind source against the host's filesystem, not the environment's. Inside
 * the environment the same path means something else: the checkout is a named
 * volume, `~/.aws` is a bind from the developer's home, `/var/run/docker.sock`
 * is this environment's own proxy, and everything else is the environment's
 * own image layer, which no other container can see. So every bind source is
 * looked up in the environment container's own mount table, longest
 * destination first — exactly what the kernel does when the agent opens the
 * path — and turned into what backs it:
 *
 * - a **volume** mount → that volume, with the rest of the path as a
 *   `volume-subpath` (the checkout is the common case of this);
 * - a **bind** mount → its source on the host plus the rest of the path;
 * - the **Docker socket** → this environment's proxy socket, so what a
 *   service does with it is namespaced and labelled like the agent's own work;
 * - a short list of **system paths** that mean the same thing on the daemon's
 *   host as on any machine (`/etc/localtime`, `/dev`, `/proc`, …) → passed
 *   through, since a compose file mounting them wants *a* host's, and the
 *   daemon's is the only one there is;
 * - **anything else** exists only inside the environment → refused with a
 *   sentence naming the path, rather than letting the daemon create an empty
 *   directory on its own host and start a service that silently sees nothing.
 *
 * A mount is never *less* read-only than the environment's own: a service
 * cannot write through a path the agent itself could only read (the shared
 * runtime volume at `/opt/domo`, the host's git config).
 *
 * Pure: the mount table is an input, read from `docker inspect` by the caller.
 */

export interface EnvironmentMount {
  /** Where it appears inside the environment. */
  destination: string
  kind: 'volume' | 'bind' | 'other'
  /** A volume's name. */
  volume?: string
  /** A volume mount's own subpath, when the environment mounts only part of it. */
  subpath?: string
  /** A bind's source on the daemon's host, as `docker inspect` reports it. */
  source?: string
  /** `tmpfs`, `npipe`, … for an `other`. */
  type?: string
  readOnly: boolean
}

export type BindResolution =
  | { kind: 'volume', volume: string, subpath: string, readOnly: boolean }
  | { kind: 'bind', source: string, readOnly: boolean }
  | { kind: 'socket', source: string }
  | { kind: 'system', source: string }
  | { kind: 'refuse', message: string }

/** What the environment calls its Docker socket. `/var/run` is a symlink to `/run` in every image worth running. */
export const DOCKER_SOCKET_PATHS = ['/var/run/docker.sock', '/run/docker.sock']

/**
 * Paths that pass through to the daemon's host unchanged: each means the same
 * kind of thing there as in the environment, and the environment's own copy
 * could not be mounted anyway (it is its image layer, or a kernel view).
 *
 * - `/etc/localtime`, `/etc/timezone`, `/usr/share/zoneinfo`: the clock's zone,
 *   the most common system bind in compose files. Measured on Docker Desktop:
 *   all three exist in its VM.
 * - `/dev`, `/sys`, `/proc`, `/lib/modules`: devices and kernel views. The
 *   environment shares the kernel with the daemon, so these are the same
 *   kernel's; `/proc` is the daemon host's PID namespace, as `--pid host` is.
 * - `/run`, `/var/run`: sockets and runtime state of the daemon's host
 *   (`/run/containerd`, `/run/udev`) — except the Docker socket, which is the
 *   environment's own, above. `/run` is not the same directory as `/var/run`
 *   in Docker Desktop's VM (measured: 23 and 38 entries), so both are listed.
 * - `/var/lib/docker`: the daemon's own data, what cAdvisor and log shippers
 *   mount. It is the shared daemon's, and there is no other one to give.
 *
 * Nothing broader: `/`, `/etc`, `/var/log` and `/tmp` have environment copies
 * that differ from the host's in ways that matter, and a service handed the
 * wrong one would run on data nobody meant. Those are refused.
 */
export const SYSTEM_PATHS = [
  '/etc/localtime',
  '/etc/timezone',
  '/usr/share/zoneinfo',
  '/dev',
  '/sys',
  '/proc',
  '/lib/modules',
  '/run',
  '/var/run',
  '/var/lib/docker'
]

const under = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

/** The part of `path` below `root`, `''` for `root` itself. */
const relative = (path: string, root: string) => path === root ? '' : path.slice(root.length + 1)

/**
 * A source as the kernel would see it: absolute, `.` and `..` resolved, no
 * trailing slash. The CLI and compose both send absolute paths already
 * (resolved against the client's working directory in the environment), but
 * `../shared` survives in one as `/workspaces/app/../shared`.
 */
export function normalizeSource(source: string): string {
  const normalized = posix.normalize(source)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** `docker inspect`'s `Mounts` (and `HostConfig.Mounts` for subpaths) as a mount table. */
export function mountTableFromInspect(inspected: unknown): EnvironmentMount[] {
  const body = (inspected && typeof inspected === 'object' ? inspected : {}) as Record<string, any>
  const configured: any[] = Array.isArray(body.HostConfig?.Mounts) ? body.HostConfig.Mounts : []
  const table: EnvironmentMount[] = []
  for (const mount of Array.isArray(body.Mounts) ? body.Mounts : []) {
    const destination = typeof mount?.Destination === 'string' ? normalizeSource(mount.Destination) : ''
    if (!destination.startsWith('/')) continue
    const readOnly = mount.RW === false
    if (mount.Type === 'volume' && typeof mount.Name === 'string') {
      const spec = configured.find(entry => entry?.Target && normalizeSource(entry.Target) === destination)
      const subpath = typeof spec?.VolumeOptions?.Subpath === 'string' ? spec.VolumeOptions.Subpath : ''
      table.push({ destination, kind: 'volume', volume: mount.Name, ...(subpath && { subpath }), readOnly })
    } else if (mount.Type === 'bind' && typeof mount.Source === 'string') {
      table.push({ destination, kind: 'bind', source: mount.Source, readOnly })
    } else {
      table.push({ destination, kind: 'other', type: String(mount.Type ?? 'unknown'), readOnly })
    }
  }
  return table
}

/**
 * Docker Desktop reports a bind's source as the path the client gave, but its
 * VM knows the Mac's files under `/host_mnt` as well; either form is accepted
 * (measured, `-v` and `--mount` alike). The plain one is kept, since it is
 * what the developer recognises in an error.
 */
const hostSource = (source: string) => source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source

const joinPath = (base: string, rest: string) => rest ? posix.join(base, rest) : base

/** The longest mount destination the path is at or below. */
export function containingMount(path: string, table: EnvironmentMount[]): EnvironmentMount | null {
  let best: EnvironmentMount | null = null
  for (const mount of table) {
    if (!under(path, mount.destination)) continue
    if (!best || mount.destination.length > best.destination.length) best = mount
  }
  return best
}

export interface ResolveOptions {
  /** This environment's proxy socket on the daemon's host. */
  dockerSocket?: string
}

function refusal(path: string, table: EnvironmentMount[], workspace: string | null, reason?: string): string {
  const sibling = containingMount(`${path}-host`, table)
  const hint = sibling && sibling.destination === `${path}-host`
    ? ` The host's own copy is mounted at ${path}-host — mount that instead.`
    : ''
  const where = workspace ? `the checkout (${workspace}), a named volume,` : 'a named volume'
  return `${path} ${reason ?? 'exists only inside this dev environment'}, so a container on the shared Docker daemon `
    + `cannot mount it. Put what it needs in ${where} or one of the home directories Domo mounts from the host.${hint}`
}

/** Where one bind source really is. `path` is normalised here; `workspace` only improves the refusal's wording. */
export function resolveBindSource(
  rawPath: string,
  table: EnvironmentMount[],
  options: ResolveOptions = {},
  workspace: string | null = null
): BindResolution {
  const path = normalizeSource(rawPath)
  if (DOCKER_SOCKET_PATHS.includes(path)) {
    if (!options.dockerSocket) return { kind: 'refuse', message: `${path} is not available in this dev environment.` }
    return { kind: 'socket', source: options.dockerSocket }
  }
  const mount = containingMount(path, table)
  if (mount && mount.destination !== '/') {
    const rest = relative(path, mount.destination)
    if (mount.kind === 'volume' && mount.volume) {
      return {
        kind: 'volume',
        volume: mount.volume,
        subpath: joinPath(mount.subpath ?? '', rest).replace(/^\/+/, ''),
        readOnly: mount.readOnly
      }
    }
    if (mount.kind === 'bind' && mount.source) {
      return { kind: 'bind', source: joinPath(hostSource(mount.source), rest), readOnly: mount.readOnly }
    }
    return {
      kind: 'refuse',
      message: refusal(path, table, workspace, `is a ${mount.type ?? 'private'} mount of this dev environment`)
    }
  }
  if (SYSTEM_PATHS.some(root => under(path, root))) return { kind: 'system', source: path }
  return { kind: 'refuse', message: refusal(path, table, workspace) }
}

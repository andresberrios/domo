/**
 * Types for the devcontainer integration. We parse the subset of the
 * spec Domo cares about — image/build/compose source, forwardPorts +
 * portsAttributes (the named-port metadata that replaces `Domofile`),
 * features, runArgs, lifecycle commands, remoteUser. The full spec
 * is much larger; we keep `extra` for round-trip preservation when
 * we scaffold or rewrite the file.
 */

/** A `forwardPorts` entry — number, "host:container" string, or just
 * "container" string. */
export type ForwardPortEntry = number | string

export interface PortAttributes {
  label?: string
  protocol?: 'http' | 'https' | 'tcp' | 'udp' | string
  onAutoForward?: 'notify' | 'openBrowser' | 'openBrowserOnce' | 'openPreview' | 'silent' | 'ignore' | string
  requireLocalPort?: boolean
  elevateIfNeeded?: boolean
}

/**
 * Subset of devcontainer.json we read. Unknown keys are preserved
 * verbatim in `extra` so the file round-trips cleanly when we rewrite
 * it (e.g. adding the Domo claude Feature on scaffold).
 */
export interface DevcontainerConfig {
  name?: string

  // Container source — exactly one of image / build / dockerComposeFile
  // is set in a valid file (the spec).
  image?: string
  build?: {
    dockerfile: string
    context?: string
    args?: Record<string, string>
    target?: string
  }
  dockerComposeFile?: string | string[]
  service?: string // when dockerComposeFile is set
  runServices?: string[] // when dockerComposeFile is set

  workspaceFolder?: string
  workspaceMount?: string

  forwardPorts?: ForwardPortEntry[]
  portsAttributes?: Record<string, PortAttributes>
  otherPortsAttributes?: PortAttributes

  features?: Record<string, Record<string, unknown> | string | boolean | undefined>
  runArgs?: string[]
  containerEnv?: Record<string, string>
  remoteEnv?: Record<string, string | null>
  remoteUser?: string
  containerUser?: string
  updateRemoteUserUID?: boolean

  postCreateCommand?: string | string[] | Record<string, string | string[]>
  postStartCommand?: string | string[] | Record<string, string | string[]>
  postAttachCommand?: string | string[] | Record<string, string | string[]>
  initializeCommand?: string | string[] | Record<string, string | string[]>

  mounts?: (string | { source: string; target: string; type?: 'bind' | 'volume' })[]
  customizations?: Record<string, unknown>

  /** All other keys, preserved verbatim for round-trip writes. */
  extra?: Record<string, unknown>
}

/** Resolved port — host loopback port published for a container inner
 * port + the metadata Domo uses to label/render it. */
export interface ResolvedPort {
  /** From `portsAttributes` key when present; else `forwardPorts` index. */
  name: string
  innerPort: number
  /** Random host port assigned by Docker at `up`; null until known. */
  hostPort: number | null
  protocol: 'tcp' | 'udp'
  label: string | null
  /** Inferred app-layer protocol from `portsAttributes.protocol`. */
  appProtocol: 'http' | 'https' | 'tcp' | 'udp' | null
}

/** Runtime selection result — which inner-Docker runtime the host
 * supports and any extra `runArgs` Domo should inject at `up`. */
export interface HostRuntime {
  /**
   * - `sysbox` — host has the sysbox-runc runtime registered; cleanest
   *   nested-Docker UX without `--privileged`.
   * - `rootless-dind` — fallback; the env container image is responsible
   *   for running rootless dockerd inside.
   * - `privileged` — last resort, security hole, only with operator opt-in.
   */
  kind: 'sysbox' | 'rootless-dind' | 'privileged'
  /** Extra `--runtime=...` style args injected into the docker create
   * command. Empty for `rootless-dind` (the image does the work). */
  extraRunArgs: string[]
  /** Warnings the operator should see (e.g. privileged-fallback). */
  warnings: string[]
}

/** Live state of an env's container — derived from `docker inspect`. */
export interface ContainerInfo {
  containerId: string
  status: 'running' | 'created' | 'exited' | 'paused' | 'restarting' | 'dead' | 'removing' | 'unknown'
  /** When the container last started (ms epoch); null if never started. */
  startedAt: number | null
  /** Port mappings discovered via `docker port` (loopback only). */
  publishedPorts: { innerPort: number; protocol: 'tcp' | 'udp'; hostPort: number }[]
  /** First IPv4 on a Docker bridge network, useful for direct
   * forwarders in step 4 if needed. May be null. */
  ipAddress: string | null
}

/** Status surfaced to the UI for an env, abstracting over Docker's
 * internal state values. */
export type EnvLiveStatus = 'running' | 'stopped' | 'starting' | 'missing' | 'error' | 'unknown'

export function toEnvLiveStatus(s: ContainerInfo['status']): EnvLiveStatus {
  switch (s) {
    case 'running':
      return 'running'
    case 'created':
    case 'restarting':
      return 'starting'
    case 'exited':
    case 'paused':
      return 'stopped'
    case 'dead':
    case 'removing':
      return 'error'
    default:
      return 'unknown'
  }
}

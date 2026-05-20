/**
 * Devcontainer engine — replaces the Coast adapter as the per-env
 * container lifecycle, terminal exec, and port discovery layer.
 * Lives behind a `@devcontainers/cli` subprocess + raw `docker`
 * inspection (no stable programmatic API for the CLI; subprocess +
 * JSON is the contract).
 *
 * The `claude` spawn site moves into `docker exec` against an env
 * container in step 3b; step 3a keeps that host-side and just swaps
 * the container layer.
 */
export type {
  DevcontainerConfig,
  ForwardPortEntry,
  PortAttributes,
  ResolvedPort,
  HostRuntime,
  ContainerInfo,
  EnvLiveStatus,
} from './types'
export { toEnvLiveStatus } from './types'

export {
  findDevcontainer,
  loadDevcontainer,
  parseDevcontainerJsonc,
  parseForwardPort,
  devcontainerPaths,
  DevcontainerNotFoundError,
  DevcontainerParseError,
} from './parser'
export type { ResolvedDevcontainer } from './parser'

export { detectHostRuntime, privilegedRuntime, resetRuntimeCache } from './runtime'

export {
  up,
  inspect,
  findByEnvId,
  start,
  stop,
  remove,
  execContainer,
  resolveForwardPorts,
  DevcontainerCliMissingError,
  DevcontainerUpError,
} from './client'
export type { UpOptions, UpResult, ExecOptions } from './client'

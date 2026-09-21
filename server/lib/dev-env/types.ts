export type ForwardPortEntry = number | string

export interface PortAttributes {
  label?: string
  protocol?: 'http' | 'https' | 'tcp' | 'udp' | string
  onAutoForward?: string
}

export interface BuildConfig {
  dockerfile: string
  context: string
  args?: Record<string, string>
  target?: string
}

/** Domo's own environment definition: the `devEnvironment` key of `.domo.json`, validated. */
export interface DevEnvironmentConfig {
  image?: string
  build?: BuildConfig
  features: Record<string, unknown>
  /** A private nested Docker daemon (the docker-in-docker Feature, and `--privileged`). */
  docker: boolean
  remoteUser?: string
  containerEnv: Record<string, string>
  forwardPorts: ForwardPortEntry[]
  portsAttributes: Record<string, PortAttributes>
  /** A string runs through `sh -c`; an array is argv. */
  postCreateCommand?: string | string[]
}

export interface ResolvedEnvironmentConfig {
  config: DevEnvironmentConfig
  source: 'domo' | 'default'
  /** Absolute path of the file it came from, or null for the built-in default. */
  path: string | null
  /** What the UI shows: the file name, or null for the built-in default. */
  displayPath: string | null
}

export interface ResolvedPortConfig {
  innerPort: number
  protocol: 'tcp' | 'udp'
  appProtocol: 'http' | 'https' | 'tcp' | 'udp' | null
  label: string | null
}

/** One entry of an image's `devcontainer.metadata` label. Only the keys Domo honours. */
export interface ImageMetadataEntry {
  entrypoint?: string
  privileged?: boolean
  init?: boolean
  capAdd?: string[]
  securityOpt?: string[]
  containerEnv?: Record<string, string>
  mounts?: Array<string | { type?: string, source?: string, target?: string }>
  remoteUser?: string
  containerUser?: string
}

export interface VolumeMount {
  source: string
  target: string
}

/** The merged, allow-listed result of an image's `devcontainer.metadata`. */
export interface ImageMetadata {
  /** Each Feature's entrypoint, in contribution order. They run on every container start. */
  entrypoints: string[]
  privileged: boolean
  init: boolean
  capAdd: string[]
  securityOpt: string[]
  containerEnv: Record<string, string>
  /** `type: volume` only — a Feature's bind mount would punch a hole in the isolation. */
  volumeMounts: VolumeMount[]
  remoteUser: string | null
  containerUser: string | null
}

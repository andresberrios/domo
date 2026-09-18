export type ForwardPortEntry = number | string

export interface PortAttributes {
  label?: string
  protocol?: 'http' | 'https' | 'tcp' | 'udp' | string
  onAutoForward?: string
}

export interface DevcontainerConfig {
  name?: string
  image?: string
  dockerFile?: string
  context?: string
  build?: string | {
    dockerfile: string
    context?: string
    args?: Record<string, string>
    target?: string
  }
  dockerComposeFile?: string | string[]
  service?: string
  runServices?: string[]
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
  privileged?: boolean
  postCreateCommand?: string | string[] | Record<string, string | string[]>
  postStartCommand?: string | string[] | Record<string, string | string[]>
  postAttachCommand?: string | string[] | Record<string, string | string[]>
  initializeCommand?: string | string[] | Record<string, string | string[]>
  mounts?: Array<string | { source: string, target: string, type?: 'bind' | 'volume' }>
  customizations?: Record<string, unknown>
  [key: string]: unknown
}

export interface ResolvedPortConfig {
  innerPort: number
  protocol: 'tcp' | 'udp'
  appProtocol: 'http' | 'https' | 'tcp' | 'udp' | null
  label: string | null
}

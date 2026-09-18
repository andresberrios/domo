import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

import type { DevEnvironmentConfigSource } from '../../../shared/types'
import type { DevcontainerConfig, ForwardPortEntry, ResolvedPortConfig } from './types'

export const DOMO_CONFIG_FILE = '.domo.json'
export const DEFAULT_IMAGE = process.env.NUXT_DEV_ENV_IMAGE
  || 'mcr.microsoft.com/devcontainers/base:ubuntu-24.04'

interface DomoRepoConfig {
  devEnvironment?: {
    image?: string
    remoteUser?: string
    forwardPorts?: ForwardPortEntry[]
    portsAttributes?: DevcontainerConfig['portsAttributes']
  }
}

export interface ResolvedDevcontainerConfig {
  config: DevcontainerConfig
  source: DevEnvironmentConfigSource
  path: string | null
  displayPath: string | null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function parseJsonc<T>(source: string, path: string): T {
  const errors: ParseError[] = []
  const value = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false
  }) as T
  if (errors.length) {
    const details = errors.map(error => `${printParseErrorCode(error.error)} at ${error.offset}`).join(', ')
    throw new Error(`Invalid JSONC in ${path}: ${details}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object.`)
  }
  return value
}

export async function resolveDevcontainerConfig(
  workspace: string,
  environmentName: string
): Promise<ResolvedDevcontainerConfig> {
  const candidates = [
    join(workspace, '.devcontainer', 'devcontainer.json'),
    join(workspace, '.devcontainer.json')
  ]
  for (const path of candidates) {
    if (!await exists(path)) continue
    return {
      config: parseJsonc<DevcontainerConfig>(await readFile(path, 'utf8'), path),
      source: 'devcontainer',
      path,
      displayPath: relative(workspace, path)
    }
  }

  const domoPath = join(workspace, DOMO_CONFIG_FILE)
  if (await exists(domoPath)) {
    const domo = parseJsonc<DomoRepoConfig>(await readFile(domoPath, 'utf8'), domoPath)
    const settings = domo.devEnvironment
    if (settings && !settings.image?.trim()) {
      throw new Error(`${DOMO_CONFIG_FILE} must define devEnvironment.image.`)
    }
    if (settings?.image) {
      return {
        config: {
          name: environmentName,
          image: settings.image.trim(),
          remoteUser: settings.remoteUser,
          forwardPorts: settings.forwardPorts ?? [],
          portsAttributes: settings.portsAttributes ?? {}
        },
        source: 'domo',
        path: domoPath,
        displayPath: DOMO_CONFIG_FILE
      }
    }
  }

  return {
    config: {
      name: environmentName,
      image: DEFAULT_IMAGE,
      remoteUser: 'vscode',
      forwardPorts: [],
      portsAttributes: {}
    },
    source: 'default',
    path: null,
    displayPath: null
  }
}

export function parseForwardPort(entry: ForwardPortEntry): { innerPort: number, protocol: 'tcp' | 'udp' } | null {
  if (typeof entry === 'number') {
    return Number.isInteger(entry) && entry > 0 && entry <= 65535
      ? { innerPort: entry, protocol: 'tcp' }
      : null
  }
  const containerPart = entry.trim().split(':').pop() ?? ''
  const [rawPort, rawProtocol] = containerPart.split('/')
  const innerPort = Number.parseInt(rawPort ?? '', 10)
  if (!Number.isInteger(innerPort) || innerPort <= 0 || innerPort > 65535) return null
  return { innerPort, protocol: rawProtocol?.toLowerCase() === 'udp' ? 'udp' : 'tcp' }
}

export function resolveForwardPorts(config: DevcontainerConfig): ResolvedPortConfig[] {
  const seen = new Set<string>()
  const ports: ResolvedPortConfig[] = []
  for (const entry of config.forwardPorts ?? []) {
    const parsed = parseForwardPort(entry)
    if (!parsed) continue
    const key = `${parsed.innerPort}/${parsed.protocol}`
    if (seen.has(key)) continue
    seen.add(key)
    const attributes = config.portsAttributes?.[String(entry)]
      ?? config.portsAttributes?.[String(parsed.innerPort)]
    const protocol = attributes?.protocol
    ports.push({
      ...parsed,
      appProtocol: protocol === 'http' || protocol === 'https' || protocol === 'tcp' || protocol === 'udp'
        ? protocol
        : parsed.protocol,
      label: attributes?.label ?? null
    })
  }
  return ports
}

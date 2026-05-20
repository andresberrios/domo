/**
 * Read + parse a project's `devcontainer.json`. The spec allows JSONC
 * (comments + trailing commas) and lookup in either of two standard
 * locations:
 *   1. `<root>/.devcontainer/devcontainer.json`
 *   2. `<root>/.devcontainer.json`
 *
 * We honor both, with (1) taking precedence (matches VS Code / the
 * `@devcontainers/cli` resolution order). Sub-folder variants
 * (`.devcontainer/<name>/devcontainer.json`, the multi-config feature)
 * are out of scope for v1.
 *
 * `extra` preserves unknown top-level keys so a future scaffold rewrite
 * (e.g. injecting the Domo claude Feature into an existing file) keeps
 * everything else intact.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as jsoncParse, printParseErrorCode } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'

import type { DevcontainerConfig } from './types'

const KNOWN_KEYS = new Set<keyof DevcontainerConfig>([
  'name',
  'image',
  'build',
  'dockerComposeFile',
  'service',
  'runServices',
  'workspaceFolder',
  'workspaceMount',
  'forwardPorts',
  'portsAttributes',
  'otherPortsAttributes',
  'features',
  'runArgs',
  'containerEnv',
  'remoteEnv',
  'remoteUser',
  'containerUser',
  'updateRemoteUserUID',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
  'initializeCommand',
  'mounts',
  'customizations',
])

export interface ResolvedDevcontainer {
  /** Absolute path to the devcontainer.json that was loaded. */
  path: string
  config: DevcontainerConfig
}

export class DevcontainerParseError extends Error {
  readonly path: string
  readonly errors: { offset: number; length: number; code: string }[]
  constructor(path: string, errors: ParseError[]) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} @${e.offset}+${e.length}`)
      .join(', ')
    super(`Invalid JSONC in ${path}: ${detail}`)
    this.name = 'DevcontainerParseError'
    this.path = path
    this.errors = errors.map((e) => ({
      offset: e.offset,
      length: e.length,
      code: printParseErrorCode(e.error),
    }))
  }
}

export class DevcontainerNotFoundError extends Error {
  readonly searched: string[]
  constructor(searched: string[]) {
    super(`No devcontainer.json found (looked in: ${searched.join(', ')})`)
    this.name = 'DevcontainerNotFoundError'
    this.searched = searched
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Standard lookup paths in priority order. */
export function devcontainerPaths(workspaceFolder: string): string[] {
  return [
    join(workspaceFolder, '.devcontainer', 'devcontainer.json'),
    join(workspaceFolder, '.devcontainer.json'),
  ]
}

/** Resolve which devcontainer.json (if any) exists for a project. */
export async function findDevcontainer(workspaceFolder: string): Promise<string | null> {
  for (const p of devcontainerPaths(workspaceFolder)) {
    if (await exists(p)) return p
  }
  return null
}

/** Parse JSONC into a `DevcontainerConfig`. Throws on syntax errors. */
export function parseDevcontainerJsonc(source: string, path: string): DevcontainerConfig {
  const errors: ParseError[] = []
  const parsed = jsoncParse(source, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
    disallowComments: false,
  }) as Record<string, unknown> | undefined
  if (errors.length > 0) {
    throw new DevcontainerParseError(path, errors)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DevcontainerParseError(path, [])
  }
  return splitKnownAndExtra(parsed)
}

function splitKnownAndExtra(raw: Record<string, unknown>): DevcontainerConfig {
  const known: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(k as keyof DevcontainerConfig)) {
      known[k] = v
    } else {
      extra[k] = v
    }
  }
  const cfg = known as DevcontainerConfig
  if (Object.keys(extra).length > 0) cfg.extra = extra
  return cfg
}

/** Load + parse a project's devcontainer.json. Throws on syntax errors;
 * throws `DevcontainerNotFoundError` if no file exists in either
 * standard location. */
export async function loadDevcontainer(workspaceFolder: string): Promise<ResolvedDevcontainer> {
  const path = await findDevcontainer(workspaceFolder)
  if (!path) {
    throw new DevcontainerNotFoundError(devcontainerPaths(workspaceFolder))
  }
  const source = await readFile(path, 'utf8')
  const config = parseDevcontainerJsonc(source, path)
  return { path, config }
}

/** Normalize a `forwardPorts` entry into the inner container port +
 * protocol. The spec allows just a number, "1234", "1234/tcp",
 * "1234/udp", or "host:container" (we take the container side). */
export function parseForwardPort(entry: number | string): { innerPort: number; protocol: 'tcp' | 'udp' } | null {
  if (typeof entry === 'number') {
    if (!Number.isInteger(entry) || entry <= 0 || entry > 65535) return null
    return { innerPort: entry, protocol: 'tcp' }
  }
  const trimmed = entry.trim()
  if (trimmed.length === 0) return null
  // "host:container" → container side; "container/proto"; bare number string.
  const containerPart = trimmed.includes(':') ? trimmed.split(':').pop()! : trimmed
  const [portStr, protoRaw] = containerPart.split('/')
  if (!portStr) return null
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  const proto = protoRaw?.toLowerCase()
  return { innerPort: port, protocol: proto === 'udp' ? 'udp' : 'tcp' }
}

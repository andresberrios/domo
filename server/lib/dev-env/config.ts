import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

import type {
  DevEnvironmentConfig,
  ForwardPortEntry,
  PortAttributes,
  ResolvedEnvironmentConfig,
  ResolvedPortConfig
} from './types'

export const DOMO_CONFIG_FILE = '.domo.json'
export const DEFAULT_IMAGE = process.env.NUXT_DEV_ENV_IMAGE
  || 'mcr.microsoft.com/devcontainers/base:ubuntu-24.04'
export const DIND_FEATURE = 'ghcr.io/devcontainers/features/docker-in-docker:2'
export const GITHUB_CLI_FEATURE = 'ghcr.io/devcontainers/features/github-cli:1'

/**
 * Every key `.domo.json` understands. Anything else — a typo, or a devcontainer
 * field Domo does not implement (`mounts`, `runArgs`, `dockerComposeFile`,
 * `initializeCommand`, …) — is an error, not something to ignore quietly.
 */
const SUPPORTED_KEYS = [
  'image', 'build', 'features', 'docker', 'remoteUser',
  'containerEnv', 'forwardPorts', 'portsAttributes', 'postCreateCommand'
] as const

const BUILD_KEYS = ['dockerfile', 'context', 'args', 'target'] as const

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The built-in definition for a project that ships no `.domo.json`. */
export function defaultEnvironmentConfig(): DevEnvironmentConfig {
  return {
    image: DEFAULT_IMAGE,
    features: {
      'ghcr.io/devcontainers/features/node:1': { version: '22' },
      // `gh` is the credential helper the generated `~/.gitconfig` names, so an
      // agent in the default environment can push with the host's GitHub login.
      [GITHUB_CLI_FEATURE]: { version: 'latest' }
    },
    docker: true,
    containerEnv: {},
    forwardPorts: [],
    portsAttributes: {}
  }
}

export async function resolveEnvironmentConfig(repoPath: string): Promise<ResolvedEnvironmentConfig> {
  const path = join(repoPath, DOMO_CONFIG_FILE)
  if (await exists(path)) {
    const file = parseJsonc<Record<string, unknown>>(await readFile(path, 'utf8'), path)
    if (file.devEnvironment !== undefined) {
      return {
        config: validate(file.devEnvironment, repoPath),
        source: 'domo',
        path,
        displayPath: DOMO_CONFIG_FILE
      }
    }
  }
  return { config: defaultEnvironmentConfig(), source: 'default', path: null, displayPath: null }
}

function fail(field: string, problem: string): never {
  throw new Error(`${DOMO_CONFIG_FILE}: devEnvironment.${field} ${problem}`)
}

/** A path a project points Domo at has to stay inside the project. */
function assertInsideRepo(field: string, value: string, repoPath: string): void {
  const inside = relative(resolve(repoPath), resolve(repoPath, value))
  if (isAbsolute(value) || inside.startsWith('..') || isAbsolute(inside)) {
    fail(field, `must stay inside the project, but "${value}" resolves outside it.`)
  }
}

function stringRecord(field: string, value: unknown): Record<string, string> {
  if (!isPlainObject(value)) fail(field, 'must be an object of string values.')
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') fail(`${field}.${key}`, 'must be a string.')
    record[key] = entry
  }
  return record
}

export function validate(input: unknown, repoPath: string): DevEnvironmentConfig {
  if (!isPlainObject(input)) {
    throw new Error(`${DOMO_CONFIG_FILE}: devEnvironment must be an object.`)
  }
  const unknown = Object.keys(input).filter(key => !(SUPPORTED_KEYS as readonly string[]).includes(key))
  if (unknown.length) {
    throw new Error(
      `${DOMO_CONFIG_FILE}: devEnvironment does not support ${unknown.map(key => `"${key}"`).join(', ')}. `
      + `Supported keys are: ${SUPPORTED_KEYS.join(', ')}.`
    )
  }

  const config = defaultEnvironmentConfig()
  config.image = undefined
  config.features = {}
  config.docker = false

  if ((input.image === undefined) === (input.build === undefined)) {
    throw new Error(`${DOMO_CONFIG_FILE}: devEnvironment needs exactly one of "image" or "build".`)
  }
  if (input.image !== undefined) {
    if (typeof input.image !== 'string' || !input.image.trim()) fail('image', 'must be a non-empty string.')
    config.image = input.image.trim()
  } else {
    const build = input.build
    if (!isPlainObject(build)) fail('build', 'must be an object.')
    const extra = Object.keys(build).filter(key => !(BUILD_KEYS as readonly string[]).includes(key))
    if (extra.length) {
      fail('build', `does not support ${extra.map(key => `"${key}"`).join(', ')}. `
        + `Supported keys are: ${BUILD_KEYS.join(', ')}.`)
    }
    if (typeof build.dockerfile !== 'string' || !build.dockerfile.trim()) {
      fail('build.dockerfile', 'must be a non-empty string.')
    }
    assertInsideRepo('build.dockerfile', build.dockerfile, repoPath)
    let context = '.'
    if (build.context !== undefined) {
      if (typeof build.context !== 'string' || !build.context.trim()) {
        fail('build.context', 'must be a non-empty string.')
      }
      assertInsideRepo('build.context', build.context, repoPath)
      context = build.context
    }
    if (build.target !== undefined && typeof build.target !== 'string') fail('build.target', 'must be a string.')
    config.build = {
      dockerfile: build.dockerfile,
      context,
      ...(build.args !== undefined && { args: stringRecord('build.args', build.args) }),
      // An empty target means "no target", which is how the devcontainer schema reads it too.
      ...(build.target ? { target: build.target } : {})
    }
  }

  if (input.features !== undefined) {
    if (!isPlainObject(input.features)) fail('features', 'must be an object keyed by Feature id.')
    config.features = { ...input.features }
  }
  if (input.docker !== undefined) {
    if (typeof input.docker !== 'boolean') fail('docker', 'must be true or false.')
    config.docker = input.docker
  }
  if (input.remoteUser !== undefined) {
    if (typeof input.remoteUser !== 'string' || !input.remoteUser.trim()) {
      fail('remoteUser', 'must be a non-empty string.')
    }
    config.remoteUser = input.remoteUser.trim()
  }
  if (input.containerEnv !== undefined) config.containerEnv = stringRecord('containerEnv', input.containerEnv)
  if (input.forwardPorts !== undefined) {
    if (!Array.isArray(input.forwardPorts)) fail('forwardPorts', 'must be an array of ports.')
    for (const entry of input.forwardPorts) {
      if (typeof entry !== 'number' && typeof entry !== 'string') {
        fail('forwardPorts', 'may only contain numbers and strings.')
      }
    }
    config.forwardPorts = input.forwardPorts as ForwardPortEntry[]
  }
  if (input.portsAttributes !== undefined) {
    if (!isPlainObject(input.portsAttributes)) fail('portsAttributes', 'must be an object keyed by port.')
    for (const [port, attributes] of Object.entries(input.portsAttributes)) {
      if (!isPlainObject(attributes)) fail(`portsAttributes.${port}`, 'must be an object.')
    }
    config.portsAttributes = input.portsAttributes as Record<string, PortAttributes>
  }
  if (input.postCreateCommand !== undefined) {
    const command = input.postCreateCommand
    const isArgv = Array.isArray(command) && command.every(part => typeof part === 'string')
    if (typeof command !== 'string' && !isArgv) {
      fail('postCreateCommand', 'must be a string (run through sh -c) or an array of strings (argv).')
    }
    config.postCreateCommand = command as string | string[]
  }
  return config
}

/**
 * The Features handed to the image build: the project's own, plus docker-in-docker
 * when `docker` is on and the project has not asked for it itself.
 */
export function buildFeatures(config: DevEnvironmentConfig): Record<string, unknown> {
  const features = { ...config.features }
  if (config.docker && !Object.keys(features).some(key => key.includes('docker-in-docker'))) {
    features[DIND_FEATURE] = { version: 'latest' }
  }
  return features
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

export function resolveForwardPorts(
  config: Pick<DevEnvironmentConfig, 'forwardPorts' | 'portsAttributes'>
): ResolvedPortConfig[] {
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

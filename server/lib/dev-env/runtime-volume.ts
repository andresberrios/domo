import { createHash } from 'node:crypto'

import type { AgentAdapter } from '../../../shared/types'
import { dockerServerArch, resourcePrefix, run } from './docker'

/**
 * Everything pinned into the runtime volume, in one place. Change any of it and the
 * volume gets a new name, so a running environment keeps the one it mounted and the
 * next environment created builds the new one.
 */
export const RUNTIME_IMAGE = process.env.NUXT_DEV_ENV_RUNTIME_IMAGE || 'node:22-bookworm-slim'
export const ADAPTER_PACKAGES: Record<AgentAdapter, {
  command: string
  spec: string
  entry: string
  args?: string[]
  native?: boolean
}> = {
  'claude-code': {
    command: 'claude-agent-acp',
    spec: '@agentclientprotocol/claude-agent-acp@0.78.0',
    entry: 'dist/index.js'
  },
  codex: {
    command: 'codex-acp',
    spec: '@agentclientprotocol/codex-acp@1.12.0',
    entry: 'dist/index.js'
  },
  opencode: {
    command: 'opencode-acp',
    spec: 'opencode-ai@1.18.28',
    entry: 'bin/opencode.exe',
    args: ['acp'],
    native: true
  }
}

/** Where the volume is mounted in every environment, read-only. */
export const RUNTIME_ROOT = '/opt/domo'

export function adapterCommandPath(adapter: AgentAdapter): string {
  return `${RUNTIME_ROOT}/bin/${ADAPTER_PACKAGES[adapter].command}`
}

export function runtimeVolumeName(arch: string): string {
  const pins = [RUNTIME_IMAGE, ...Object.values(ADAPTER_PACKAGES).map(entry => entry.spec), arch].join('\n')
  return `${resourcePrefix()}runtime-${createHash('sha256').update(pins).digest('hex').slice(0, 12)}`
}

/**
 * Populate the volume, as root, in a throwaway container of the helper image.
 *
 * `node` is copied out of the helper image because the environment's own image is not
 * required to have one — the project picks that image, and Domo's runtime must not
 * depend on it. The wrappers `exec` the adapter with that *absolute* node: npm's own
 * bin shims start `#!/usr/bin/env node`, which finds nothing in an image without node.
 * `chmod -R a+rX` leaves a non-executable file non-executable, so the wrappers are
 * chmodded by name, and `.ready` is written last so an interrupted build is redone.
 */
function populateScript(): string {
  const wrappers = Object.values(ADAPTER_PACKAGES).map(({ command, spec, entry, args = [], native }) => {
    const packageName = spec.slice(0, spec.lastIndexOf('@'))
    const executable = `${RUNTIME_ROOT}/adapters/node_modules/${packageName}/${entry}`
    const invocation = native
      ? [executable, ...args].join(' ')
      : [`${RUNTIME_ROOT}/node/bin/node`, executable, ...args].join(' ')
    return [
      `printf '%s\\n' '#!/bin/sh' `
      + `'exec ${invocation} "$@"' `
      + `> ${RUNTIME_ROOT}/bin/${command}`,
      `chmod 0755 ${RUNTIME_ROOT}/bin/${command}`
    ].join('\n')
  })
  return [
    'set -e',
    `rm -rf ${RUNTIME_ROOT}/node ${RUNTIME_ROOT}/bin ${RUNTIME_ROOT}/adapters`,
    `mkdir -p ${RUNTIME_ROOT}/node/bin ${RUNTIME_ROOT}/bin ${RUNTIME_ROOT}/adapters`,
    `cp "$(command -v node)" ${RUNTIME_ROOT}/node/bin/node`,
    `npm install --prefix ${RUNTIME_ROOT}/adapters --no-fund --no-audit --loglevel=error `
    + Object.values(ADAPTER_PACKAGES).map(entry => entry.spec).join(' '),
    ...wrappers,
    `chmod -R a+rX ${RUNTIME_ROOT}`,
    `touch ${RUNTIME_ROOT}/.ready`
  ].join('\n')
}

let pending: Promise<string> | null = null

/**
 * The shared runtime volume: Node plus the ACP adapters, mounted read-only into every
 * environment. Memoised for the process, so two environments created at once share one
 * build instead of racing each other through the same volume.
 */
export function ensureRuntimeVolume(): Promise<string> {
  pending ??= build().catch((error) => {
    pending = null
    throw error
  })
  return pending
}

async function build(): Promise<string> {
  const volume = runtimeVolumeName(await dockerServerArch())
  await run('docker', ['volume', 'create', '--label', 'domo.runtime=true', volume])
  const ready = await run('docker', [
    'run', '--rm', '--volume', `${volume}:${RUNTIME_ROOT}`, RUNTIME_IMAGE,
    'test', '-f', `${RUNTIME_ROOT}/.ready`
  ]).then(() => true, () => false)
  if (ready) return volume
  await run('docker', [
    'run', '--rm', '--volume', `${volume}:${RUNTIME_ROOT}`, RUNTIME_IMAGE,
    'sh', '-c', populateScript()
  ])
  return volume
}

/**
 * Remove every runtime volume but the current one. A volume another environment still
 * has mounted refuses to go, which is exactly the wanted behaviour — hence no error.
 */
export async function collectRuntimeVolumes(): Promise<void> {
  const keep = runtimeVolumeName(await dockerServerArch())
  const { stdout } = await run('docker', [
    'volume', 'ls', '--quiet', '--filter', `name=^${resourcePrefix()}runtime-`
  ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
  for (const volume of stdout.split('\n').map(name => name.trim()).filter(Boolean)) {
    if (volume === keep) continue
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
  }
}

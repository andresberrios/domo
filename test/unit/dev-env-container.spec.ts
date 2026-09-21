import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultEnvironmentConfig } from '../../server/lib/dev-env/config'
import {
  containerRunArgs,
  keepAliveScript,
  mergeImageMetadata,
  postCreateArgs,
  resolveRemoteUser
} from '../../server/lib/dev-env/container'
import type { DevEnvironmentConfig, ImageMetadata, ImageMetadataEntry } from '../../server/lib/dev-env/types'

/**
 * Domo owns `docker run`, so what a base image or a Feature may decide is an
 * allow-list, not whatever the `devcontainer.metadata` label happens to contain. The
 * argv is built by a pure function for exactly this reason: it is the whole contract.
 */

const DIND: ImageMetadataEntry = {
  id: 'ghcr.io/devcontainers/features/docker-in-docker:2',
  privileged: true,
  entrypoint: '/usr/local/share/docker-init.sh',
  mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }]
} as ImageMetadataEntry

function metadata(overrides: Partial<ImageMetadata> = {}): ImageMetadata {
  return {
    entrypoints: [],
    privileged: false,
    init: false,
    capAdd: [],
    securityOpt: [],
    containerEnv: {},
    volumeMounts: [],
    remoteUser: null,
    containerUser: null,
    ...overrides
  }
}

function runArgs(input: {
  config?: Partial<DevEnvironmentConfig>
  metadata?: ImageMetadata
  remoteUser?: string
  ports?: Array<{ innerPort: number, protocol: 'tcp' | 'udp' }>
  claudeConfigDir?: string | null
  codexConfigDir?: string | null
} = {}): string[] {
  return containerRunArgs({
    environmentId: 'env_1',
    projectId: 'prj_1',
    containerName: 'domo-dev-env_1',
    imageName: 'domo-dev-env_1',
    config: { ...defaultEnvironmentConfig(), ...input.config },
    metadata: input.metadata ?? metadata(),
    remoteUser: input.remoteUser ?? 'vscode',
    workspacePath: '/workspaces/api',
    workspaceVolume: 'domo-dev-env_1-workspace',
    runtimeVolume: 'domo-dev-runtime-abc123',
    ports: (input.ports ?? []).map(port => ({ ...port, appProtocol: null, label: null })),
    claudeConfigDir: input.claudeConfigDir ?? null,
    codexConfigDir: input.codexConfigDir ?? null
  })
}

/** The value of `--mount` / `--env` / `--label` arguments, in order. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : [])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mergeImageMetadata', () => {
  it('keeps each Feature\'s entrypoint, in contribution order', () => {
    const merged = mergeImageMetadata([
      { entrypoint: 'first.sh' },
      { entrypoint: 'second.sh' }
    ], 'env_1')

    expect(merged.entrypoints).toEqual(['first.sh', 'second.sh'])
  })

  it('substitutes ${devcontainerId} in a volume mount source', () => {
    expect(mergeImageMetadata([DIND], 'env_1').volumeMounts).toEqual([
      { source: 'dind-var-lib-docker-env_1', target: '/var/lib/docker' }
    ])
  })

  it('reads a mount written as a string', () => {
    const merged = mergeImageMetadata([
      { mounts: ['source=cache-${devcontainerId},target=/cache,type=volume'] }
    ], 'env_1')

    expect(merged.volumeMounts).toEqual([{ source: 'cache-env_1', target: '/cache' }])
  })

  it('drops a bind mount a Feature asked for, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const merged = mergeImageMetadata([
      { mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', type: 'bind' }] }
    ], 'env_1')

    expect(merged.volumeMounts).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/var/run/docker.sock'))
  })

  it('takes privileged, init, capabilities and security options from any entry', () => {
    const merged = mergeImageMetadata([
      { privileged: true },
      { init: true, capAdd: ['SYS_PTRACE'], securityOpt: ['seccomp=unconfined'] },
      { capAdd: ['SYS_PTRACE', 'NET_ADMIN'] }
    ], 'env_1')

    expect(merged).toMatchObject({
      privileged: true,
      init: true,
      capAdd: ['SYS_PTRACE', 'NET_ADMIN'],
      securityOpt: ['seccomp=unconfined']
    })
  })

  it('ignores everything outside the allow-list', () => {
    const merged = mergeImageMetadata([
      { postCreateCommand: 'rm -rf /', runArgs: ['--network=host'], workspaceMount: 'x' } as ImageMetadataEntry
    ], 'env_1')

    expect(merged).toEqual(metadata())
  })

  it('lets a later entry win the user', () => {
    const merged = mergeImageMetadata([{ remoteUser: 'vscode' }, { remoteUser: 'node' }], 'env_1')

    expect(merged.remoteUser).toBe('node')
  })
})

describe('resolveRemoteUser', () => {
  it.each([
    ['the project\'s own remoteUser', { remoteUser: 'dev' }, { remoteUser: 'vscode', containerUser: 'node' }, 'dev'],
    ['the image\'s remoteUser', {}, { remoteUser: 'vscode', containerUser: 'node' }, 'vscode'],
    ['the image\'s containerUser', {}, { containerUser: 'node' }, 'node'],
    ['root', {}, {}, 'root']
  ])('prefers %s', (_label, config, image, expected) => {
    const resolved = resolveRemoteUser(
      { ...defaultEnvironmentConfig(), ...config },
      metadata(image as Partial<ImageMetadata>)
    )

    expect(resolved).toBe(expected)
  })
})

describe('keepAliveScript', () => {
  it('runs each entrypoint and then idles, interruptibly', () => {
    expect(keepAliveScript(['/usr/local/share/docker-init.sh'])).toBe([
      'echo Container started',
      'trap "exit 0" 15',
      '/usr/local/share/docker-init.sh',
      'exec "$@"',
      'while sleep 1 & wait $!; do :; done'
    ].join('\n'))
  })
})

describe('containerRunArgs', () => {
  it('names, labels and mounts the environment', () => {
    const args = runArgs()

    expect(args.slice(0, 4)).toEqual(['run', '--detach', '--name', 'domo-dev-env_1'])
    expect(values(args, '--label')).toEqual([
      'domo.envId=env_1',
      'domo.projectId=prj_1',
      'domo.portsAttributes={}'
    ])
    expect(args).toContain('--add-host')
    expect(args).toContain('host.docker.internal:host-gateway')
    expect(values(args, '--mount')).toEqual([
      'type=volume,source=domo-dev-env_1-workspace,target=/workspaces/api',
      'type=volume,source=domo-dev-runtime-abc123,target=/opt/domo,readonly'
    ])
  })

  it('carries the resolved port attributes on a label, so the port scanner needs no config', () => {
    const args = runArgs({ config: { portsAttributes: { 3000: { label: 'web', protocol: 'http' } } } })

    expect(values(args, '--label')).toContain('domo.portsAttributes={"3000":{"label":"web","protocol":"http"}}')
  })

  it('is not privileged without Docker', () => {
    const args = runArgs({ config: { docker: false } })

    expect(args).not.toContain('--privileged')
    expect(values(args, '--mount').join('\n')).not.toContain('dind-var-lib-docker')
  })

  it('is privileged, with the dind volume and its entrypoint, when the metadata asks', () => {
    const args = runArgs({ metadata: mergeImageMetadata([DIND], 'env_1') })

    expect(args).toContain('--privileged')
    expect(values(args, '--mount')).toContain('type=volume,source=dind-var-lib-docker-env_1,target=/var/lib/docker')
    expect(args.at(-2)).toContain('/usr/local/share/docker-init.sh')
  })

  it('publishes each declared port on the loopback address only', () => {
    const args = runArgs({ ports: [{ innerPort: 3000, protocol: 'tcp' }, { innerPort: 5353, protocol: 'udp' }] })

    expect(values(args, '--publish')).toEqual(['127.0.0.1:0:3000/tcp', '127.0.0.1:0:5353/udp'])
  })

  it('lets the project\'s containerEnv win over the image\'s', () => {
    const args = runArgs({
      config: { containerEnv: { SHARED: 'project', OWN: 'yes' } },
      metadata: metadata({ containerEnv: { SHARED: 'image', FROM_FEATURE: 'yes' } })
    })

    expect(values(args, '--env')).toEqual([
      'DOMO_DEV_ENVIRONMENT_ID=env_1',
      'SHARED=project',
      'FROM_FEATURE=yes',
      'OWN=yes'
    ])
  })

  it('mounts the tool config directories into the remote user\'s home', () => {
    const args = runArgs({ claudeConfigDir: '/home/me/.claude', codexConfigDir: '/home/me/.codex' })

    expect(values(args, '--mount')).toEqual(expect.arrayContaining([
      'type=bind,source=/home/me/.claude,target=/home/vscode/.claude',
      'type=bind,source=/home/me/.codex,target=/home/vscode/.codex'
    ]))
  })

  it('puts them in root\'s home for an image with no user', () => {
    const args = runArgs({ remoteUser: 'root', claudeConfigDir: '/home/me/.claude' })

    expect(values(args, '--mount')).toContain('type=bind,source=/home/me/.claude,target=/root/.claude')
  })

  it('ends with the image and the keep-alive command, and never runs it through a shell string', () => {
    const args = runArgs({ metadata: metadata({ entrypoints: ['a.sh'] }) })

    expect(args.slice(-6)).toEqual([
      '--entrypoint', '/bin/sh',
      'domo-dev-env_1',
      '-c', keepAliveScript(['a.sh']), '-'
    ])
  })
})

describe('postCreateArgs', () => {
  it('runs a string through sh -c', () => {
    expect(postCreateArgs('pnpm install && pnpm build')).toEqual(['sh', '-c', 'pnpm install && pnpm build'])
  })

  it('takes an array as argv, untouched', () => {
    expect(postCreateArgs(['pnpm', 'install'])).toEqual(['pnpm', 'install'])
  })
})

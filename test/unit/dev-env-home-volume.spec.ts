import { describe, expect, it } from 'vitest'

import { homeExtractArgs, mountsUnderHome } from '../../server/lib/dev-env/home-volume'

/**
 * Copying an old environment's home into a volume. `docker cp` archives what is
 * mounted under the home too — the developer's own `~/.ssh-host`, `~/.codex` —
 * so what these exclude is what keeps a copy of those out of the volume.
 */

describe('mountsUnderHome', () => {
  it('takes every mount strictly inside the home, relative to it', () => {
    expect(mountsUnderHome('/home/vscode', [
      '/worktrees/env_1',
      '/home/vscode/.ssh-host',
      '/home/vscode/.gitconfig-host',
      '/home/vscode/.config/gh',
      '/opt/domo',
      '/var/run/docker.sock'
    ])).toEqual(['.ssh-host', '.gitconfig-host', '.config/gh'])
  })

  it('leaves out the home itself and a sibling that shares its prefix', () => {
    expect(mountsUnderHome('/home/vscode/', ['/home/vscode', '/home/vscode2/.ssh', '/home/vscodex'])).toEqual([])
  })
})

describe('homeExtractArgs', () => {
  it('mounts the volume under the home\'s name, so the archive lands without stripping, and excludes each mount', () => {
    expect(homeExtractArgs({
      volume: 'domo-dev-env_1-home',
      home: '/home/vscode',
      helperImage: 'busybox:1.37',
      exclude: ['.ssh-host', '.config/gh']
    })).toEqual([
      'run', '--rm', '--interactive',
      '--mount', 'type=volume,source=domo-dev-env_1-home,target=/mnt/vscode',
      'busybox:1.37',
      'tar', '-x', '-f', '-', '-C', '/mnt',
      '--exclude', 'vscode/.ssh-host',
      '--exclude', 'vscode/.config/gh'
    ])
  })

  it('works for root, whose home is /root', () => {
    expect(homeExtractArgs({ volume: 'v', home: '/root', helperImage: 'busybox:1.37', exclude: ['.codex'] }))
      .toEqual(expect.arrayContaining(['type=volume,source=v,target=/mnt/root', 'root/.codex']))
  })
})

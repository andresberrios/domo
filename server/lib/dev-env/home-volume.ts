import { posix } from 'node:path'

import { copyOutOfContainer, run } from './docker'
import { homeVolumeName } from './leftovers'

/**
 * The remote user's home is a named volume (`homeVolumeName`) because it is
 * where every adapter keeps what `session/load` reads: Claude Code's
 * `~/.claude/projects/<escaped cwd>/<session>.jsonl` and `~/.claude.json`,
 * OpenCode's `~/.local/share/opencode/opencode.db`. Codex's `~/.codex` is a
 * bind of the host's and needed none of this. It has to be `$HOME` itself:
 * `~/.claude.json` sits directly in it, and Claude Code replaces files of that
 * kind, so a file mount would be left on a dangling inode.
 */

/**
 * Create it empty and labelled, so the sweep attributes it. Docker fills an
 * empty volume from the image's home at the first mount, so a creation starts
 * from the image's own dotfiles as it did before there was a volume here.
 */
export async function createHomeVolume(environmentId: string): Promise<string> {
  const volume = homeVolumeName(environmentId)
  await run('docker', ['volume', 'create', '--label', `domo.envId=${environmentId}`, volume])
  return volume
}

/** The mounts strictly inside the home, relative to it: the host directories the overlay binds there, and the rest. */
export function mountsUnderHome(home: string, destinations: string[]): string[] {
  const root = posix.normalize(home).replace(/\/+$/, '')
  return destinations
    .map(destination => posix.normalize(destination))
    .filter(destination => destination.startsWith(`${root}/`))
    .map(destination => destination.slice(root.length + 1))
}

/**
 * The helper that unpacks an archive of the old home into the volume. The
 * archive's top entry is the home's own name, so the volume is mounted under
 * that name and nothing has to be stripped. Extracted as root, so every file
 * keeps its owner by number.
 *
 * `docker cp` of a stopped container archives what is mounted under the path
 * too, which here is the developer's own `~/.ssh-host`, `~/.codex` and the
 * rest. Each mount is excluded, or the volume would keep a copy of them.
 */
export function homeExtractArgs(input: {
  volume: string
  home: string
  helperImage: string
  exclude: string[]
}): string[] {
  const name = posix.basename(input.home)
  return [
    'run', '--rm', '--interactive',
    '--mount', `type=volume,source=${input.volume},target=/mnt/${name}`,
    input.helperImage,
    'tar', '-x', '-f', '-', '-C', '/mnt',
    ...input.exclude.flatMap(path => ['--exclude', `${name}/${path}`])
  ]
}

/**
 * Copy a container's writable-layer home into a new home volume, for an
 * environment created before there was one. Measured: a Claude Code session
 * copied this way resumes in a new container, under a newer adapter.
 */
export async function migrateHome(input: {
  environmentId: string
  containerId: string
  home: string
  mountDestinations: string[]
  helperImage: string
}): Promise<string> {
  const volume = await createHomeVolume(input.environmentId)
  // A half-copied home must not be taken for a whole one by the next attempt.
  const discard = async (error: unknown) => {
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
    throw error
  }
  await copyOutOfContainer({
    containerId: input.containerId,
    path: input.home,
    label: `${input.home} into ${volume}`,
    consumerArgs: homeExtractArgs({
      volume,
      home: input.home,
      helperImage: input.helperImage,
      exclude: mountsUnderHome(input.home, input.mountDestinations)
    })
  }).catch(discard)
  return volume
}

import { posix } from 'node:path'

import { copyOutOfContainer, resourcePrefix, run } from './docker'
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
 * Each mount under the home is excluded. The snapshot holds only the empty
 * stub Docker made for it, which the new container mounts over anyway, and a
 * `docker cp` of the container itself would archive the developer's own
 * `~/.ssh-host`, `~/.codex` and the rest.
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

/** The image the old container's own layer is committed to while its home is read. */
export function homeSnapshotName(environmentId: string): string {
  return `${resourcePrefix()}${environmentId}-home-snapshot`.toLowerCase()
}

/**
 * Copy a container's writable-layer home into a new home volume, for an
 * environment created before there was one. Measured: a Claude Code session
 * copied this way resumes in a new container, under a newer adapter.
 *
 * Read through a snapshot, never with `docker cp` of the old container: to
 * read a stopped container the daemon mounts everything it mounted again, and
 * a bind whose host source is gone fails the copy (`mkdirat
 * run/docker-host.sock: file exists`), as the proxy socket of an environment
 * another Domo made is. `docker commit` takes the container's own layer and
 * none of its mounts, and a container created from that, never started, has
 * nothing mounted but the image's anonymous volumes.
 */
export async function migrateHome(input: {
  environmentId: string
  containerId: string
  home: string
  mountDestinations: string[]
  helperImage: string
}): Promise<string> {
  const volume = await createHomeVolume(input.environmentId)
  const snapshot = homeSnapshotName(input.environmentId)
  let reader: string | null = null
  try {
    await run('docker', ['commit', input.containerId, snapshot])
    reader = (await run('docker', ['create', '--network', 'none', '--entrypoint', 'true', snapshot])).stdout.trim()
    await copyOutOfContainer({
      containerId: reader,
      path: input.home,
      label: `${input.home} into ${volume}`,
      consumerArgs: homeExtractArgs({
        volume,
        home: input.home,
        helperImage: input.helperImage,
        exclude: mountsUnderHome(input.home, input.mountDestinations)
      })
    })
  } catch (error) {
    // A half-copied home must not be taken for a whole one by the next attempt.
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not copy the old container's ${input.home} into a home volume, so nothing was changed: ${reason}. `
      + 'Upgrade again once the cause is fixed (often disk space: `docker system df`). '
      + 'If it keeps failing, create a new environment on the same branch: the checkout is kept, '
      + 'but this one\'s agent sessions cannot be resumed there.',
      { cause: error }
    )
  } finally {
    if (reader) await run('docker', ['rm', '--force', '--volumes', reader], { allowFailure: true }).catch(() => {})
    await run('docker', ['image', 'rm', '--force', snapshot], { allowFailure: true }).catch(() => {})
  }
  return volume
}

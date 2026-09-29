/**
 * Making the environment's user the owner of the worktree it works in.
 *
 * The checkout is a bind mount of the developer's own files. Docker Desktop
 * presents every file of one to the container as owned by whoever reads it
 * (measured: a Mac user's files read as uid 1000 inside), so nothing is
 * needed there. A Linux daemon hands the host's uid through unchanged, and the
 * image's user (1000 for the Dev Container images) may not be the developer's:
 * then the agent cannot write the checkout, or everything it writes belongs to
 * somebody the developer is not. The Dev Container CLI answers this by
 * renumbering the image's user to the host's, and so does this — at creation,
 * as root, before anything runs as that user.
 */

export interface AlignmentInput {
  /** `docker info`'s OperatingSystem. */
  daemonOs: string
  remoteUser: string
  /** Owner of the worktree on the host. */
  hostUid: number
  hostGid: number
  /** The remote user's uid inside the image. */
  containerUid: number
}

export type Alignment =
  | { kind: 'none' }
  | { kind: 'renumber', uid: number, gid: number }
  /** A root remote user on a Linux daemon: everything it writes in the checkout is root's on the host. */
  | { kind: 'root-owned' }

export function planAlignment(input: AlignmentInput): Alignment {
  if (/docker desktop/i.test(input.daemonOs)) return { kind: 'none' }
  if (input.remoteUser === 'root') return input.hostUid === 0 ? { kind: 'none' } : { kind: 'root-owned' }
  // A root-owned checkout is not one to hand the agent's user root's uid for.
  if (input.hostUid === 0 || input.hostUid === input.containerUid) return { kind: 'none' }
  return { kind: 'renumber', uid: input.hostUid, gid: input.hostGid }
}

/**
 * Renumber the user and its primary group, then re-own what the old ids
 * owned in its home. `-o` because the host's id may already be taken in the
 * image. The home is walked with `-xdev` and only files owned by the *old* uid
 * are touched, so the host directories Domo bind-mounts into it (`~/.ssh-host`
 * and the rest) are never chowned. Every value arrives as argv.
 */
export const ALIGN_USER_SCRIPT = [
  'set -e',
  'user="$1"; uid="$2"; gid="$3"',
  'command -v usermod >/dev/null && command -v groupmod >/dev/null || { echo "the image has no usermod" >&2; exit 3; }',
  'old_uid="$(id -u "$user")"; old_gid="$(id -g "$user")"; group="$(id -gn "$user")"',
  'home="$(getent passwd "$user" | cut -d: -f6)"',
  'groupmod -o -g "$gid" "$group"',
  'usermod -o -u "$uid" -g "$gid" "$user"',
  '[ -d "$home" ] && find "$home" -xdev \\( -uid "$old_uid" -o -gid "$old_gid" \\) -exec chown -h "$uid:$gid" {} +',
  'exit 0'
].join('\n')

export function alignUserArgs(input: { user: string, uid: number, gid: number }): string[] {
  return ['sh', '-c', ALIGN_USER_SCRIPT, 'sh', input.user, String(input.uid), String(input.gid)]
}

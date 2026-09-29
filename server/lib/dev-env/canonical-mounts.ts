import { posix } from 'node:path'

/**
 * Where a worktree-backed workspace and its base checkout's `.git` live inside
 * every environment container — one fixed layout, independent of the
 * environment's own display name and of wherever the host happens to keep the
 * project.
 *
 * A linked git worktree's own `.git` is a file naming an absolute path back
 * into the main checkout's `.git/worktrees/<id>` (`commondir` under there is
 * already relative — `../..` — so only this one file matters). That absolute
 * path has to resolve inside whichever mount namespace git is asked to work
 * in. Mirroring the host's real path would couple the container's layout to
 * wherever the developer happens to keep the repo, and collide the moment two
 * projects share a directory depth — so every environment instead mounts its
 * project's base `.git` at one canonical, project-keyed path, and the
 * container sees a `.git` file rewritten to point there (`host-worktree.ts`
 * does the rewrite, as a *second*, container-only file bind-mounted over the
 * worktree's own — never by editing the worktree's real `.git`, which would
 * break `git worktree remove` on the host; see that module).
 *
 * The environment's user-facing `workspacePath` (`/workspaces/<name>`) stays a
 * symlink to `canonicalWorkspacePath`, not the real mount itself, so a
 * project's own compose file — which may bind the checkout at any path it
 * likes — and Domo's own bind-source resolution (`dood/binds.ts`) only ever
 * have to reason about one real destination per environment, regardless of
 * how many display paths alias it.
 */

export const WORKTREE_MOUNT_ROOT = '/worktrees'

/** The environment's own checkout: a bind mount of its host worktree, keyed by environment id. */
export function canonicalWorkspacePath(environmentId: string): string {
  return posix.join(WORKTREE_MOUNT_ROOT, environmentId)
}

/**
 * The project's base checkout's `.git`, bind-mounted read-write into every one
 * of its environments — read-write because a worktree's own admin state
 * (`HEAD`, `index`) lives inside it, and because git writes new objects here
 * on every commit an agent makes. Keyed by project, not environment: every
 * environment of one project shares the same base checkout, the same way
 * `git worktree add` already shares one object database on the host.
 */
export function canonicalBaseGitPath(projectId: string): string {
  return posix.join(WORKTREE_MOUNT_ROOT, '.base', projectId)
}

/**
 * Where a worktree's rewritten `.git` file points, once its base is mounted
 * at `canonicalBaseGitPath`. `adminPath` is the worktree's admin directory
 * relative to the base `.git` (`worktrees/<name>`), read back from what git
 * actually made rather than assumed, since git suffixes the name on a clash.
 */
export function canonicalWorktreeGitdir(projectId: string, adminPath: string): string {
  if (!adminPath || posix.isAbsolute(adminPath) || adminPath.split('/').includes('..')) {
    throw new Error(`"${adminPath}" is not a worktree admin directory inside the base checkout's .git.`)
  }
  return posix.join(canonicalBaseGitPath(projectId), adminPath)
}

/** The container-side content of the worktree's rewritten `.git` file. */
export function canonicalGitdirFileContents(projectId: string, adminPath: string): string {
  return `gitdir: ${canonicalWorktreeGitdir(projectId, adminPath)}\n`
}

/**
 * `ln -sfn` from the legacy/display path to the canonical mount, run once as
 * root right after the container starts — the same pattern `SSH_HOME_SCRIPT`
 * (`dev-environments.ts`) already uses for the host's `~/.ssh` entries.
 * `-n` so a recreated environment replaces a stale symlink rather than
 * nesting inside one. Argv only: neither path is ever interpolated into the
 * script text.
 */
export const WORKSPACE_ALIAS_SCRIPT = [
  'set -e',
  'target="$1"; alias="$2"',
  'mkdir -p "$(dirname "$alias")"',
  'ln -sfn "$target" "$alias"'
].join('\n')

export function workspaceAliasArgs(input: { canonicalPath: string, legacyPath: string }): string[] {
  return ['sh', '-c', WORKSPACE_ALIAS_SCRIPT, 'sh', input.canonicalPath, input.legacyPath]
}

export interface WorkspaceAlias {
  /** The path project config, compose files and existing Domo code already expect (`/workspaces/<name>`). */
  legacyPath: string
  /** The real bind-mount destination the legacy path is symlinked to. */
  canonicalPath: string
}

/**
 * A path resolved through an environment's one workspace alias, so code that
 * matches against `docker inspect`'s mount table — which only ever lists the
 * real, canonical destination, never the symlink — sees the same target
 * whichever way a caller named it. Only one hop: Domo itself creates exactly
 * one symlink per environment, never a chain.
 */
export function resolveWorkspaceAlias(path: string, alias: WorkspaceAlias): string {
  if (path === alias.legacyPath) return alias.canonicalPath
  if (path.startsWith(`${alias.legacyPath}/`)) return alias.canonicalPath + path.slice(alias.legacyPath.length)
  return path
}

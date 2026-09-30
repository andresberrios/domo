import type { DevEnvironment } from './types'

/**
 * Why git would refuse `name` as a branch, in git's own terms, or null when it
 * would take it. An environment's name is its branch, verbatim, so this is the
 * whole of what a name may be. The rules of `git check-ref-format --branch`,
 * kept here so the new-environment dialog can say so as the name is typed;
 * the worktree step still asks git itself.
 */
export function branchNameProblem(name: string): string | null {
  if (!name) return 'A name is required.'
  if (name !== name.trim()) return 'A branch name cannot start or end with a space.'
  if (name === '@' || name === 'HEAD') return `"${name}" is reserved by git.`
  if (name.startsWith('-')) return 'A branch name cannot start with "-".'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(name)) return 'A branch name cannot contain spaces or control characters.'
  const bad = name.match(/[~^:?*[\\]/)
  if (bad) return `A branch name cannot contain "${bad[0]}".`
  if (name.includes('..')) return 'A branch name cannot contain "..".'
  if (name.includes('@{')) return 'A branch name cannot contain "@{".'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'A branch name cannot start or end with "/", or have two in a row.'
  }
  if (name.endsWith('.')) return 'A branch name cannot end with ".".'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a branch name between slashes can start with ".".'
    if (part.endsWith('.lock')) return 'No part of a branch name between slashes can end with ".lock".'
  }
  return null
}

/** FNV-1a, as six hex digits: short, stable, and the same in the browser and on the server. */
function shortHash(text: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * The single path segment a name becomes where one is required (the
 * environment's directory under /workspaces). A name that is one already is
 * kept; any other gets a hash of the name as well, so `a/b` and `a-b` cannot
 * land on the same directory.
 */
export function environmentSlug(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  return safe === name ? name : `${safe}-${shortHash(name)}`
}

/** One line of an environment list grouped by the slashes in the names, as folders. */
export type EnvironmentListRow<T> =
  | { kind: 'folder', path: string, label: string, depth: number, count: number }
  | { kind: 'environment', environment: T, label: string, depth: number }

/**
 * An environment list as folders: `handoff/speech` and `handoff/voice` sit
 * under a `handoff` folder, to any depth, and each shows its last segment.
 * Flat, with a depth, so a list renders it without recursion; the rows inside a
 * collapsed folder are left out. Folders come first at each level, by name;
 * environments keep the order they came in.
 */
export function environmentListRows<T extends { name: string }>(
  environments: T[],
  isCollapsed: (path: string) => boolean = () => false
): Array<EnvironmentListRow<T>> {
  interface Folder { folders: Map<string, Folder>, items: T[], count: number }
  const root: Folder = { folders: new Map(), items: [], count: 0 }
  for (const environment of environments) {
    // Empty segments (a leading, trailing or doubled slash in an old name) are not folders.
    const folders = environment.name.split('/').filter(Boolean).slice(0, -1)
    let node = root
    node.count++
    for (const part of folders) {
      let next = node.folders.get(part)
      if (!next) {
        next = { folders: new Map(), items: [], count: 0 }
        node.folders.set(part, next)
      }
      next.count++
      node = next
    }
    node.items.push(environment)
  }
  const rows: Array<EnvironmentListRow<T>> = []
  const walk = (node: Folder, prefix: string, depth: number) => {
    for (const [segment, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${segment}` : segment
      rows.push({ kind: 'folder', path, label: segment, depth, count: folder.count })
      if (!isCollapsed(path)) walk(folder, path, depth + 1)
    }
    for (const environment of node.items) {
      rows.push({ kind: 'environment', environment, label: environment.name.split('/').filter(Boolean).at(-1) ?? environment.name, depth })
    }
  }
  walk(root, '', 0)
  return rows
}

/**
 * What retiring does to an environment's branch, in a sentence, for every
 * surface that asks before retiring.
 */
export function branchOnRetirement(environment: Pick<DevEnvironment, 'branch' | 'branchCreated'>): string {
  if (!environment.branch) return 'Commits stay in your repository.'
  return environment.branchCreated
    ? `Commits stay in your repository, and its branch ${environment.branch} is deleted if every commit on it is also on another branch.`
    : `Commits stay in your repository, and so does your branch ${environment.branch}, which it reused.`
}

/** What a retirement did with the branch, in a sentence; empty when it had none to decide on. */
export function describeBranchOutcome(branch: { name: string, deleted: boolean, reason: string } | null | undefined): string {
  if (!branch) return ''
  return `${branch.deleted ? 'Deleted' : 'Kept'} the branch ${branch.name}: ${branch.reason}`
}

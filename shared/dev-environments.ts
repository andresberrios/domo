import type { AgentAdapter, DevEnvironment, EnvironmentUpgrade } from './types'

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
export function branchOnRetirement(environment: Pick<DevEnvironment, 'branch'>): string {
  if (!environment.branch) return 'Commits stay in your repository.'
  return `Commits stay in your repository, and its branch ${environment.branch} is deleted if every commit on it is also on another branch.`
}

/** What a retirement did with the branch, in a sentence; empty when it had none to decide on. */
export function describeBranchOutcome(branch: { name: string, deleted: boolean, reason: string } | null | undefined): string {
  if (!branch) return ''
  return `${branch.deleted ? 'Deleted' : 'Kept'} the branch ${branch.name}: ${branch.reason}`
}

/**
 * The coding-agent adapters after an upgrade, in a phrase. They are always
 * this Domo's pinned versions then; the old ones are named only when known
 * (another Domo's stopped container cannot be read).
 */
export function describeAdapterUpgrade(upgrade: Pick<EnvironmentUpgrade, 'adapters'>): string {
  const { from, to } = upgrade.adapters
  const entries = Object.entries(to) as Array<[AgentAdapter, string]>
  const versions = entries.map(([adapter, version]) => `${adapter} ${version}`).join(', ')
  if (!from) return `current (${versions})`
  const changed = entries.filter(([adapter, version]) => from[adapter] !== version)
  if (!changed.length) return `already current (${versions})`
  return `updated to current (${changed.map(([adapter, version]) => `${adapter} ${from[adapter] ?? 'none'} → ${version}`).join(', ')})`
}

/** What an upgrade left for somebody to do or know, as plain sentences; empty when nothing. */
export function upgradeNotes(upgrade: EnvironmentUpgrade): string[] {
  const notes: string[] = []
  const stranded = upgrade.stranded.join(', ')
  if (upgrade.stopped && upgrade.stranded.length) {
    notes.push(`Its Docker stack was stopped. Bring it up again with docker compose up -d --force-recreate: ${stranded} `
      + 'shared the old container\'s network or processes, and only a recreate mends them.')
  } else if (upgrade.stranded.length) {
    notes.push(`${stranded} shared the old container's network or processes and must be created again: docker compose up -d --force-recreate.`)
  } else if (upgrade.stopped) {
    notes.push(`Its Docker stack was stopped (${upgrade.stopped} ${upgrade.stopped === 1 ? 'container' : 'containers'}). Bring it up again with docker compose up -d.`)
  }
  if (upgrade.home === 'lost') notes.push('Its home was gone with its old container, so its sessions start without their history.')
  if (upgrade.movedFrom) notes.push(`It was moved here from a container another Domo made (${upgrade.movedFrom}).`)
  if (upgrade.releasedVolumes.length) {
    notes.push(`This Domo no longer uses ${upgrade.releasedVolumes.join(', ')}. They belong to the other Domo, so they were left `
      + 'in place: remove them with docker volume rm once it no longer needs them.')
  }
  return notes
}

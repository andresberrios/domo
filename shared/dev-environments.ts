import type { DevEnvironment } from './types'

/**
 * The path segment and the branch name an environment's name becomes. Shared
 * so the new-environment dialog can say which branch it will make, or reuse,
 * before anything is created.
 */
export function safeEnvironmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()
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

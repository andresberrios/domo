import type { AgentSession, DevEnvironment } from './types'

/**
 * When a retired session can be brought back into service — the one rule, in
 * one place, because the server enforces it and the UI has to explain it.
 *
 * Retirement is not symmetric with deletion. Retiring keeps the record; the
 * thing that decides whether the *session* can resume is whether the place it
 * ran still exists. A host session has a working directory that is still on
 * disk (or is not, which `startEnvironment`'s host equivalent will say at start
 * time); a container session has an environment whose volume holds both the
 * checkout and the adapter's own session storage, and deleting that environment
 * destroys both. So a session retired *by* an environment deletion is never
 * revivable, and saying otherwise would offer a button that cannot work.
 *
 * What revival does *not* promise is that the coding agent remembers anything.
 * The ACP session id Domo stores is a handle into the adapter's own storage;
 * `session/load` may still find it, and `boot()` falls back to `session/new` in
 * the same directory when it does not. Domo's transcript survives either way —
 * that is what retention means here, and it is the honest thing to tell a user.
 */
export type RevivalState =
  | { revivable: true }
  | { revivable: false, reason: string }

export function revivalState(
  session: Pick<AgentSession, 'retiredAt' | 'devEnvironmentId'>,
  environment: Pick<DevEnvironment, 'name' | 'deletedAt'> | null
): RevivalState {
  if (!session.retiredAt) return { revivable: false, reason: 'This session is not retired.' }
  if (!session.devEnvironmentId) return { revivable: true }
  if (!environment) {
    return {
      revivable: false,
      reason: 'The development environment it ran in is gone, and so is the checkout it worked on.'
    }
  }
  if (environment.deletedAt) {
    return {
      revivable: false,
      reason: `The development environment "${environment.name}" was deleted, along with its container and its copy of the checkout.`
    }
  }
  return { revivable: true }
}

/** What the user is told a revival will and will not restore. */
export const REVIVAL_CAVEAT
  = 'Domo\'s transcript of this session is kept either way. What may not come back is the '
    + 'coding agent\'s own memory of it: if its harness can no longer load the session, it '
    + 'starts a fresh one in the same working directory.'

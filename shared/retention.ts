import type { AgentSession, DevEnvironment } from './types'

/**
 * Whether a coding agent session can be started — derived, never stored.
 *
 * It is not a property of the session at all. It is a question about the
 * *place* it ran: a container session needs its development environment to
 * still be real, and a host session needs its working directory to still be on
 * disk. Both can stop being true without anything touching the session row, so
 * a column would only ever be a copy of this answer that is wrong from the
 * moment an environment is retired.
 *
 * It is deliberately separate from `archived`, which is only about whether the
 * session shows up in a list. A session in a retired environment is perfectly
 * visible and simply not runnable, and the UI says so on the session rather
 * than hiding it.
 *
 * Pure, and shared on purpose: the server refuses off this and the UI explains
 * off this, so a button is never offered for something the server would reject.
 *
 * `cwdPresent` is `null` for "not checked here" — only the start path stats the
 * filesystem, and everything above it (the inbox, the mesh, the browser) asks
 * the environment question alone.
 */
export type Startability =
  | { startable: true }
  | { startable: false, reason: string }

export function sessionStartability(
  session: Pick<AgentSession, 'devEnvironmentId' | 'cwd'>,
  environment: Pick<DevEnvironment, 'name' | 'retiredAt'> | null,
  cwdPresent: boolean | null = null
): Startability {
  if (session.devEnvironmentId) {
    if (!environment) {
      return {
        startable: false,
        reason: 'The development environment it ran in is gone, and so is the checkout it worked on.'
      }
    }
    if (environment.retiredAt) {
      return {
        startable: false,
        reason: `The development environment "${environment.name}" was retired: its container and its copy of the checkout no longer exist.`
      }
    }
    return { startable: true }
  }

  if (cwdPresent === false) {
    return {
      startable: false,
      reason: `Its working directory ${session.cwd} is no longer on disk.`
    }
  }
  return { startable: true }
}

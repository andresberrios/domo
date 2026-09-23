import type { EnvironmentLeftover, LeftoverKind } from '../../../shared/types'
import { resourcePrefix, run } from './docker'

/**
 * Which Docker resources belong to which environment, and which of them Domo
 * is allowed to remove.
 *
 * Every name an environment owns is derived from its id, which is what makes a
 * cleanup that failed *findable* later: the row survives retirement, so the
 * container, the workspace volume, the Docker-in-Docker volume and the image
 * can all be named again from it with certainty, hours after the `docker
 * volume rm` that was refused.
 *
 * **Attribution is positive, and that is the whole safety argument.** A
 * resource is removed only because a row claims it by name — a retired
 * environment claims all four, and any environment claims whatever a cleanup
 * already wrote down as owed. Everything else is left alone: a live
 * environment's volume (the only copy of an agent's work), the shared
 * hash-named runtime and browser volumes (which have their own collectors), a
 * second Domo install's resources on the same daemon, a name this does not
 * recognise. Sweeping by prefix instead would be one `docker volume ls` away
 * from destroying work nobody can get back, and ids are random, so positive
 * attribution costs nothing.
 */

export interface Leftover {
  kind: LeftoverKind
  name: string
  /** The environment whose row claims it. */
  environmentId: string
}

/** The named volume that holds an environment's checkout. Derived from the id, so it needs no column. */
export function workspaceVolumeName(environmentId: string): string {
  return `${resourcePrefix()}${environmentId}-workspace`.toLowerCase()
}

/**
 * Every Docker resource an environment owns, named from its id alone.
 *
 * The Docker-in-Docker volume is in here because the Feature declares it as
 * `dind-var-lib-docker-${devcontainerId}` and `container.ts` substitutes the
 * environment id — so it is as derivable as the rest, even though
 * `removeContainer` finds it by inspecting the container instead (which also
 * catches a Feature that names it something else).
 */
export function environmentResources(environmentId: string): Leftover[] {
  const prefix = resourcePrefix()
  return [
    { kind: 'container', name: `${prefix}${environmentId}`.toLowerCase(), environmentId },
    { kind: 'volume', name: workspaceVolumeName(environmentId), environmentId },
    { kind: 'volume', name: `dind-var-lib-docker-${environmentId}`, environmentId },
    { kind: 'image', name: `${prefix}${environmentId}`.toLowerCase(), environmentId }
  ]
}

/** What an environment row claims: everything, once retired, plus whatever a past cleanup recorded as owed. */
export function claimedResources(
  environment: { id: string, retiredAt: string | null, leftovers: EnvironmentLeftover[] }
): Leftover[] {
  const claims = new Map<string, Leftover>()
  const add = (leftover: Leftover) => claims.set(`${leftover.kind}:${leftover.name}`, leftover)
  if (environment.retiredAt) for (const resource of environmentResources(environment.id)) add(resource)
  for (const { kind, name } of environment.leftovers) add({ kind, name, environmentId: environment.id })
  return [...claims.values()]
}

/** What Docker says it currently has, of the kinds an environment can own. */
export interface ObservedResources {
  containers: string[]
  volumes: string[]
  images: string[]
}

/**
 * The resources to remove: claimed by a row, and actually still there.
 *
 * Observation is what decides, never an exit code — `docker volume rm` fails
 * both for a volume something still has mounted and for a volume that was
 * never created, and only the first of those is a leftover.
 *
 * The order is load-bearing: a container is removed before the volumes it
 * mounts and the image it was made from, or both of those refuse while it is
 * still there and one failed cleanup becomes three.
 */
export function planLeftoverRemoval(input: {
  environments: Array<{ id: string, retiredAt: string | null, leftovers: EnvironmentLeftover[] }>
  present: ObservedResources
}): Leftover[] {
  const present: Record<LeftoverKind, Set<string>> = {
    container: new Set(input.present.containers),
    volume: new Set(input.present.volumes),
    image: new Set(input.present.images)
  }
  const claimed = input.environments.flatMap(environment => claimedResources(environment))
  const order: LeftoverKind[] = ['container', 'volume', 'image']
  return order.flatMap(kind => claimed.filter(
    leftover => leftover.kind === kind && present[kind].has(leftover.name)
  ))
}

/**
 * The shared volumes, which are nobody's environment and have their own
 * collectors (`collectRuntimeVolumes` / `collectBrowserVolumes`). Named by a
 * hash of what is pinned inside them, so no row will ever claim one.
 */
function isSharedVolume(name: string): boolean {
  const prefix = resourcePrefix()
  return name.startsWith(`${prefix}runtime-`) || name.startsWith(`${prefix}browser-`)
}

/**
 * Present resources that no row accounts for at all — **reported, never
 * removed.**
 *
 * This is the case Domo cannot safely act on and must not pretend it can: a
 * second install on the same daemon, or a leftover whose row was pruned before
 * there was anything to keep it. Removing one would mean assuming this database
 * is the only account of what is on this machine, and the cost of being wrong
 * is somebody else's checkout. Saying so is free.
 */
export function unattributedResources(input: {
  environments: Array<{ id: string }>
  present: ObservedResources
}): string[] {
  const known = new Set(input.environments.flatMap(
    environment => environmentResources(environment.id).map(resource => `${resource.kind} ${resource.name}`)
  ))
  return [
    ...input.present.containers.map(name => `container ${name}`),
    ...input.present.volumes.filter(name => !isSharedVolume(name)).map(name => `volume ${name}`),
    ...input.present.images.map(name => `image ${name}`)
  ].filter(entry => !known.has(entry))
}

/** The argv that removes one. `--volumes` takes the anonymous volumes a container owns outright. */
export function removeArgs(leftover: Leftover): string[] {
  if (leftover.kind === 'container') return ['rm', '--force', '--volumes', leftover.name]
  if (leftover.kind === 'volume') return ['volume', 'rm', leftover.name]
  return ['image', 'rm', leftover.name]
}

async function names(args: string[]): Promise<string[]> {
  const { stdout } = await run('docker', args)
  return stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * What Docker has, asked for rather than assumed.
 *
 * Deliberately **not** `allowFailure`: an unreachable daemon answers with an
 * empty stdout, and reading that as "nothing is there" would clear every
 * recorded leftover and call a cleanup that never ran a success. A throw is
 * what the caller needs, and it is the caller that decides to retry.
 */
export async function observeEnvironmentResources(): Promise<ObservedResources> {
  const prefix = resourcePrefix()
  const [containers, prefixed, dind, images] = await Promise.all([
    names(['ps', '--all', '--format', '{{.Names}}', '--filter', `name=^${prefix}`]),
    names(['volume', 'ls', '--quiet', '--filter', `name=^${prefix}`]),
    names(['volume', 'ls', '--quiet', '--filter', 'name=^dind-var-lib-docker-']),
    names(['image', 'ls', '--filter', `reference=${prefix}*`, '--format', '{{.Repository}}'])
  ])
  return { containers, volumes: [...prefixed, ...dind], images }
}

/**
 * What to ask Docker when it refuses, to find out *what* is in the way.
 *
 * Docker's own refusal is not actionable — "volume is in use" names nothing a
 * person can go and deal with, and the raw id in brackets is not a name either.
 * Both filters below answer with the thing that actually has to go first: the
 * containers mounting a volume, or the containers running an image.
 *
 * There is no equivalent for an image blocked by a **child image**. Docker
 * does not name them and offers no filter that does (`since` is chronology,
 * not descent), so that case says what happened and stops rather than
 * inventing a suspect.
 */
export function blockerArgs(leftover: Leftover): string[] | null {
  if (leftover.kind === 'volume') {
    return ['ps', '--all', '--filter', `volume=${leftover.name}`, '--format', '{{.Names}}']
  }
  if (leftover.kind === 'image') {
    return ['ps', '--all', '--filter', `ancestor=${leftover.name}`, '--format', '{{.Names}}']
  }
  return null
}

/** Docker's own words, minus the wrapping this codebase and the daemon add. */
function bareError(error: string): string {
  return error
    .replace(/^docker \w+ failed: /, '')
    .replace(/^Error response from daemon: /, '')
    .trim()
}

/**
 * Why a removal was refused, written so that whoever reads it can fix it
 * without investigating anything first.
 *
 * Pure, because the wording is the feature. Every cause that survives one
 * honest attempt is something a person or an agent has to go and remove — a
 * container another tool left mounting the volume, an image somebody built a
 * container from — so the message names it and says what to do about it. There
 * is no retry loop behind this to make a vague message survivable.
 */
export function explainRefusal(input: {
  leftover: Leftover
  error: string
  /** Containers Docker named as holding it, if any. */
  blockers: string[]
}): string {
  const bare = bareError(input.error)
  const holding = input.leftover.kind === 'volume'
    ? { one: 'still has it mounted', many: 'still have it mounted' }
    : { one: 'was made from it', many: 'were made from it' }
  if (input.blockers.length === 1) {
    return `Container ${input.blockers[0]} ${holding.one}. `
      + `Remove it (docker rm -f ${input.blockers[0]}) and run the cleanup again.`
  }
  if (input.blockers.length > 1) {
    return `${input.blockers.length} containers ${holding.many}: ${input.blockers.join(', ')}. `
      + `Remove them (docker rm -f ${input.blockers.join(' ')}) and run the cleanup again.`
  }
  if (input.leftover.kind === 'image' && /child image/i.test(bare)) {
    return 'Another image on this machine was built from it, and Docker will not remove an image that has one. '
      + `Find it (docker image ls --filter since=${input.leftover.name}), remove it, and run the cleanup again.`
  }
  return `Docker refused: ${bare}`
}

export interface RemovalOutcome {
  removed: Leftover[]
  failed: Array<Leftover & { error: string }>
}

/**
 * Remove each, and say which did not go **and why, in a sentence somebody can
 * act on**. One failure never stops the rest.
 *
 * The blocker lookup is one extra `docker ps` per failure, on a path that is
 * already the unhappy one. It is what makes this a report instead of a retry:
 * the causes that survive a first attempt do not clear on their own, so the
 * only thing that helps is naming the container in the way.
 */
export async function removeLeftovers(targets: Leftover[]): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = { removed: [], failed: [] }
  for (const target of targets) {
    try {
      await run('docker', removeArgs(target))
      outcome.removed.push(target)
    } catch (error) {
      const args = blockerArgs(target)
      const blockers = args ? await names(args).catch(() => []) : []
      outcome.failed.push({
        ...target,
        error: explainRefusal({
          leftover: target,
          error: error instanceof Error ? error.message : String(error),
          blockers
        })
      })
    }
  }
  return outcome
}

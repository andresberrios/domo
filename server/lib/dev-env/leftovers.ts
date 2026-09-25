import type { EnvironmentLeftover, LeftoverKind } from '../../../shared/types'
import { parsePrivateName } from '../dood/images'
import { resourcePrefix, run } from './docker'

/**
 * Which Docker resources belong to which environment, and which of them Domo
 * is allowed to remove.
 *
 * An environment owns two sorts of thing on the daemon. What it *is* is named
 * from its id — its container, its workspace volume, its image and, for a
 * Docker-in-Docker one, `dind-var-lib-docker-<id>` — so a cleanup that failed
 * is findable by name hours later: the row survives retirement and names them
 * again with certainty. What it *made* through its Docker proxy
 * (`server/lib/dood/`) is named by the agent, so it is found by what the proxy
 * stamped on it instead: the `domo.env=<id>` label on every container, network
 * and volume, and the `domo-<id>/…` spelling of every image tag it produced.
 * Both are attribution by id, and ids are random.
 *
 * **Attribution is positive, and that is the whole safety argument.** A
 * resource is removed only because a row claims it — a retired environment
 * claims everything named from its id or labelled with it, and any
 * environment claims whatever a cleanup already wrote down as owed. Everything
 * else is left alone: a live environment's volume (the only copy of an agent's
 * work) and the stack it is running, the shared hash-named runtime and browser
 * volumes, the port helper every environment's published ports go through, a
 * second Domo install's resources on the same daemon, a name this does not
 * recognise. Sweeping by prefix instead would be one `docker volume ls` away
 * from destroying work nobody can get back.
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

const DIND_VOLUME = 'dind-var-lib-docker-'

/**
 * Every Docker resource an environment *is*, named from its id alone.
 *
 * The Docker-in-Docker volume is in here because the Feature declares it as
 * `dind-var-lib-docker-${devcontainerId}` and `container.ts` substitutes the
 * environment id — so it is as derivable as the rest, even though
 * `removeContainer` finds it by inspecting the container instead (which also
 * catches a Feature that names it something else). Only an environment created
 * before the host daemon, or one whose project lists the Feature itself, has
 * one.
 */
export function environmentResources(environmentId: string): Leftover[] {
  const prefix = resourcePrefix()
  return [
    { kind: 'container', name: `${prefix}${environmentId}`.toLowerCase(), environmentId },
    { kind: 'volume', name: workspaceVolumeName(environmentId), environmentId },
    { kind: 'volume', name: `${DIND_VOLUME}${environmentId}`, environmentId },
    { kind: 'image', name: `${prefix}${environmentId}`.toLowerCase(), environmentId }
  ]
}

/** One resource as Docker lists it, with whatever says which environment it belongs to. */
export interface ObservedResource {
  name: string
  /**
   * The environment a label or a name says it belongs to: `domo.envId` on the
   * environment's own container and workspace volume, `domo.env` on what it
   * made through its proxy, the id inside a `domo-<id>/…` image tag or a
   * `dind-var-lib-docker-<id>` volume.
   */
  owner?: string
  /** The environment's own container (`domo.envId`), as against something it made. */
  environment?: boolean
}

/** What Docker says it currently has, of the kinds an environment can own. A bare string is a name nothing labels. */
export interface ObservedResources {
  containers: Array<string | ObservedResource>
  networks?: Array<string | ObservedResource>
  volumes: Array<string | ObservedResource>
  images: Array<string | ObservedResource>
}

type Observed = ObservedResource & { kind: LeftoverKind }

const KIND_ORDER: LeftoverKind[] = ['container', 'network', 'volume', 'image']

/**
 * Flattened in removal order. The order is load-bearing: a container goes
 * before the networks it joined, the volumes it mounts and the image it was
 * made from, or each of those refuses while it is still there and one failed
 * cleanup becomes four.
 */
function flatten(present: ObservedResources): Observed[] {
  const lists: Record<LeftoverKind, Array<string | ObservedResource>> = {
    container: present.containers,
    network: present.networks ?? [],
    volume: present.volumes,
    image: present.images
  }
  return KIND_ORDER.flatMap(kind => lists[kind].map(entry =>
    typeof entry === 'string' ? { kind, name: entry } : { kind, ...entry }))
}

interface Claimant {
  id: string
  retiredAt: string | null
  leftovers: Array<Pick<EnvironmentLeftover, 'kind' | 'name'>>
}

/** Whether a row claims one observed resource: by a derived name or a label once retired, by name when it recorded it as owed. */
function claims(environment: Claimant, resource: Observed): boolean {
  if (environment.leftovers.some(owed => owed.kind === resource.kind && owed.name === resource.name)) return true
  if (!environment.retiredAt) return false
  if (resource.owner === environment.id) return true
  return environmentResources(environment.id)
    .some(derived => derived.kind === resource.kind && derived.name === resource.name)
}

/**
 * What an environment row claims *by name*: everything named from its id once
 * retired, plus whatever a past cleanup recorded as owed. What it made through
 * its proxy is claimed by label on top of this, which only an observation can
 * answer (`planLeftoverRemoval`).
 */
export function claimedResources(environment: Claimant): Leftover[] {
  const claimed = new Map<string, Leftover>()
  const add = (leftover: Leftover) => claimed.set(`${leftover.kind}:${leftover.name}`, leftover)
  if (environment.retiredAt) for (const resource of environmentResources(environment.id)) add(resource)
  for (const { kind, name } of environment.leftovers) add({ kind, name, environmentId: environment.id })
  return [...claimed.values()]
}

/**
 * The resources to remove: claimed by a row, and actually still there.
 *
 * Observation is what decides, never an exit code — `docker volume rm` fails
 * both for a volume something still has mounted and for a volume that was
 * never created, and only the first of those is a leftover.
 */
export function planLeftoverRemoval(input: {
  environments: Claimant[]
  present: ObservedResources
}): Leftover[] {
  const plan: Leftover[] = []
  for (const resource of flatten(input.present)) {
    const claimant = input.environments.find(environment => claims(environment, resource))
    if (claimant) plan.push({ kind: resource.kind, name: resource.name, environmentId: claimant.id })
  }
  return plan
}

/**
 * Everything an environment owns that Docker still has, whether or not a row
 * says so — for a caller that *is* the authority on the id: a live test that
 * made an environment of its own and has no database behind it.
 */
export function ownedResources(environmentId: string, present: ObservedResources): Leftover[] {
  return planLeftoverRemoval({
    environments: [{ id: environmentId, retiredAt: 'now', leftovers: [] }],
    present
  })
}

/**
 * Infrastructure that is nobody's environment and has its own lifecycle: the
 * shared runtime and browser volumes (named by a hash of what is pinned inside
 * them, collected by `collectRuntimeVolumes` / `collectBrowserVolumes`), and
 * the one port helper every environment's ports go through, with its image.
 */
function isShared(resource: Observed): boolean {
  const prefix = resourcePrefix()
  if (resource.kind === 'volume') {
    return resource.name.startsWith(`${prefix}runtime-`) || resource.name.startsWith(`${prefix}browser-`)
  }
  if (resource.kind === 'container') return resource.name === `${prefix}port-helper`
  if (resource.kind === 'image') {
    return resource.name === `${prefix}port-helper` || resource.name.startsWith(`${prefix}port-helper:`)
  }
  return false
}

/**
 * Present resources that no row accounts for at all — **reported, never
 * removed.**
 *
 * This is the case Domo cannot safely act on and must not pretend it can: a
 * second install on the same daemon, or a leftover whose row was pruned before
 * rows were kept for good. Removing one would mean assuming this database is
 * the only account of what is on this machine, and the cost of being wrong is
 * somebody else's checkout. Saying so is free — but only about what does look
 * like this install's:
 *
 * - a name under this install's prefix (`NUXT_DEV_ENV_RESOURCE_PREFIX`) that
 *   is not shared infrastructure and is not named from a row's id;
 * - something an environment made, or a Docker-in-Docker volume, whose
 *   environment no row knows **and whose environment container is gone**. A
 *   container that is still there says which install it belongs to by its own
 *   name: under this prefix it is reported itself, under another prefix it is
 *   another install's live environment, and neither it nor its stack is
 *   anything of this one's to mention.
 */
export function unattributedResources(input: {
  environments: Array<{ id: string }>
  present: ObservedResources
}): string[] {
  const prefix = resourcePrefix()
  const known = new Set(input.environments.map(environment => environment.id))
  const derived = new Set(input.environments.flatMap(
    environment => environmentResources(environment.id).map(resource => `${resource.kind} ${resource.name}`)
  ))
  const resources = flatten(input.present)
  const withContainer = new Set(resources
    .filter(resource => resource.kind === 'container' && resource.environment && resource.owner)
    .map(resource => resource.owner!))
  return resources.filter((resource) => {
    if (isShared(resource)) return false
    if (resource.owner && known.has(resource.owner)) return false
    if (derived.has(`${resource.kind} ${resource.name}`)) return false
    if (resource.name.startsWith(prefix)) return true
    return !!resource.owner && !resource.environment && !withContainer.has(resource.owner)
  }).map(resource => `${resource.kind} ${resource.name}`)
}

/** The argv that removes one. `--volumes` takes the anonymous volumes a container owns outright. */
export function removeArgs(leftover: Leftover): string[] {
  if (leftover.kind === 'container') return ['rm', '--force', '--volumes', leftover.name]
  if (leftover.kind === 'network') return ['network', 'rm', leftover.name]
  if (leftover.kind === 'volume') return ['volume', 'rm', leftover.name]
  return ['image', 'rm', leftover.name]
}

async function lines(args: string[]): Promise<string[]> {
  const { stdout } = await run('docker', args)
  return stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

const ENV_ID_LABEL = 'domo.envId'
/** `ENVIRONMENT_LABEL` in `dood/manager.ts`, spelled here so this file needs no proxy. */
const DOOD_LABEL = 'domo.env'

/** `name<TAB>domo.envId<TAB>domo.env`, as the `--format` below prints it. */
function labelled(line: string): ObservedResource {
  const [name = '', environmentId = '', madeBy = ''] = line.split('\t')
  if (environmentId) return { name, owner: environmentId, environment: true }
  if (madeBy) return { name, owner: madeBy }
  if (name.startsWith(DIND_VOLUME)) return { name, owner: name.slice(DIND_VOLUME.length) }
  return { name }
}

/**
 * An image as it is removed and listed back: `repo` for `:latest` (which is
 * how the environment image is named everywhere else), `repo:tag` otherwise,
 * and the environment a private tag names as its owner.
 */
function image(line: string): ObservedResource | null {
  const at = line.lastIndexOf(':')
  const repository = line.slice(0, at)
  const tag = line.slice(at + 1)
  if (!repository || repository === '<none>' || tag === '<none>') return null
  const name = tag === 'latest' ? repository : `${repository}:${tag}`
  const owner = parsePrivateName(name)?.environmentId
  return owner ? { name, owner } : { name }
}

/** Only what could be an environment's: prefixed, labelled, a DinD volume or a private tag. */
function relevant(resource: ObservedResource): boolean {
  return !!resource.owner || resource.name.startsWith(resourcePrefix())
}

/**
 * What Docker has, asked for rather than assumed.
 *
 * Deliberately **not** `allowFailure`: an unreachable daemon answers with an
 * empty stdout, and reading that as "nothing is there" would clear every
 * recorded leftover and call a cleanup that never ran a success. A throw is
 * what the caller needs, and it is the caller that decides what to say.
 *
 * Everything is listed and narrowed here rather than by `--filter`: filters on
 * different keys are ANDed, so "prefixed *or* labelled" would be four queries
 * per kind, and a private tag has no filter at all (`reference` globs one path
 * component, and `domo-<id>/docker.io/library/app` has three).
 */
export async function observeEnvironmentResources(): Promise<ObservedResources> {
  const labels = `{{.Label "${ENV_ID_LABEL}"}}\t{{.Label "${DOOD_LABEL}"}}`
  const [containers, networks, volumes, images] = await Promise.all([
    lines(['ps', '--all', '--format', `{{.Names}}\t${labels}`]),
    lines(['network', 'ls', '--filter', `label=${DOOD_LABEL}`, '--format', `{{.Name}}\t\t{{.Label "${DOOD_LABEL}"}}`]),
    lines(['volume', 'ls', '--format', `{{.Name}}\t${labels}`]),
    lines(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
  ])
  return {
    containers: containers.map(labelled).filter(relevant),
    networks: networks.map(labelled),
    volumes: volumes.map(labelled).filter(relevant),
    images: images.map(image).filter((entry): entry is ObservedResource => !!entry && relevant(entry))
  }
}

/**
 * What to ask Docker when it refuses, to find out *what* is in the way.
 *
 * Docker's own refusal is not actionable — "volume is in use" names nothing a
 * person can go and deal with, and the raw id in brackets is not a name either.
 * The filters below answer with the thing that actually has to go first: the
 * containers mounting a volume, attached to a network, or running an image.
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
  if (leftover.kind === 'network') {
    return ['ps', '--all', '--filter', `network=${leftover.name}`, '--format', '{{.Names}}']
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

const HOLDING: Record<Exclude<LeftoverKind, 'container'>, { one: string, many: string }> = {
  volume: { one: 'still has it mounted', many: 'still have it mounted' },
  network: { one: 'is still connected to it', many: 'are still connected to it' },
  image: { one: 'was made from it', many: 'were made from it' }
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
  const holding = input.leftover.kind === 'container' ? null : HOLDING[input.leftover.kind]
  if (holding && input.blockers.length === 1) {
    return `Container ${input.blockers[0]} ${holding.one}. `
      + `Remove it (docker rm -f ${input.blockers[0]}) and run the cleanup again.`
  }
  if (holding && input.blockers.length > 1) {
    return `${input.blockers.length} containers ${holding.many}: ${input.blockers.join(', ')}. `
      + `Remove them (docker rm -f ${input.blockers.join(' ')}) and run the cleanup again.`
  }
  if (input.leftover.kind === 'image' && /child image/i.test(bare)) {
    return 'Another image on this machine was built from it, and Docker will not remove an image that has one. '
      + `Find it (docker image ls --filter since=${input.leftover.name}), remove it, and run the cleanup again.`
  }
  return `Docker refused: ${bare}`
}

/**
 * What a half-cleaned environment says on its row, in one line.
 *
 * `last_error` is a single column and the page renders it as the reason, so the
 * per-resource sentences are folded into one rather than summarised away: the
 * whole value of them is the container name and the command, and a count would
 * throw both away.
 */
export function describeLeftovers(leftovers: EnvironmentLeftover[]): string {
  if (!leftovers.length) return ''
  if (leftovers.length === 1) {
    const [only] = leftovers as [EnvironmentLeftover]
    return `Docker still has ${only.kind} ${only.name}. ${only.error}`
  }
  return `Docker still has ${leftovers.length} of this environment's resources. `
    + leftovers.map(leftover => `${leftover.kind} ${leftover.name}: ${leftover.error}`).join(' ')
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
      const blockers = args ? await lines(args).catch(() => []) : []
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

/**
 * Remove everything one environment owns on the daemon, with no row to ask —
 * the live tests' way to take down an environment they made by hand. It is
 * the same observation, plan and removal the janitor runs, with the caller
 * standing in for the retired row.
 */
export async function removeEnvironmentResources(environmentId: string): Promise<RemovalOutcome> {
  return removeLeftovers(ownedResources(environmentId, await observeEnvironmentResources()))
}

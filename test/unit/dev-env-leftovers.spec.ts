import { describe, expect, it } from 'vitest'

import type { DevEnvironment, EnvironmentLeftover } from '~~/shared/types'
import {
  claimedResources,
  environmentResources,
  planLeftoverRemoval,
  removeArgs,
  workspaceVolumeName
} from '../../server/lib/dev-env/leftovers'

/**
 * Which Docker resources Domo is allowed to remove, and in what order.
 *
 * This is the half of the leftover sweep that can do real harm, so it is a pure
 * function and it is pinned here. A workspace volume is the *only* copy of an
 * agent's work: the rule is that a resource is removed because a row claims it
 * by name, never because its name looks like Domo's, and every test below is a
 * way of stating that.
 */

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'prj_1',
    name: 'api',
    containerName: 'domo-dev-env_1',
    containerId: 'container-sha',
    workspacePath: '/workspaces/api',
    configSource: 'default',
    configPath: null,
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    leftovers: [],
    ...overrides
  }
}

const RETIRED = environment({ retiredAt: '2026-01-02T00:00:00.000Z' })

/** Everything a retired `env_1` owns, as Docker would list it. */
const PRESENT = {
  containers: ['domo-dev-env_1'],
  volumes: ['domo-dev-env_1-workspace', 'dind-var-lib-docker-env_1'],
  images: ['domo-dev-env_1']
}

function planned(input: Parameters<typeof planLeftoverRemoval>[0]): string[] {
  return planLeftoverRemoval(input).map(leftover => `${leftover.kind} ${leftover.name}`)
}

describe('the names an environment owns', () => {
  it('derives all four from the id, so a failed cleanup is findable later', () => {
    expect(environmentResources('env_1').map(resource => `${resource.kind} ${resource.name}`)).toEqual([
      'container domo-dev-env_1',
      'volume domo-dev-env_1-workspace',
      'volume dind-var-lib-docker-env_1',
      'image domo-dev-env_1'
    ])
    expect(workspaceVolumeName('env_ABC')).toBe('domo-dev-env_abc-workspace')
  })

  it('claims nothing for a live environment, and everything for a retired one', () => {
    expect(claimedResources(environment())).toEqual([])
    expect(claimedResources(RETIRED)).toHaveLength(4)
  })

  it('claims what a past cleanup wrote down, retired or not', () => {
    const owed: EnvironmentLeftover[] = [
      { kind: 'volume', name: 'domo-dev-env_1-workspace', error: 'volume is in use' }
    ]
    // A creation that failed halfway leaves a row that is not retired and still
    // owns wreckage; the row is what says so.
    expect(claimedResources(environment({ leftovers: owed })))
      .toEqual([{ kind: 'volume', name: 'domo-dev-env_1-workspace', environmentId: 'env_1' }])
  })
})

describe('planning a removal', () => {
  it('takes what a retired row claims and Docker still has', () => {
    expect(planned({ environments: [RETIRED], present: PRESENT })).toEqual([
      'container domo-dev-env_1',
      'volume domo-dev-env_1-workspace',
      'volume dind-var-lib-docker-env_1',
      'image domo-dev-env_1'
    ])
  })

  it('removes the container before the volumes it mounts and the image it came from', () => {
    // Not cosmetic: both refuse while the container is still there, and one
    // failed cleanup would become three.
    const order = planned({ environments: [RETIRED], present: PRESENT })
    expect(order.indexOf('container domo-dev-env_1')).toBe(0)
    expect(order.indexOf('image domo-dev-env_1')).toBe(order.length - 1)
  })

  it('never touches a live environment, whose volume is the only copy of its work', () => {
    expect(planned({ environments: [environment()], present: PRESENT })).toEqual([])
  })

  it('leaves the shared runtime and browser volumes to their own collectors', () => {
    expect(planned({
      environments: [RETIRED],
      present: { containers: [], volumes: ['domo-dev-runtime-abc123', 'domo-dev-browser-def456'], images: [] }
    })).toEqual([])
  })

  it('leaves a name it cannot attribute to a row alone', () => {
    // Another Domo install on the same daemon, or an id whose row has been
    // purged. Ids are random, so positive attribution costs nothing and the
    // alternative is deleting somebody else's checkout.
    expect(planned({
      environments: [RETIRED],
      present: {
        containers: ['domo-dev-env_other'],
        volumes: ['domo-dev-env_other-workspace', 'dind-var-lib-docker-env_other', 'some-build-cache'],
        images: ['domo-dev-env_other']
      }
    })).toEqual([])
  })

  it('plans nothing for a resource Docker does not have', () => {
    // The normal case: retirement removed everything, and the sweep that
    // follows it has nothing to do.
    expect(planned({
      environments: [RETIRED],
      present: { containers: [], volumes: [], images: [] }
    })).toEqual([])
  })
})

describe('the argv', () => {
  it('names one resource per call, and takes a container with its anonymous volumes', () => {
    expect(removeArgs({ kind: 'container', name: 'domo-dev-env_1', environmentId: 'env_1' }))
      .toEqual(['rm', '--force', '--volumes', 'domo-dev-env_1'])
    expect(removeArgs({ kind: 'volume', name: 'domo-dev-env_1-workspace', environmentId: 'env_1' }))
      .toEqual(['volume', 'rm', 'domo-dev-env_1-workspace'])
    expect(removeArgs({ kind: 'image', name: 'domo-dev-env_1', environmentId: 'env_1' }))
      .toEqual(['image', 'rm', 'domo-dev-env_1'])
  })
})

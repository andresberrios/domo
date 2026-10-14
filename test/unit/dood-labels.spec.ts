import { describe, expect, it } from 'vitest'

import { clientLabelKey, clientLabels, escapeLabelFilter, escapeLabels } from '../../server/lib/dood/labels'

/**
 * A Domo developing Domo, in an environment, keeps its bookkeeping in the same
 * `domo.*` labels as the proxy it talks through. Each level has to see exactly
 * its own.
 */
describe('the domo.* label namespace, per level', () => {
  it('stores a client\'s domo labels escaped and leaves the rest alone', () => {
    expect(escapeLabels({ 'domo.env': 'env_inner', 'domo.envId': 'env_x', 'app': 'web' }))
      .toEqual({ 'domo.nested.env': 'env_inner', 'domo.nested.envId': 'env_x', 'app': 'web' })
    expect(escapeLabels(undefined)).toBeUndefined()
  })

  it('hands them back as written, and never the proxy\'s own', () => {
    const stored = { ...escapeLabels({ 'domo.env': 'env_inner', 'app': 'web' }), 'domo.env': 'env_outer', 'domo.ports': '[]' }
    expect(clientLabels(stored)).toEqual({ 'domo.env': 'env_inner', 'app': 'web' })
    expect(clientLabelKey('domo.env')).toBeNull()
  })

  it('works at any depth: each level escapes once more', () => {
    const third = { 'domo.env': 'env_3' }
    const second = { ...escapeLabels(third), 'domo.env': 'env_2' }
    const first = { ...escapeLabels(second), 'domo.env': 'env_1' }
    expect(first).toEqual({ 'domo.nested.nested.env': 'env_3', 'domo.nested.env': 'env_2', 'domo.env': 'env_1' })
    expect(clientLabels(clientLabels(first))).toEqual(third)
  })

  it('escapes a label filter, with or without a value', () => {
    expect(escapeLabelFilter('domo.env=env_inner')).toBe('domo.nested.env=env_inner')
    expect(escapeLabelFilter('domo.dood')).toBe('domo.nested.dood')
    expect(escapeLabelFilter('com.docker.compose.project=s')).toBe('com.docker.compose.project=s')
  })
})

/**
 * Compose finds a stack by its project label, so the value is namespaced like
 * a name. Otherwise the host's `docker compose up` treats every environment's
 * stack of the same name as its own, and stops them as surplus replicas.
 */
describe('the compose project label, per environment', () => {
  it('stores the project with the prefix and hands it back without', () => {
    const stored = escapeLabels({ 'com.docker.compose.project': 'stack', 'com.docker.compose.service': 'db' }, 'env_1-')
    expect(stored).toEqual({ 'com.docker.compose.project': 'env_1-stack', 'com.docker.compose.service': 'db' })
    expect(clientLabels({ ...stored, 'domo.env': 'env_1' }, 'env_1-')).toEqual({ 'com.docker.compose.project': 'stack', 'com.docker.compose.service': 'db' })
  })

  it('matches the filter compose asks with, and leaves a key-only filter alone', () => {
    expect(escapeLabelFilter('com.docker.compose.project=stack', 'env_1-')).toBe('com.docker.compose.project=env_1-stack')
    expect(escapeLabelFilter('com.docker.compose.project', 'env_1-')).toBe('com.docker.compose.project')
    expect(escapeLabelFilter('com.docker.compose.service=db', 'env_1-')).toBe('com.docker.compose.service=db')
  })

  it('shows the host its own projects as they are', () => {
    expect(clientLabels({ 'com.docker.compose.project': 'domo' }, 'env_1-')).toEqual({ 'com.docker.compose.project': 'domo' })
  })

  it('works at any depth: each level adds and removes its own prefix', () => {
    const inner = escapeLabels({ 'com.docker.compose.project': 'stack' }, 'env_in-')
    const outer = escapeLabels(inner, 'env_out-')
    expect(outer).toEqual({ 'com.docker.compose.project': 'env_out-env_in-stack' })
    expect(clientLabels(clientLabels(outer, 'env_out-'), 'env_in-')).toEqual({ 'com.docker.compose.project': 'stack' })
  })
})

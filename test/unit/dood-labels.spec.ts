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

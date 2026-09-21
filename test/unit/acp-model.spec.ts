import { afterEach, describe, expect, it } from 'vitest'

import {
  availableModelIds,
  currentModel,
  modelConfigOption,
  pinnedModel,
  resolveModel
} from '../../server/lib/acp/model'

/**
 * The model pin, at the one boundary that can be tested without an account: what
 * Domo makes of the `configOptions` an adapter answers `session/new` with.
 *
 * Both installed adapters surface the model as an ACP select in the category
 * `model` and take `session/set_config_option`, which is why there is one
 * resolver and not one mechanism per adapter.
 */

const claudeOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'claude-haiku-4-5', name: 'Haiku 4.5' },
    { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }
  ]
}

/** Some agents group their options; the select is the same shape either way. */
const groupedOption = {
  id: 'model',
  category: 'model',
  type: 'select',
  currentValue: 'gpt-5-codex',
  options: [
    { name: 'Fast', options: [{ value: 'gpt-5-mini', name: 'GPT-5 mini' }] },
    { name: 'Capable', options: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }] }
  ]
}

afterEach(() => {
  delete process.env.NUXT_CLAUDE_MODEL
  delete process.env.NUXT_CODEX_MODEL
})

describe('pinnedModel', () => {
  it('reads the adapter\'s own variable, and treats blank as unset', () => {
    process.env.NUXT_CLAUDE_MODEL = ' claude-haiku-4-5 '
    process.env.NUXT_CODEX_MODEL = '   '

    expect(pinnedModel('claude-code')).toBe('claude-haiku-4-5')
    expect(pinnedModel('codex')).toBeNull()
  })

  it('is null when nothing is pinned', () => {
    expect(pinnedModel('claude-code')).toBeNull()
  })
})

describe('modelConfigOption', () => {
  it('finds the select by category, not by position', () => {
    const response = {
      configOptions: [
        { id: 'mode', category: 'mode', type: 'select', options: [] },
        claudeOption,
        { id: 'thinking', category: 'thought_level', type: 'select', options: [] }
      ]
    }

    expect(modelConfigOption(response)).toBe(claudeOption)
  })

  it('falls back to the id when an adapter sends no category', () => {
    const bare = { id: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a' }] }

    expect(modelConfigOption({ configOptions: [bare] })).toBe(bare)
  })

  it('is null for an adapter that offers no model selector at all', () => {
    expect(modelConfigOption({ configOptions: [{ id: 'mode', category: 'mode', type: 'select' }] })).toBeNull()
    expect(modelConfigOption({})).toBeNull()
    expect(modelConfigOption(null)).toBeNull()
  })
})

describe('resolveModel', () => {
  it('matches an exact id', () => {
    expect(resolveModel(claudeOption, 'claude-haiku-4-5'))
      .toEqual({ configId: 'model', value: 'claude-haiku-4-5', name: 'Haiku 4.5' })
  })

  it('matches case-insensitively and by display name', () => {
    expect(resolveModel(claudeOption, 'CLAUDE-HAIKU-4-5')?.value).toBe('claude-haiku-4-5')
    expect(resolveModel(claudeOption, 'haiku 4.5')?.value).toBe('claude-haiku-4-5')
  })

  it('matches a shorthand the operator is likely to write', () => {
    expect(resolveModel(claudeOption, 'haiku')?.value).toBe('claude-haiku-4-5')
  })

  it('reaches into grouped options', () => {
    expect(resolveModel(groupedOption, 'gpt-5-mini'))
      .toEqual({ configId: 'model', value: 'gpt-5-mini', name: 'GPT-5 mini' })
  })

  it('is null rather than a guess when nothing matches', () => {
    // Silently running on a model nobody asked for is worse than not pinning.
    expect(resolveModel(claudeOption, 'gemini-3-pro')).toBeNull()
    expect(resolveModel({ id: 'model', options: [] }, 'haiku')).toBeNull()
  })
})

describe('currentModel', () => {
  it('reports what the adapter says the session is on, with its label', () => {
    expect(currentModel({ ...claudeOption, currentValue: 'claude-sonnet-4-5' }))
      .toEqual({ configId: 'model', value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' })
  })

  it('falls back to the raw id for a value that is not in the list', () => {
    expect(currentModel({ ...claudeOption, currentValue: 'something-else' }))
      .toEqual({ configId: 'model', value: 'something-else', name: 'something-else' })
  })

  it('is null when the adapter reports no current value', () => {
    expect(currentModel({ ...claudeOption, currentValue: undefined })).toBeNull()
  })
})

describe('availableModelIds', () => {
  it('lists every id, flattening groups, so an error can name them', () => {
    expect(availableModelIds(claudeOption)).toEqual(['default', 'claude-haiku-4-5', 'claude-sonnet-4-5'])
    expect(availableModelIds(groupedOption)).toEqual(['gpt-5-mini', 'gpt-5-codex'])
  })
})

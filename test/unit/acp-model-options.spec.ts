import { describe, expect, it } from 'vitest'

import { availableModelOptions, currentModel, modelConfigOption } from '../../server/lib/acp/model'

/**
 * What the models endpoint makes of a `session/new` response. The spawn itself
 * needs a real account and belongs to `test/server/adapter-models.spec.ts` (with
 * the adapter faked) and the live layer; this is the parsing.
 */

/** Shaped the way claude-agent-acp 0.78.0 really answers. */
const claudeResponse = {
  sessionId: 'acp_1',
  configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }] },
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'default', name: 'Default (recommended)' },
        { value: 'sonnet', name: 'Sonnet 5' },
        { value: 'haiku', name: 'Haiku 4.5' }
      ]
    },
    { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [] }
  ]
}

describe('reading an adapter\'s model list', () => {
  it('takes the model selector and nothing else', () => {
    const option = modelConfigOption(claudeResponse)

    expect(availableModelOptions(option)).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'sonnet', name: 'Sonnet 5' },
      { id: 'haiku', name: 'Haiku 4.5' }
    ])
    expect(currentModel(option)?.value).toBe('sonnet')
  })

  it('flattens grouped options, which is the other shape the schema allows', () => {
    const grouped = {
      configOptions: [{
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-5.6-terra',
        options: [
          { name: 'Fast', options: [{ value: 'gpt-5.6-luna', name: '5.6 Luna' }] },
          { name: 'Capable', options: [{ value: 'gpt-5.6-terra', name: '5.6 Terra' }] }
        ]
      }]
    }

    expect(availableModelOptions(modelConfigOption(grouped))).toEqual([
      { id: 'gpt-5.6-luna', name: '5.6 Luna' },
      { id: 'gpt-5.6-terra', name: '5.6 Terra' }
    ])
  })

  it('falls back to the id when an option carries no label', () => {
    const bare = { configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'x' }] }] }

    expect(availableModelOptions(modelConfigOption(bare))).toEqual([{ id: 'x', name: 'x' }])
  })

  it('is an empty list, not a crash, for an adapter that offers no choice', () => {
    expect(availableModelOptions(modelConfigOption({ sessionId: 'acp_1' }))).toEqual([])
    expect(currentModel(modelConfigOption({ sessionId: 'acp_1' }))).toBeNull()
  })
})

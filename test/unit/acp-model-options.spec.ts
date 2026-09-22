import { describe, expect, it } from 'vitest'

import { availableModelOptions, currentModel, modelConfigOption } from '../../server/lib/acp/model'
import { availableModes, currentModeId } from '../../server/lib/acp/mode'

/**
 * What the models endpoint makes of a `session/new` response — the model
 * selector out of `configOptions`, plus modes from either ACP representation. The
 * spawn itself needs a real account and belongs to
 * `test/server/adapter-models.spec.ts` (with the adapter faked) and the live
 * layer; this is the parsing.
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

/**
 * The mode ids both installed adapters really answer with, read out of their
 * own sources (`@agentclientprotocol/claude-agent-acp`'s `SessionModeManager`
 * and `codex-acp`'s `AgentMode`). They share **no id at all**, which is why the
 * Settings page cannot hold one hard-coded list and why the default is per
 * adapter.
 */
const claudeModes = {
  sessionId: 'acp_1',
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
      { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
      { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
      { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
      { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' }
    ]
  }
}

const codexModes = {
  sessionId: 'acp_1',
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'read-only', name: 'Ask for approval', description: 'Always ask to edit external files' },
      { id: 'agent', name: 'Approve for me', description: 'Only ask for actions detected as unsafe' },
      { id: 'agent-full-access', name: 'Full access', description: 'Unrestricted access' }
    ]
  }
}

/** Shaped the way OpenCode 1.18.28 answers: no top-level `modes` object. */
const openCodeModes = {
  sessionId: 'acp_1',
  configOptions: [{
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'build',
    options: [
      { value: 'build', name: 'Build', description: 'The default agent with all tools enabled' },
      { value: 'plan', name: 'Plan', description: 'A restricted agent for planning' }
    ]
  }]
}

describe('reading an adapter\'s permission modes', () => {
  it('takes the ACP `modes` object, ids and labels and all', () => {
    expect(availableModes(claudeModes).map(mode => mode.id)).toEqual([
      'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'
    ])
    expect(availableModes(claudeModes)[0]).toEqual({
      id: 'default',
      name: 'Manual',
      description: 'Always ask before making changes'
    })
    expect(currentModeId(claudeModes)).toBe('default')
  })

  it('reads the other adapter\'s entirely different ids', () => {
    expect(availableModes(codexModes).map(mode => mode.id)).toEqual([
      'read-only', 'agent', 'agent-full-access'
    ])
    expect(currentModeId(codexModes)).toBe('agent')
  })

  it('reads OpenCode modes from its config option representation', () => {
    expect(availableModes(openCodeModes)).toEqual([
      { id: 'build', name: 'Build', description: 'The default agent with all tools enabled' },
      { id: 'plan', name: 'Plan', description: 'A restricted agent for planning' }
    ])
    expect(currentModeId(openCodeModes)).toBe('build')
  })

  it('shares no mode id between the two adapters, which is the whole point', () => {
    const claude = new Set(availableModes(claudeModes).map(mode => mode.id))
    const codex = availableModes(codexModes).map(mode => mode.id)

    expect(codex.filter(id => claude.has(id))).toEqual([])
  })

  it('falls back to the id when a mode carries no label, and nulls a missing description', () => {
    const bare = { modes: { currentModeId: 'x', availableModes: [{ id: 'x' }] } }

    expect(availableModes(bare)).toEqual([{ id: 'x', name: 'x', description: null }])
  })

  it('is an empty list, not a crash, for an adapter that reports no modes', () => {
    expect(availableModes({ sessionId: 'acp_1' })).toEqual([])
    expect(currentModeId({ sessionId: 'acp_1' })).toBeNull()
    expect(availableModes(undefined)).toEqual([])
  })

  it('drops an entry with no usable id, which Reka\'s select would throw on', () => {
    const broken = { modes: { currentModeId: '', availableModes: [{ id: '' }, { id: 'plan' }, null] } }

    expect(availableModes(broken).map(mode => mode.id)).toEqual(['plan'])
    expect(currentModeId(broken)).toBeNull()
  })
})

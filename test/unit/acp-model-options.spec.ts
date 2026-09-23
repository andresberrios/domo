import { describe, expect, it } from 'vitest'

import {
  ambiguousModelMatches,
  availableModelOptions,
  currentModel,
  modelConfigOption,
  resolveModel
} from '../../server/lib/acp/model'
import { availableModes, currentModeId } from '../../server/lib/acp/mode'

/**
 * What the models endpoint makes of a `session/new` response — the model
 * selector out of `configOptions`, plus modes from either ACP representation. The
 * spawn itself needs a real account and belongs to
 * `test/server/adapter-models.spec.ts` (with the adapter faked) and the live
 * layer; this is the parsing.
 */

/**
 * Shaped the way claude-agent-acp 0.81.1 really answers, read off a live
 * `session/new`. The bracketed 1M-context ids are the point: there is no bare
 * `opus`, so every row that stored one resolves by containment rather than
 * exactly — see the test that pins it below.
 */
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
        { value: 'opus[1m]', name: 'Opus 5.5' },
        { value: 'claude-fable-5-1[1m]', name: 'Fable 5.1' },
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
      { id: 'opus[1m]', name: 'Opus 5.5' },
      { id: 'claude-fable-5-1[1m]', name: 'Fable 5.1' },
      { id: 'sonnet', name: 'Sonnet 5' },
      { id: 'haiku', name: 'Haiku 4.5' }
    ])
    expect(currentModel(option)?.value).toBe('sonnet')
  })

  it('resolves a stored bare `opus` onto the 1M-context id', () => {
    // Every session created before the bracketed ids appeared holds `opus`, and
    // the adapter offers no such value: containment is the only thing that
    // keeps those rows startable, and it must stay unambiguous.
    const option = modelConfigOption(claudeResponse)

    expect(resolveModel(option, 'opus')?.value).toBe('opus[1m]')
    // One entry means it resolved; more than one would be the refusal.
    expect(ambiguousModelMatches(option, 'opus')).toEqual(['opus[1m]'])
    expect(resolveModel(option, 'fable')?.value).toBe('claude-fable-5-1[1m]')
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

/** Shaped the way OpenCode 2.0.14 answers: no top-level `modes` object. */
const openCodeModes = {
  sessionId: 'acp_1',
  configOptions: [{
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'build',
    options: [
      { value: 'build', name: 'Build', description: 'The default agent. Executes tools based on configured permissions.' },
      { value: 'plan', name: 'Plan', description: 'Read-only agent for exploring the codebase and planning work before implementation.' }
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
      { id: 'build', name: 'Build', description: 'The default agent. Executes tools based on configured permissions.' },
      { id: 'plan', name: 'Plan', description: 'Read-only agent for exploring the codebase and planning work before implementation.' }
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

/**
 * What OpenCode 2 really offers once it is authenticated, cut down from a
 * measured `session/new`: **130 models across two providers at once**, and the
 * two are separate billing relationships. `openai/*` (55) comes from the
 * developer's own ChatGPT login; `opencode/*` (75) is OpenCode console
 * inference, metered per token. 18 bare names appear in both.
 *
 * `opencode-go/*` — the flat subscription — was advertised by the console's own
 * config and listed by the adapter **zero** times, so nothing may assume it is
 * selectable.
 */
const twoProviders = {
  id: 'model',
  options: [
    { value: 'openai/gpt-5.4', name: 'openai/GPT-5.4' },
    { value: 'openai/gpt-5.3-codex', name: 'openai/GPT-5.3 Codex' },
    { value: 'opencode/gpt-5.4', name: 'opencode/GPT-5.4' },
    { value: 'opencode/gpt-5.3-codex', name: 'opencode/GPT-5.3 Codex' },
    { value: 'opencode/claude-opus-5-5', name: 'opencode/Claude Opus 5.5' }
  ]
}

describe('a model preference that could mean two different bills', () => {
  it('refuses a bare name both providers offer, rather than taking the first', () => {
    // `.find()` used to answer whichever came first. On the account this was
    // measured against that is a real choice between billing the developer's
    // own OpenAI relationship and billing OpenCode console inference.
    expect(resolveModel(twoProviders, 'gpt-5.4')).toBeNull()
    expect(ambiguousModelMatches(twoProviders, 'gpt-5.4'))
      .toEqual(['openai/gpt-5.4', 'opencode/gpt-5.4'])
    expect(resolveModel(twoProviders, 'gpt-5.3-codex')).toBeNull()
  })

  it('takes an exact id, which is the way to say which one you meant', () => {
    expect(resolveModel(twoProviders, 'opencode/gpt-5.4')?.value).toBe('opencode/gpt-5.4')
    expect(resolveModel(twoProviders, 'openai/gpt-5.4')?.value).toBe('openai/gpt-5.4')
    // And an exact id is never reported as ambiguous, even though the same
    // string is contained in nothing else.
    expect(ambiguousModelMatches(twoProviders, 'opencode/gpt-5.4')).toEqual([])
  })

  it('still resolves a name only one provider has', () => {
    expect(resolveModel(twoProviders, 'claude-opus-5-5')?.value).toBe('opencode/claude-opus-5-5')
  })

  it('tells a missing model from an ambiguous one', () => {
    // Empty means "nothing matched", which is the other error message.
    expect(ambiguousModelMatches(twoProviders, 'haiku')).toEqual([])
  })
})

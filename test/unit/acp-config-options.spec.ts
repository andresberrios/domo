import { describe, expect, it } from 'vitest'

import {
  adapterConfigOptions,
  configValueIds,
  findConfigOption,
  resolveConfigValue,
  sameConfigOptions
} from '../../server/lib/acp/config-options'

/**
 * These payloads are the ones the installed adapters actually build, read out
 * of their shipped bundles rather than invented:
 * `buildEffortConfigOption` in claude-agent-acp's `session-effort.js` and
 * `createReasoningEffortConfigOption` in codex-acp's `index.js`. The point of
 * the pair is that they agree on nothing except the category — which is
 * exactly why Domo renders the list instead of knowing any of it by name.
 */
const CLAUDE_EFFORT = {
  id: 'effort',
  name: 'Effort',
  description: 'Available effort levels for this model',
  category: 'thought_level',
  type: 'select',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' }
  ]
}

const CODEX_EFFORT = {
  id: 'reasoning_effort',
  name: 'Reasoning effort',
  description: 'How much reasoning effort the model should use',
  category: 'thought_level',
  type: 'select',
  currentValue: 'medium',
  options: [
    { value: 'low', name: 'Low', description: null },
    { value: 'medium', name: 'Medium', description: null },
    { value: 'high', name: 'High', description: null }
  ]
}

const MODEL = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'sonnet',
  options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
}

const MODE = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Manual' }]
}

describe('adapterConfigOptions', () => {
  it('keeps the adapter’s own settings and drops the two Domo already owns', () => {
    const options = adapterConfigOptions({ configOptions: [MODE, MODEL, CLAUDE_EFFORT] })

    expect(options.map(option => option.id)).toEqual(['effort'])
    expect(options[0]).toMatchObject({
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'default'
    })
    expect(configValueIds(options[0]!)).toEqual(['default', 'low', 'medium', 'high'])
  })

  it('reads both adapters, which share no id and no option list', () => {
    const claude = adapterConfigOptions({ configOptions: [CLAUDE_EFFORT] })[0]!
    const codex = adapterConfigOptions({ configOptions: [CODEX_EFFORT] })[0]!

    expect(claude.id).toBe('effort')
    expect(codex.id).toBe('reasoning_effort')
    expect(claude.category).toBe(codex.category)
    // Claude's carries a "leave it alone" sentinel; Codex's does not.
    expect(configValueIds(claude)).toContain('default')
    expect(configValueIds(codex)).not.toContain('default')
  })

  it('ignores an option that is not a select, and one with nothing to pick', () => {
    const options = adapterConfigOptions({
      configOptions: [
        { id: 'fast_mode', name: 'Fast mode', type: 'boolean', currentValue: true },
        { id: 'empty', name: 'Empty', type: 'select', currentValue: null, options: [] },
        CLAUDE_EFFORT
      ]
    })
    expect(options.map(option => option.id)).toEqual(['effort'])
  })

  it('answers with nothing for a response that has no options at all', () => {
    // Claude Code publishes no effort option on a model without effort levels.
    expect(adapterConfigOptions({ configOptions: [MODE, MODEL] })).toEqual([])
    expect(adapterConfigOptions({})).toEqual([])
    expect(adapterConfigOptions(null)).toEqual([])
  })
})

describe('findConfigOption', () => {
  const claude = adapterConfigOptions({ configOptions: [CLAUDE_EFFORT] })
  const codex = adapterConfigOptions({ configOptions: [CODEX_EFFORT] })

  it('finds the same setting on both adapters from one spoken name', () => {
    // The whole point: a voice command must not have to know which adapter it
    // is talking to, and the two do not share the id.
    expect(findConfigOption(claude, 'reasoning effort')?.id).toBe('effort')
    expect(findConfigOption(codex, 'reasoning effort')?.id).toBe('reasoning_effort')
    expect(findConfigOption(claude, 'effort')?.id).toBe('effort')
    expect(findConfigOption(codex, 'effort')?.id).toBe('reasoning_effort')
  })

  it('falls back to ACP’s own category', () => {
    expect(findConfigOption(codex, 'thought_level')?.id).toBe('reasoning_effort')
  })

  it('refuses a setting that is not there rather than guessing', () => {
    expect(findConfigOption(claude, 'temperature')).toBeNull()
    expect(findConfigOption(null, 'effort')).toBeNull()
    expect(findConfigOption(claude, '')).toBeNull()
  })
})

describe('resolveConfigValue', () => {
  const effort = adapterConfigOptions({ configOptions: [CODEX_EFFORT] })[0]!

  it('takes an id or the name it is displayed under', () => {
    expect(resolveConfigValue(effort, 'high')).toBe('high')
    expect(resolveConfigValue(effort, 'High')).toBe('high')
  })

  it('answers null for a value the option does not offer', () => {
    // Claude has a `default` level and Codex does not, so this is the real case
    // of a saved preference meeting the other adapter.
    expect(resolveConfigValue(effort, 'default')).toBeNull()
    expect(resolveConfigValue(effort, 'maximum')).toBeNull()
  })
})

describe('sameConfigOptions', () => {
  it('is how an unchanged list avoids rewriting a synced row', () => {
    const a = adapterConfigOptions({ configOptions: [CLAUDE_EFFORT] })
    const b = adapterConfigOptions({ configOptions: [CLAUDE_EFFORT] })
    expect(sameConfigOptions(a, b)).toBe(true)
    expect(sameConfigOptions(a, adapterConfigOptions({ configOptions: [CODEX_EFFORT] }))).toBe(false)
    expect(sameConfigOptions(null, null)).toBe(true)
    expect(sameConfigOptions(a, null)).toBe(false)
  })
})

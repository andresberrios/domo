import { describe, expect, it } from 'vitest'

import { sessionConfigContent, withPermission } from '../../server/lib/acp/opencode-config'

describe('the OpenCode config a session starts with', () => {
  it('gives a container session a permission policy, because there is no mode for one', () => {
    // OpenCode's only modes are `build` and `plan`, and neither is a policy —
    // Build defers to exactly this block.
    expect(JSON.parse(sessionConfigContent(null, true)!)).toEqual({ permission: 'allow' })
  })

  it('leaves a host session alone', () => {
    // The host checkout is the developer's real tree with no container around
    // it, so turning off every prompt there is not a default to inherit.
    expect(sessionConfigContent(null, false)).toBeNull()
    expect(sessionConfigContent('{"agent":{}}', false)).toBe('{"agent":{}}')
  })

  it('keeps the developer\'s own config, comments and all', () => {
    const config = '{\n  // my agents\n  "agent": { "build": {} }\n}'
    const merged = withPermission(config)

    expect(merged).toContain('// my agents')
    expect(JSON.parse(merged.replace(/\/\/.*$/gm, ''))).toEqual({
      agent: { build: {} },
      permission: 'allow'
    })
  })

  it('never overrides a permission block the developer wrote', () => {
    // Somebody who deliberately denied `bash` must keep it. Both forms: the
    // bare action the loader expands to `{"*": action}`, and the granular map.
    const granular = '{"permission":{"bash":"deny","edit":"allow"}}'
    expect(withPermission(granular)).toBe(granular)
    expect(withPermission('{"permission":"ask"}')).toBe('{"permission":"ask"}')
  })

  it('hands an unparseable config over untouched rather than replacing it', () => {
    // OpenCode should complain about the developer's own file in its own words.
    expect(withPermission('{ not json at all')).toBe('{ not json at all')
    expect(withPermission('["an array"]')).toBe('["an array"]')
  })
})

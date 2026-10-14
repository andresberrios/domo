import { describe, expect, it } from 'vitest'

import { permissionFor, sessionConfigContent, withPermission } from '../../server/lib/acp/opencode-config'

/** What a fresh install has: environments permissive, the host as OpenCode has it. */
const DEFAULTS = { host: 'ask', environment: 'allow' } as const

describe('the OpenCode config a session starts with', () => {
  it('gives an environment session a permission policy, because there is no mode for one', () => {
    // OpenCode's only modes are `build` and `plan`, and neither is a policy —
    // Build defers to exactly this block.
    expect(JSON.parse(sessionConfigContent(null, true, DEFAULTS)!)).toEqual({ permission: 'allow' })
  })

  it('spells `ask` out, because OpenCode 2.0.29 no longer asks about other directories unaided', () => {
    expect(JSON.parse(sessionConfigContent(null, false, DEFAULTS)!))
      .toEqual({ permission: { external_directory: 'ask' } })
    expect(JSON.parse(sessionConfigContent('{"agent":{}}', false, DEFAULTS)!))
      .toEqual({ agent: {}, permission: { external_directory: 'ask' } })
  })

  it('lets the user choose per surface, and they are independent', () => {
    expect(permissionFor(DEFAULTS, true)).toBe('allow')
    expect(permissionFor(DEFAULTS, false)).toBe('ask')
    // Somebody tired of being asked on their own machine:
    expect(permissionFor({ host: 'allow', environment: 'allow' }, false)).toBe('allow')
    // And somebody who wants the prompts back in environments:
    expect(JSON.parse(sessionConfigContent(null, true, { host: 'ask', environment: 'ask' })!))
      .toEqual({ permission: { external_directory: 'ask' } })
  })

  it('keeps the developer\'s own config, comments and all', () => {
    const config = '{\n  // my agents\n  "agent": { "build": {} }\n}'
    const merged = withPermission(config, 'allow')

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
    expect(withPermission(granular, 'allow')).toBe(granular)
    expect(withPermission('{"permission":"ask"}', 'allow')).toBe('{"permission":"ask"}')
  })

  it('hands an unparseable config over untouched rather than replacing it', () => {
    // OpenCode should complain about the developer's own file in its own words.
    expect(withPermission('{ not json at all', 'allow')).toBe('{ not json at all')
    expect(withPermission('["an array"]', 'allow')).toBe('["an array"]')
  })
})

import { describe, expect, it } from 'vitest'

import { agentName, hostName, isNamespaced, nameFilter, namespaceFor, stripNames } from '../../server/lib/dood/names'
import { classifyRequest, parseFilters, renderFilters, replacementFor, resolveReference, scopeFilters } from '../../server/lib/dood/scope'

const ns = namespaceFor('env_0123456789abcdef0123')

describe('names', () => {
  it('prefixes a chosen name and strips it back, slash or not', () => {
    expect(hostName(ns, 'web')).toBe('env_0123456789abcdef0123-web')
    expect(hostName(ns, '/web')).toBe('/env_0123456789abcdef0123-web')
    expect(agentName(ns, '/env_0123456789abcdef0123-web')).toBe('/web')
    expect(agentName(ns, 'env_0123456789abcdef0123-web')).toBe('web')
  })

  it('leaves a random name, and another environment\'s, alone', () => {
    expect(agentName(ns, '/bold_gauss')).toBe('/bold_gauss')
    expect(agentName(ns, 'env_ffffffffffffffffffff-web')).toBe('env_ffffffffffffffffffff-web')
    expect(isNamespaced(ns, 'bold_gauss')).toBe(false)
    expect(isNamespaced(ns, '/env_0123456789abcdef0123-web')).toBe(true)
  })

  it('fits Docker\'s container and volume name rule', () => {
    expect(hostName(ns, 'stack-web-1')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/)
  })

  it('strips the prefix out of free text at name boundaries only', () => {
    const message = 'Conflict. The container name "/env_0123456789abcdef0123-web" is already in use'
    expect(stripNames(ns, message)).toBe('Conflict. The container name "/web" is already in use')
    expect(stripNames(ns, 'get env_0123456789abcdef0123-data: no such volume')).toBe('get data: no such volume')
    expect(stripNames(ns, '/env_0123456789abcdef0123-db:/env_0123456789abcdef0123-web/db')).toBe('/db:/web/db')
    // The environment's own workspace volume is Domo's name, not the agent's.
    expect(stripNames(ns, 'domo-dev-env_0123456789abcdef0123-workspace')).toBe('domo-dev-env_0123456789abcdef0123-workspace')
  })

  it('splices the prefix into anchored name filters only', () => {
    expect(nameFilter(ns, 'web', true)).toBe('web')
    expect(nameFilter(ns, '^web$', true)).toBe('^/?(?:env_0123456789abcdef0123-)?web$')
    expect(nameFilter(ns, '^/web$', true)).toBe('^/(?:env_0123456789abcdef0123-)?web$')
    expect(nameFilter(ns, '^data', false)).toBe('^(?:env_0123456789abcdef0123-)?data')
    // The pattern really matches both a prefixed and a random name, as Go's RE2 would.
    const pattern = new RegExp(nameFilter(ns, '^web$', true))
    expect(pattern.test('/env_0123456789abcdef0123-web')).toBe(true)
    expect(pattern.test('env_0123456789abcdef0123-web')).toBe(true)
    expect(pattern.test('/env_ffffffffffffffffffff-web')).toBe(false)
  })
})

const candidates = [
  { id: 'aaaa1111'.padEnd(64, '0'), name: `${ns.prefix}web` },
  { id: 'aaaa2222'.padEnd(64, '0'), name: `${ns.prefix}db` },
  { id: 'bbbb'.padEnd(64, '0'), name: 'bold_gauss' },
  // The environment's own container: resolvable, never namespaced.
  { id: 'cccc'.padEnd(64, '0'), name: 'domo-dev-env_0123456789abcdef0123' }
]

describe('resolveReference', () => {
  it('finds by full id, then name, then unique prefix', () => {
    expect(resolveReference(candidates[0]!.id, candidates, ns)).toMatchObject({ found: candidates[0], by: 'id' })
    expect(resolveReference('web', candidates, ns)).toMatchObject({ found: candidates[0], by: 'name' })
    expect(resolveReference('/db', candidates, ns)).toMatchObject({ found: candidates[1], by: 'name' })
    expect(resolveReference('bold_gauss', candidates, ns)).toMatchObject({ found: candidates[2], by: 'name' })
    expect(resolveReference('cccc', candidates, ns)).toMatchObject({ found: candidates[3], by: 'prefix' })
  })

  it('reports an ambiguous prefix rather than picking one', () => {
    expect(resolveReference('aaaa', candidates, ns)).toEqual({ found: null, ambiguous: true })
  })

  it('does not find the host name itself, or anything outside the candidates', () => {
    expect(resolveReference(`${ns.prefix}web`, candidates, ns).found).toBeNull()
    expect(resolveReference('postgres', candidates, ns).found).toBeNull()
    expect(resolveReference('dddd', candidates, ns).found).toBeNull()
  })

  it('replaces a name with the host name, an id with the full id, and nothing with a name that cannot exist', () => {
    expect(replacementFor('web', resolveReference('web', candidates, ns), ns, 'container')).toBe(`${ns.prefix}web`)
    expect(replacementFor('cccc', resolveReference('cccc', candidates, ns), ns, 'container')).toBe(candidates[3]!.id)
    expect(replacementFor('/other', resolveReference('/other', candidates, ns), ns, 'container')).toBe(`${ns.prefix}other`)
  })
})

describe('filters', () => {
  it('reads both the current and the legacy form, and renders the current one', () => {
    expect(parseFilters('{"label":{"a=b":true,"c":false}}')).toEqual({ label: ['a=b'] })
    expect(parseFilters('{"label":["a=b"]}')).toEqual({ label: ['a=b'] })
    expect(renderFilters({ label: ['a=b'], name: [] })).toBe('{"label":{"a=b":true}}')
  })

  it('adds the environment label to whatever the client asked for', () => {
    const scoped = scopeFilters({ label: ['com.docker.compose.project=api'], name: ['^web$'] }, ns,
      { label: 'domo.env=env_0123456789abcdef0123', kind: 'container' })
    expect(scoped.label).toEqual(['com.docker.compose.project=api', 'domo.env=env_0123456789abcdef0123'])
    expect(scoped.name).toEqual(['^/?(?:env_0123456789abcdef0123-)?web$'])
  })
})

describe('classifyRequest', () => {
  const classify = (method: string, path: string, query = '') => classifyRequest(method, path, new URLSearchParams(query))

  it.each([
    ['POST', '/containers/create', { kind: 'container-create' }],
    ['GET', '/containers/json', { kind: 'container-list' }],
    ['POST', '/containers/prune', { kind: 'container-prune' }],
    ['GET', '/containers/web/json', { kind: 'container', ref: 'web', action: 'json' }],
    ['DELETE', '/containers/web', { kind: 'container', ref: 'web', action: 'DELETE' }],
    ['POST', '/containers/web/stop', { kind: 'container', ref: 'web', action: 'stop' }],
    ['POST', '/containers/web/attach/ws', { kind: 'container', ref: 'web', action: 'attach' }],
    ['GET', '/networks', { kind: 'network-list' }],
    ['POST', '/networks/create', { kind: 'network-create' }],
    ['POST', '/networks/prune', { kind: 'network-prune' }],
    ['GET', '/networks/stack_default', { kind: 'network', ref: 'stack_default', action: '' }],
    ['POST', '/networks/n/connect', { kind: 'network', ref: 'n', action: 'connect' }],
    ['GET', '/volumes', { kind: 'volume-list' }],
    ['POST', '/volumes/create', { kind: 'volume-create' }],
    ['DELETE', '/volumes/data', { kind: 'volume', ref: 'data' }],
    ['GET', '/events', { kind: 'events' }],
    ['GET', '/system/df', { kind: 'system-df' }],
    ['POST', '/commit', { kind: 'commit' }],
    ['GET', '/_ping', { kind: 'forward' }],
    ['GET', '/swarm', { kind: 'forward' }],
    ['POST', '/images/prune', { kind: 'forward' }]
  ])('%s %s', (method, path, expected) => {
    expect(classify(method, path)).toEqual(expected)
  })

  it('decodes a reference', () => {
    expect(classify('GET', '/containers/%2Fweb/json')).toMatchObject({ ref: '/web' })
  })

  it.each([
    ['POST', '/swarm/init', ''],
    ['POST', '/services/create', ''],
    ['DELETE', '/nodes/abc', ''],
    ['POST', '/secrets/create', ''],
    ['POST', '/configs/create', ''],
    ['POST', '/plugins/pull', ''],
    ['PUT', '/volumes/data', ''],
    ['POST', '/build/prune', ''],
    ['POST', '/images/prune', `filters=${encodeURIComponent('{"dangling":{"false":true}}')}`]
  ])('refuses %s %s %s', (method, path, query) => {
    expect(classify(method, path, query)).toMatchObject({ kind: 'refuse', status: 403 })
  })

  it('allows a dangling-only image prune', () => {
    expect(classify('POST', '/images/prune', `filters=${encodeURIComponent('{"dangling":{"true":true}}')}`))
      .toEqual({ kind: 'forward' })
  })
})

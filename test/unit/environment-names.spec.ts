import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { branchNameProblem, environmentListRows, environmentSlug } from '../../shared/dev-environments'

/** What git itself says: the rules above are a copy, so they are checked against the original. */
function gitAccepts(name: string): boolean {
  try {
    return execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' }).toString().trim() === name
  } catch {
    return false
  }
}

describe('branchNameProblem', () => {
  const names = [
    'feature-auth', 'handoff/speech-system', 'a/b/c/d', 'Feature/Ünïcode', 'v1.2', 'a_b', 'x@y', 'a.b/c.d',
    'a b', ' lead', 'trail ', 'tab\there', '-dash', 'a..b', 'a/.hidden', '.hidden', 'x.lock', 'a.lock/b',
    '/lead', 'trail/', 'a//b', 'dot.', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'x@{y', 'HEAD', '@{-1}'
  ]

  it.each(names)('agrees with git about %j', (name) => {
    expect(branchNameProblem(name) === null).toBe(gitAccepts(name))
  })

  it('refuses the empty name and a lone @, which git takes but no branch should be', () => {
    expect(branchNameProblem('')).toBe('A name is required.')
    expect(branchNameProblem('@')).toContain('reserved')
  })
})

describe('environmentSlug', () => {
  it('keeps a name that is already one path segment', () => {
    expect(environmentSlug('feature-auth')).toBe('feature-auth')
    expect(environmentSlug('Feature_1.2')).toBe('Feature_1.2')
  })

  it('never lets two names share a directory', () => {
    const names = ['a/b', 'a-b', 'a/b/c', 'a-b/c', 'a/b-c', 'Ünï', 'x@y', 'x-y']
    const slugs = names.map(environmentSlug)
    expect(new Set(slugs).size).toBe(names.length)
    for (const slug of slugs) expect(slug).toMatch(/^[a-zA-Z0-9_.-]+$/)
    expect(environmentSlug('handoff/speech-system')).toMatch(/^handoff-speech-system-[0-9a-f]{6}$/)
    // Stable: the same name, the same directory.
    expect(environmentSlug('a/b')).toBe(environmentSlug('a/b'))
  })
})

describe('environmentListRows', () => {
  const env = (name: string) => ({ id: name, name })
  const list = [env('solo'), env('handoff/speech-system'), env('handoff/voice/x'), env('handoff/voice/y'), env('alpha/one')]

  it('groups by slash segments to any depth, folders first, each environment by its last segment', () => {
    expect(environmentListRows(list).map(row => [row.kind, row.depth, row.label, row.kind === 'folder' ? row.count : row.environment.name])).toEqual([
      ['folder', 0, 'alpha', 1],
      ['environment', 1, 'one', 'alpha/one'],
      ['folder', 0, 'handoff', 3],
      ['folder', 1, 'voice', 2],
      ['environment', 2, 'x', 'handoff/voice/x'],
      ['environment', 2, 'y', 'handoff/voice/y'],
      ['environment', 1, 'speech-system', 'handoff/speech-system'],
      ['environment', 0, 'solo', 'solo']
    ])
  })

  it('leaves out what a collapsed folder holds, and keeps the folder', () => {
    const rows = environmentListRows(list, path => path === 'handoff')
    expect(rows.map(row => row.kind === 'folder' ? `${row.path}/` : row.environment.name))
      .toEqual(['alpha/', 'alpha/one', 'handoff/', 'solo'])
  })

  it('makes no empty folders of an old name with stray slashes', () => {
    const rows = environmentListRows([env('/odd//name/')])
    expect(rows.map(row => [row.kind, row.label])).toEqual([['folder', 'odd'], ['environment', 'name']])
  })
})

import { describe, expect, it } from 'vitest'

import {
  carryMessage,
  describeSeed,
  MAX_REPORTED_PATHS,
  parsePorcelain,
  RECONCILE_SCRIPT,
  reconcileArgs,
  seedReport
} from '../../server/lib/dev-env/workspace-seed'

/**
 * The decisions behind "the environment's git and the environment's files must
 * agree". The script itself is shell, so what is pinned here is the argv it is
 * handed and the properties the incident turned on: ignored files are never
 * touched, untracked-but-not-ignored files are, and nothing is ever interpolated
 * into the command. `dev-environments.spec.ts` asserts that it runs at all, and
 * in the right place; `dev-environment.live.spec.ts` runs it against real git.
 */

describe('parsePorcelain', () => {
  it('reads NUL-separated entries, and takes a rename as one path and not two', () => {
    const output = ' M app/assets/css/main.css\0?? notes.txt\0R  app/new.vue\0app/old.vue\0 D gone.ts\0'

    expect(parsePorcelain(output)).toEqual(['app/assets/css/main.css', 'notes.txt', 'app/new.vue', 'gone.ts'])
  })

  it('keeps a path with a space in it whole', () => {
    expect(parsePorcelain('?? some file.txt\0')).toEqual(['some file.txt'])
  })

  it('is empty for a clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
  })
})

describe('reconcileArgs', () => {
  it('passes the mode, the workspace and the message as argv, never inside the script', () => {
    const args = reconcileArgs({ mode: 'carry', workspacePath: '/workspaces/feature-auth', message: 'a; rm -rf /' })

    expect(args).toEqual(['sh', '-c', RECONCILE_SCRIPT, 'sh', 'carry', '/workspaces/feature-auth', 'a; rm -rf /'])
    expect(RECONCILE_SCRIPT).not.toContain('feature-auth')
  })

  it('resets to HEAD and removes untracked files in discard mode', () => {
    expect(RECONCILE_SCRIPT).toContain('git reset --hard --quiet')
    expect(RECONCILE_SCRIPT).toContain('git clean -fdq')
  })

  // `node_modules` is the entire reason the workspace volume exists, and a
  // gitignored `.env` is what the environment needs to run at all. Neither can
  // ever reach a commit without being force-added, so neither can make the
  // returning diff lie — which is why `-x` must not appear here.
  it('never cleans ignored files', () => {
    expect(RECONCILE_SCRIPT).not.toMatch(/git clean[^\n]*-[a-z]*x/)
  })

  it('commits what it carries without running the project\'s commit hooks', () => {
    expect(RECONCILE_SCRIPT).toContain('git commit --quiet --no-verify')
  })

  it('leaves a repository with no commits alone rather than failing creation', () => {
    expect(RECONCILE_SCRIPT).toContain('git rev-parse --verify --quiet HEAD')
    expect(RECONCILE_SCRIPT).toContain('exit 0')
  })
})

describe('seedReport', () => {
  it('caps the listed paths but keeps the true total', () => {
    const paths = Array.from({ length: MAX_REPORTED_PATHS + 5 }, (_value, index) => `file-${index}.ts`)

    const report = seedReport({ mode: 'discard', paths })

    expect(report.paths).toHaveLength(MAX_REPORTED_PATHS)
    expect(report.total).toBe(MAX_REPORTED_PATHS + 5)
    expect(report.commit).toBeNull()
  })
})

describe('describeSeed', () => {
  it('says nothing happened when the host tree was clean', () => {
    expect(describeSeed(seedReport({ mode: 'discard', paths: [] })))
      .toBe('The host checkout had no uncommitted changes.')
  })

  it('says what was left behind, so an absent change is never a silent one', () => {
    expect(describeSeed(seedReport({ mode: 'discard', paths: ['a.ts', 'b.ts'] })))
      .toContain('Left 2 uncommitted paths behind on the host')
  })

  it('names the commit carried work landed on', () => {
    expect(describeSeed(seedReport({ mode: 'carry', paths: ['a.ts'], commit: '0123456789abcdef' })))
      .toBe('Carried 1 uncommitted path from the host and committed them as 0123456789ab.')
  })
})

describe('carryMessage', () => {
  it('says where the changes came from and that they are not the session\'s work', () => {
    const message = carryMessage({ environmentName: 'feature-auth', repoPath: '/Users/dev/domo' })

    expect(message.split('\n')[0]).toBe('chore: carry the host\'s uncommitted changes into feature-auth')
    expect(message).toContain('/Users/dev/domo')
    expect(message).toContain('not this session\'s work')
  })
})

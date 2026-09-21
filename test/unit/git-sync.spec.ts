import { describe, expect, it, vi } from 'vitest'

/**
 * The two pure pieces of the branch export: the `ext::` URL a host `git fetch`
 * is handed, and the rule that decides which local branch (if any) an export
 * is allowed to move.
 *
 * The module's database and Docker neighbours are mocked away for the same
 * reason every other unit spec does it — this project has no services.
 */
vi.mock('../../server/lib/repo', () => ({
  getDevEnvironment: vi.fn(),
  getProject: vi.fn()
}))
vi.mock('../../server/lib/dev-environments', () => ({
  safeEnvironmentName: (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()
}))

const { resolveIntoBranch, uploadPackTransport } = await import('../../server/lib/dev-env/git-sync')

const transport = (overrides: Record<string, unknown> = {}) => uploadPackTransport({
  containerId: 'c0ffee00',
  remoteUser: 'vscode',
  home: '/home/vscode',
  workspacePath: '/workspaces/feature-auth',
  ...overrides
} as any)

describe('uploadPackTransport', () => {
  it('runs git-upload-pack in the container, as the remote user, with HOME set', () => {
    // Both are load-bearing: without them git calls the checkout "dubiously
    // owned", because the safe.directory is in that user's own ~/.gitconfig.
    expect(transport()).toBe(
      'ext::docker exec -i -u vscode -e HOME=/home/vscode c0ffee00 git-upload-pack /workspaces/feature-auth'
    )
  })

  it('leaves the user and HOME out for an environment that recorded neither', () => {
    expect(transport({ remoteUser: null, home: null })).toBe(
      'ext::docker exec -i c0ffee00 git-upload-pack /workspaces/feature-auth'
    )
  })

  it('refuses a value that is not a single bare word, because git splits on whitespace', () => {
    // Anything with a space in it would silently become extra arguments.
    expect(() => transport({ workspacePath: '/workspaces/my project' })).toThrow(/workspace path/)
    expect(() => transport({ remoteUser: 'dev user' })).toThrow(/user/)
    expect(() => transport({ containerId: '' })).toThrow(/container id/)
    // `%` is git's own escape in an ext command, so it is not a bare word either.
    expect(() => transport({ workspacePath: '/workspaces/100%' })).toThrow(/workspace path/)
  })
})

describe('resolveIntoBranch', () => {
  it('defaults to the same name on the host', () => {
    expect(resolveIntoBranch('main', undefined)).toBe('main')
  })

  it('takes an explicit branch, trimmed', () => {
    expect(resolveIntoBranch('main', '  release  ')).toBe('release')
  })

  it('reads null and blank as "fetch only"', () => {
    expect(resolveIntoBranch('main', null)).toBeNull()
    expect(resolveIntoBranch('main', '')).toBeNull()
    expect(resolveIntoBranch('main', '   ')).toBeNull()
  })
})

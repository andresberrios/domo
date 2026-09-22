import { describe, expect, it, vi } from 'vitest'

/**
 * The pure pieces of moving a branch between the host and an environment: the
 * `ext::` URL a host `git fetch` or `git push` is handed, and the rules that
 * decide which branch each direction is allowed to touch.
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

const { environmentTransport, resolveFromRef, resolveIntoBranch }
  = await import('../../server/lib/dev-env/git-sync')

const transport = (overrides: Record<string, unknown> = {}) => environmentTransport({
  containerId: 'c0ffee00',
  remoteUser: 'vscode',
  home: '/home/vscode',
  workspacePath: '/workspaces/feature-auth',
  ...overrides
} as any)

describe('environmentTransport', () => {
  it('runs the service git asks for, in the container, as the remote user, with HOME set', () => {
    // Both are load-bearing: without them git calls the checkout "dubiously
    // owned", because the safe.directory is in that user's own ~/.gitconfig.
    expect(transport()).toBe(
      'ext::docker exec -i -u vscode -e HOME=/home/vscode c0ffee00 git %s /workspaces/feature-auth'
    )
  })

  // `%s` is the *short* service name (`upload-pack` / `receive-pack`), which is
  // what `git` takes as a subcommand. `%S` is the long one, for exec'ing the
  // binary. Mixing them does not fail where you are looking: `docker exec`
  // reports no such executable and the user is handed
  // `fatal: protocol error: bad line length character: OCI`.
  it('invokes git with the short service name, matching how it runs it', () => {
    expect(transport()).toContain(' git %s ')
    expect(transport()).not.toContain('%S')
  })

  // The `ext::` transport ignores `--receive-pack`, so this is the only place a
  // setting for the *receiving* end can go — and it is what lets an import
  // write the branch the container has checked out.
  it('carries -c settings for the git inside the container', () => {
    expect(transport({ config: ['receive.denyCurrentBranch=updateInstead'] })).toBe(
      'ext::docker exec -i -u vscode -e HOME=/home/vscode c0ffee00 git '
      + '-c receive.denyCurrentBranch=updateInstead %s /workspaces/feature-auth'
    )
  })

  it('refuses a -c setting that is not a bare word either', () => {
    expect(() => transport({ config: ['core.editor=code --wait'] })).toThrow(/git setting/)
  })

  it('leaves the user and HOME out for an environment that recorded neither', () => {
    expect(transport({ remoteUser: null, home: null })).toBe(
      'ext::docker exec -i c0ffee00 git %s /workspaces/feature-auth'
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

describe('resolveFromRef', () => {
  it('defaults to the same name on the host', () => {
    expect(resolveFromRef('main', undefined)).toBe('main')
  })

  it('takes an explicit ref, trimmed', () => {
    expect(resolveFromRef('main', '  release  ')).toBe('release')
  })

  // Unlike an export, there is no "send nothing" mode: something has to be sent,
  // so a blank means the branch's own name rather than null.
  it('reads null and blank as the branch\'s own name', () => {
    expect(resolveFromRef('main', null)).toBe('main')
    expect(resolveFromRef('main', '   ')).toBe('main')
  })
})

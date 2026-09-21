import { describe, expect, it } from 'vitest'

import {
  CONTAINER_SSH_AUTH_SOCK,
  DEFAULT_HOME_MOUNTS,
  containerGitconfig,
  emptyHomeOverlay,
  homeOverlay,
  normalizeHomeMount,
  overlaySourceHome,
  validateHomeMount,
  validateHomeMounts,
  type HomeOverlayInput,
  type SshAgentSource
} from '../../server/lib/dev-env/home-overlay'

/**
 * A dev environment is a namespace, not a security boundary, so the host user's
 * login state is shared with it. What that costs is a function whose whole
 * contract is "which host paths end up where inside the container", and which
 * has to refuse the two or three that would break something — so it is pure,
 * and everything it cannot know (what exists, what kind of SSH agent there is)
 * is an input.
 */

function overlay(input: Partial<HomeOverlayInput> = {}) {
  const paths = input.paths ?? DEFAULT_HOME_MOUNTS
  return homeOverlay({
    sourceHome: '/Users/me',
    containerHome: '/home/vscode',
    workspacePath: '/workspaces/api',
    paths,
    present: input.present ?? paths,
    sshAgent: input.sshAgent ?? null,
    ...input
  })
}

function sources(result: ReturnType<typeof overlay>): Record<string, string> {
  return Object.fromEntries(result.mounts.map(mount => [mount.target, mount.source]))
}

describe('normalizeHomeMount', () => {
  it.each([
    ['  .ssh  ', '.ssh'],
    ['.config/gh/', '.config/gh'],
    ['.config//gh', '.config/gh'],
    ['.config\\gh', '.config/gh']
  ])('reads %o as %o', (input, expected) => {
    expect(normalizeHomeMount(input)).toBe(expected)
  })
})

describe('validateHomeMount', () => {
  it('accepts a path relative to the home directory', () => {
    for (const entry of DEFAULT_HOME_MOUNTS) expect(validateHomeMount(entry)).toBeNull()
  })

  it.each([
    ['an empty entry', '   ', /empty line/],
    ['an absolute path', '/etc/passwd', /absolute path/],
    ['a home-relative one written with a tilde', '~/.ssh', /leading "~\/"/],
    ['an escape', '../../etc', /may not contain/],
    ['an escape in the middle', '.config/../../etc', /may not contain/]
  ])('refuses %s', (_label, entry, message) => {
    expect(validateHomeMount(entry)).toMatch(message)
  })

  /**
   * `.claude` is the one that would do real damage: Anthropic rotates the OAuth
   * refresh token on every refresh, so a container sharing `.credentials.json`
   * logs the developer's own machine out.
   */
  it.each([
    ['.claude', /setup-token/],
    ['.claude/settings.json', /setup-token/],
    ['.claude.json', /own state file/],
    ['.codex', /already mounted/]
  ])('refuses %s', (entry, message) => {
    expect(validateHomeMount(entry)).toMatch(message)
  })

  it('reports every problem in a list at once', () => {
    expect(validateHomeMounts(['.ssh', '/etc', '.claude', '..'])).toHaveLength(3)
  })
})

describe('homeOverlay', () => {
  it('bind-mounts each entry into the container home, read-write', () => {
    const result = overlay({ paths: ['.ssh', '.config/gh', '.aws'] })

    expect(result.mounts).toEqual([
      { type: 'bind', source: '/Users/me/.ssh', target: '/home/vscode/.ssh' },
      { type: 'bind', source: '/Users/me/.config/gh', target: '/home/vscode/.config/gh' },
      { type: 'bind', source: '/Users/me/.aws', target: '/home/vscode/.aws' }
    ])
  })

  it('reads the entries from wherever sourceHome points, which is the multi-user hook', () => {
    const result = overlay({ sourceHome: '/srv/domo/homes/ana', paths: ['.ssh'] })

    expect(sources(result)['/home/vscode/.ssh']).toBe('/srv/domo/homes/ana/.ssh')
  })

  it('follows the container home, root included', () => {
    const result = overlay({ containerHome: '/root', paths: ['.ssh'] })

    expect(result.mounts[0]!.target).toBe('/root/.ssh')
  })

  it('skips an entry the host does not have, silently', () => {
    const result = overlay({ paths: ['.ssh', '.kube'], present: ['.ssh'] })

    expect(result.mounts.map(mount => mount.target)).toEqual(['/home/vscode/.ssh'])
  })

  it('skips an entry that would be refused, so a bad stored setting cannot mount it', () => {
    const result = overlay({ paths: ['.claude', '/etc', '.ssh'], present: ['.claude', '/etc', '.ssh'] })

    expect(result.mounts.map(mount => mount.target)).toEqual(['/home/vscode/.ssh'])
  })

  it('mounts a repeated entry once', () => {
    expect(overlay({ paths: ['.ssh', '.ssh/'] }).mounts).toHaveLength(1)
  })

  it('mounts nothing when nothing is configured', () => {
    const empty = emptyHomeOverlay({ containerHome: '/home/vscode', workspacePath: '/workspaces/api' })

    expect(empty.mounts).toEqual([])
    expect(empty.env).toEqual({})
    expect(empty.parentDirectories).toEqual([])
  })

  describe('the gitconfig special case', () => {
    it('mounts the host file read-only and beside the container\'s own', () => {
      const result = overlay({ paths: ['.gitconfig'] })

      expect(result.mounts).toEqual([{
        type: 'bind',
        source: '/Users/me/.gitconfig',
        target: '/home/vscode/.gitconfig-host',
        readonly: true
      }])
      // VS Code's attach writes its own helper into `~/.gitconfig` in there.
      expect(result.mounts.map(mount => mount.target)).not.toContain('/home/vscode/.gitconfig')
    })

    it('includes the host file, marks the workspace safe and turns signing off', () => {
      expect(overlay({ paths: ['.gitconfig'] }).gitconfig).toBe([
        '[include]',
        '    path = ~/.gitconfig-host',
        '[safe]',
        '    directory = /workspaces/api',
        '[credential]',
        '    helper =',
        '    helper = !gh auth git-credential',
        '[commit]',
        '    gpgsign = false',
        '[tag]',
        '    gpgsign = false',
        ''
      ].join('\n'))
    })

    it.each([
      ['the host has none', { paths: ['.gitconfig'], present: [] }],
      ['it was taken out of the list', { paths: ['.ssh'] }]
    ])('skips the include when %s', (_label, input) => {
      const result = overlay(input)

      expect(result.gitconfig).not.toContain('[include]')
      // The rest is Domo's own and still has to be there.
      expect(result.gitconfig).toContain('    directory = /workspaces/api')
      expect(result.gitconfig).toContain('    helper = !gh auth git-credential')
    })

    it('resets the helper list before naming gh, since the host names helpers we lack', () => {
      const config = containerGitconfig({
        containerHome: '/home/vscode',
        workspacePath: '/workspaces/api',
        includeHostConfig: true
      })

      expect(config.indexOf('    helper =\n')).toBeLessThan(config.indexOf('!gh auth git-credential'))
    })
  })

  describe('the SSH agent', () => {
    it('mounts Docker Desktop\'s forwarded socket from the path only the VM has', () => {
      const result = overlay({ paths: [], sshAgent: { kind: 'docker-desktop' } })

      expect(result.mounts).toEqual([
        { type: 'bind', source: CONTAINER_SSH_AUTH_SOCK, target: CONTAINER_SSH_AUTH_SOCK }
      ])
      expect(result.env).toEqual({ SSH_AUTH_SOCK: CONTAINER_SSH_AUTH_SOCK })
    })

    it('mounts this process\'s own socket everywhere else, at the same path inside', () => {
      const agent: SshAgentSource = { kind: 'socket', path: '/tmp/ssh-XYZ/agent.42' }
      const result = overlay({ paths: [], sshAgent: agent })

      expect(result.mounts).toEqual([
        { type: 'bind', source: '/tmp/ssh-XYZ/agent.42', target: CONTAINER_SSH_AUTH_SOCK }
      ])
      expect(result.env.SSH_AUTH_SOCK).toBe(CONTAINER_SSH_AUTH_SOCK)
    })

    it('offers nothing, and sets nothing, when there is no agent', () => {
      const result = overlay({ paths: ['.ssh'], sshAgent: null })

      expect(result.mounts.map(mount => mount.target)).toEqual(['/home/vscode/.ssh'])
      expect(result.env).toEqual({})
    })
  })

  describe('the parents Docker creates as root', () => {
    it('names each ancestor under the container home, shallowest first', () => {
      const result = overlay({ paths: ['.config/gh', '.config/gcloud', '.local/share/foo/bar'] })

      expect(result.parentDirectories).toEqual([
        '/home/vscode/.config',
        '/home/vscode/.local',
        '/home/vscode/.local/share',
        '/home/vscode/.local/share/foo'
      ])
    })

    it('names nothing for an entry that sits directly in the home', () => {
      expect(overlay({ paths: ['.ssh', '.gitconfig'] }).parentDirectories).toEqual([])
    })

    it('leaves the agent socket alone — it is not in the home', () => {
      const result = overlay({ paths: [], sshAgent: { kind: 'docker-desktop' } })

      expect(result.parentDirectories).toEqual([])
    })
  })
})

describe('the defaults', () => {
  it('are the login state a developer actually has, in a fixed order', () => {
    expect(DEFAULT_HOME_MOUNTS).toEqual(['.ssh', '.gitconfig', '.config/gh', '.config/gcloud', '.aws', '.kube'])
  })

  /**
   * Docker Desktop writes `"credsStore": "desktop"`, and that helper binary
   * exists on the host only: with the file mounted, every `docker pull` inside
   * an environment fails with `docker-credential-desktop: executable file not
   * found`.
   */
  it('leave `.docker` out', () => {
    expect(DEFAULT_HOME_MOUNTS).not.toContain('.docker')
  })
})

describe('overlaySourceHome', () => {
  it('is the process home, and NUXT_HOME_OVERLAY_DIR wins', () => {
    expect(overlaySourceHome({ HOME: '/Users/me' })).toBe('/Users/me')
    expect(overlaySourceHome({ HOME: '/Users/me', NUXT_HOME_OVERLAY_DIR: '/tmp/fake' })).toBe('/tmp/fake')
    expect(overlaySourceHome({})).toBeNull()
  })
})

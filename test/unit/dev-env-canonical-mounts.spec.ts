import { describe, expect, it } from 'vitest'

import {
  canonicalBaseGitPath,
  canonicalGitdirFileContents,
  canonicalWorkspacePath,
  canonicalWorktreeGitdir,
  resolveWorkspaceAlias,
  WORKSPACE_ALIAS_SCRIPT,
  workspaceAliasArgs
} from '../../server/lib/dev-env/canonical-mounts'

/**
 * The fixed layout every worktree environment's container shares. The
 * behaviour against real git lives in `dev-env-host-worktree.spec.ts`.
 */

const alias = { legacyPath: '/workspaces/api', canonicalPath: '/worktrees/env_1' }

describe('canonical paths', () => {
  it('keys the checkout by environment and the base .git by project', () => {
    expect(canonicalWorkspacePath('env_1')).toBe('/worktrees/env_1')
    expect(canonicalBaseGitPath('prj_1')).toBe('/worktrees/.base/prj_1')
  })

  it('points the container\'s .git at the admin directory git actually made, under the mounted base', () => {
    expect(canonicalWorktreeGitdir('prj_1', 'worktrees/env_1')).toBe('/worktrees/.base/prj_1/worktrees/env_1')
    // Git suffixes the name on a clash; the path read back is what is used.
    expect(canonicalGitdirFileContents('prj_1', 'worktrees/env_11')).toBe('gitdir: /worktrees/.base/prj_1/worktrees/env_11\n')
  })

  it('refuses an admin path that would escape the mounted base', () => {
    for (const bad of ['', '/etc', '../../etc', 'worktrees/../../x']) {
      expect(() => canonicalWorktreeGitdir('prj_1', bad), bad).toThrow(/not a worktree admin directory/)
    }
  })
})

describe('resolveWorkspaceAlias', () => {
  it('maps the legacy path and everything under it onto the canonical mount', () => {
    expect(resolveWorkspaceAlias('/workspaces/api', alias)).toBe('/worktrees/env_1')
    expect(resolveWorkspaceAlias('/workspaces/api/db/init.sql', alias)).toBe('/worktrees/env_1/db/init.sql')
  })

  it('leaves a sibling that only shares a prefix, and everything else, alone', () => {
    expect(resolveWorkspaceAlias('/workspaces/api-v2/db', alias)).toBe('/workspaces/api-v2/db')
    expect(resolveWorkspaceAlias('/worktrees/env_1/db', alias)).toBe('/worktrees/env_1/db')
    expect(resolveWorkspaceAlias('/home/vscode/.aws', alias)).toBe('/home/vscode/.aws')
  })
})

describe('workspaceAliasArgs', () => {
  it('passes both paths as argv, never inside the script', () => {
    const args = workspaceAliasArgs({ canonicalPath: '/worktrees/env_1', legacyPath: '/workspaces/a; rm -rf /' })

    expect(args).toEqual(['sh', '-c', WORKSPACE_ALIAS_SCRIPT, 'sh', '/worktrees/env_1', '/workspaces/a; rm -rf /'])
    expect(WORKSPACE_ALIAS_SCRIPT).not.toContain('worktrees')
  })

  it('replaces a stale symlink rather than nesting a new one inside it', () => {
    expect(WORKSPACE_ALIAS_SCRIPT).toContain('ln -sfn')
  })
})

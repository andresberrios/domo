import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ProjectPathState } from '../../shared/types'
import { run } from './dev-env/docker'
import { expandPath, insideOwnInstall } from './paths'

/** Look at a path without writing anything: what making a project of it would take. */
export async function inspectProjectPath(input: string): Promise<ProjectPathState> {
  const path = expandPath(input)
  const state: ProjectPathState = { path, kind: 'missing', empty: false, toCreate: [], enclosingRepository: null, problem: null }
  if (insideOwnInstall(path)) {
    state.problem = `${path} is inside Domo's own install, which updates replace. Choose a folder outside it.`
    return state
  }
  let existing = path
  for (;;) {
    const found = await stat(existing).catch(() => null)
    if (found) {
      if (!found.isDirectory()) {
        state.kind = 'file'
        state.problem = existing === path
          ? `${path} is a file, not a folder.`
          : `${existing} is a file, so no folder can be made inside it.`
        return state
      }
      break
    }
    state.toCreate.unshift(existing)
    if (dirname(existing) === existing) break
    existing = dirname(existing)
  }
  if (existing === path) {
    if (await stat(join(path, '.git')).then(() => true, () => false)) {
      state.kind = 'repository'
      return state
    }
    state.kind = 'directory'
    state.empty = (await readdir(path).catch(() => [''])).length === 0
  }
  const top = await run('git', ['-C', existing, 'rev-parse', '--show-toplevel'], { allowFailure: true })
    .catch(() => ({ stdout: '' }))
  state.enclosingRepository = top.stdout.trim() || null
  if (!(await access(existing, constants.W_OK).then(() => true, () => false))) {
    state.problem = `Domo cannot write to ${existing}.`
  }
  return state
}

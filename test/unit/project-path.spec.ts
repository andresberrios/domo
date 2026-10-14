import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspectProjectPath } from '../../server/lib/project-path'

/** What a new project at a path would take, read against a real filesystem and real git. */

const exec = promisify(execFile)
let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'domo-pp-')))
})
afterEach(async () => {
  await chmod(root, 0o755).catch(() => null)
  await rm(root, { recursive: true, force: true })
})

describe('inspectProjectPath', () => {
  it('knows a checkout', async () => {
    await exec('git', ['init', '--quiet', join(root, 'repo')])
    expect(await inspectProjectPath(join(root, 'repo'))).toEqual({
      path: join(root, 'repo'), kind: 'repository', empty: false, toCreate: [], enclosingRepository: null, problem: null
    })
  })

  it('tells an empty folder from one with files', async () => {
    await mkdir(join(root, 'empty'))
    await mkdir(join(root, 'full'))
    await writeFile(join(root, 'full', '.env'), 'A=1\n')
    expect(await inspectProjectPath(join(root, 'empty'))).toMatchObject({ kind: 'directory', empty: true, problem: null })
    expect(await inspectProjectPath(join(root, 'full'))).toMatchObject({ kind: 'directory', empty: false, problem: null })
  })

  it('lists every folder a missing path would make, outermost first', async () => {
    expect(await inspectProjectPath(join(root, 'typo', 'app'))).toMatchObject({
      kind: 'missing', toCreate: [join(root, 'typo'), join(root, 'typo', 'app')], problem: null
    })
  })

  it('says when the path is inside another repository', async () => {
    await exec('git', ['init', '--quiet', join(root, 'outer')])
    await mkdir(join(root, 'outer', 'packages'))
    expect(await inspectProjectPath(join(root, 'outer', 'packages'))).toMatchObject({
      kind: 'directory', enclosingRepository: join(root, 'outer')
    })
    expect(await inspectProjectPath(join(root, 'outer', 'new'))).toMatchObject({
      kind: 'missing', enclosingRepository: join(root, 'outer')
    })
  })

  it('refuses a file, a path under a file, and a parent it cannot write to', async () => {
    await writeFile(join(root, 'notes.txt'), '')
    expect(await inspectProjectPath(join(root, 'notes.txt'))).toMatchObject({ kind: 'file', problem: expect.stringContaining('is a file') })
    expect(await inspectProjectPath(join(root, 'notes.txt', 'app'))).toMatchObject({ kind: 'file', problem: expect.stringContaining('no folder can be made') })

    if (process.getuid?.() === 0) return // root writes anywhere
    await mkdir(join(root, 'locked'))
    await chmod(join(root, 'locked'), 0o555)
    expect(await inspectProjectPath(join(root, 'locked', 'app'))).toMatchObject({ kind: 'missing', problem: expect.stringContaining('cannot write') })
  })
})

import type { WorkspaceSeedReport } from '../../../shared/types'
import { run } from './docker'

/**
 * What a new environment's worktree starts with, beyond the commit it is cut
 * from: nothing uncommitted from the host (a worktree never carries it, which
 * is what git users expect, and what keeps an export's diff honest), and the
 * few ignored files a checkout cannot run without — a `.env` — copied on
 * purpose, by pattern.
 */

/** How many dirty paths are named back to the caller before the list is cut short. */
export const MAX_REPORTED_PATHS = 20

/**
 * Ignored files copied into every new worktree unless `.domo.json` says
 * otherwise (`copyIgnored`). Ignored, so they can never enter a commit and
 * make the returning diff lie; and small, which is what separates them from
 * `node_modules`, which is never copied (it is installed for the container's
 * own platform instead).
 */
export const DEFAULT_COPY_IGNORED = ['**/.env', '**/.env.*']

/**
 * A `.gitignore`-style glob as a regular expression over a `/`-separated
 * relative path: `**` spans directories, `*` and `?` stay inside one, and a
 * leading `**` + `/` also matches at the top level.
 */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(glob => globToRegExp(glob).test(path))
}

/**
 * `git status --porcelain -z` into plain paths. A rename or a copy is followed
 * by its *source* path as a second NUL-terminated field, which is one entry and
 * not two.
 */
export function parsePorcelain(output: string): string[] {
  const fields = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]
    if (!entry || entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') index++
  }
  return paths
}

/**
 * What the host checkout has that its HEAD does not. Only ever to say what
 * stayed behind: a failure here means an empty report, never a failed creation.
 */
export async function readHostWorkingTree(repoPath: string): Promise<string[]> {
  const listed = await run('git', ['-C', repoPath, 'status', '--porcelain', '-z'], { trimOutput: false })
    .catch((error) => {
      console.warn(`[dev-env] could not read the working tree of ${repoPath}: ${error}`)
      return { stdout: '', stderr: '' }
    })
  return parsePorcelain(listed.stdout)
}

export function seedReport(input: {
  paths: string[]
  copied?: string[]
  install?: WorkspaceSeedReport['install']
}): WorkspaceSeedReport {
  return {
    paths: input.paths.slice(0, MAX_REPORTED_PATHS),
    total: input.paths.length,
    copied: input.copied ?? [],
    install: input.install ?? null
  }
}

/** One or two English sentences about how the worktree started, for a tool result or a toast. */
export function describeSeed(report: WorkspaceSeedReport): string {
  const sentences: string[] = []
  sentences.push(report.total === 0
    ? 'It starts from the project\'s last commit.'
    : `It starts from the project's last commit; ${report.total} uncommitted `
      + `${report.total === 1 ? 'path stays' : 'paths stay'} on the host.`)
  if (report.copied.length) sentences.push(`Copied ${report.copied.join(', ')} from the host.`)
  if (report.install?.error) {
    sentences.push(`\`${report.install.command}\` failed, so dependencies may be missing: ${report.install.error}`)
  } else if (report.install) {
    sentences.push(`Installed dependencies with \`${report.install.command}\`.`)
  }
  return sentences.join(' ')
}

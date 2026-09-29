import { access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The install Domo runs in a new worktree when the project has no
 * `postCreateCommand` of its own. A worktree has no `node_modules` or `.venv`,
 * and these are ignored files that must never come from the host (they hold
 * the host's platform's binaries), so without it every agent's first command
 * would fail. A project that defines `postCreateCommand` owns its install and
 * gets none of this.
 *
 * Frozen installs only: the lockfile the project committed is the one
 * installed, never a resolution that rewrites it in the agent's checkout.
 */

interface Detector {
  lockfile: string
  command: (has: (file: string) => boolean) => string[]
}

const DETECTORS: Detector[] = [
  { lockfile: 'pnpm-lock.yaml', command: () => ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lock', command: () => ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', command: () => ['bun', 'install', '--frozen-lockfile'] },
  {
    lockfile: 'yarn.lock',
    // Yarn 2+ reads `.yarnrc.yml` and renamed the flag; classic has neither.
    command: has => has('.yarnrc.yml') ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile']
  },
  { lockfile: 'package-lock.json', command: () => ['npm', 'ci'] },
  { lockfile: 'uv.lock', command: () => ['uv', 'sync', '--frozen'] }
]

const LOCKFILES = [...DETECTORS.map(detector => detector.lockfile), '.yarnrc.yml']

/** The install for a checkout, judged by the lockfile it committed; null when it has none this knows. */
export function defaultInstallCommand(files: string[]): string[] | null {
  const has = (file: string) => files.includes(file)
  const detector = DETECTORS.find(entry => has(entry.lockfile))
  return detector ? detector.command(has) : null
}

/** The lockfiles present at the top of a checkout, for `defaultInstallCommand`. */
export async function presentLockfiles(checkout: string): Promise<string[]> {
  const present: string[] = []
  for (const file of LOCKFILES) {
    if (await access(join(checkout, file)).then(() => true, () => false)) present.push(file)
  }
  return present
}

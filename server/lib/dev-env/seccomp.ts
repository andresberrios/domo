import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataDir } from '../paths'
import dockerDefault from './seccomp-docker-default.json'

/**
 * What an environment's process may ask the kernel for, beyond Docker's own
 * default: the five calls bubblewrap makes to build a sandbox in a user
 * namespace. Codex runs every command in one, and under Docker's default
 * profile none of them is allowed without CAP_SYS_ADMIN, so Codex in
 * `read-only` or `workspace-write` could not run a single command.
 *
 * Measured one at a time against Codex 0.162.1 on Docker 29.8: dropping any of
 * the five fails the sandbox (`unshare user ns`, no new namespace, `make /
 * slave`, `unmount old root`, `pivot_root`). `clone3` is not among them —
 * Docker answers it ENOSYS and the C library falls back to `clone`. Without a
 * new user namespace the kernel still refuses `mount` and `pivot_root`, so the
 * container itself gains nothing it could use on its own mounts.
 *
 * `seccomp-docker-default.json` is moby/profiles `seccomp/default.json` at
 * 6fe7deb (2026-09-17). Refresh it from there when Docker's default moves.
 */
export const BUBBLEWRAP_SYSCALLS = ['clone', 'mount', 'pivot_root', 'umount2', 'unshare']

export function environmentSeccompProfile(): typeof dockerDefault {
  return {
    ...dockerDefault,
    syscalls: [...dockerDefault.syscalls, { names: BUBBLEWRAP_SYSCALLS, action: 'SCMP_ACT_ALLOW' }]
  } as typeof dockerDefault
}

/**
 * The profile as a file, which is the only way `docker run --security-opt`
 * takes one: the CLI reads it and sends its contents. Named by its content,
 * so concurrent creations write the same file and an old one is never wrong.
 */
export async function ensureSeccompProfile(): Promise<string> {
  const content = JSON.stringify(environmentSeccompProfile())
  const dir = join(dataDir(), 'seccomp')
  const path = join(dir, `environment-${createHash('sha256').update(content).digest('hex').slice(0, 12)}.json`)
  if (existsSync(path)) return path
  await mkdir(dir, { recursive: true })
  const partial = `${path}.${process.pid}.tmp`
  await writeFile(partial, content)
  await rename(partial, path)
  return path
}

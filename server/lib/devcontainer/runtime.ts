/**
 * Host runtime detection for inner-Docker isolation.
 *
 * Per Decided #9 we want **rootless DinD** so each env's `docker compose`
 * is isolated and the install isn't a security hole for multi-user.
 * Three approaches, ordered by preference:
 *
 *   1. **sysbox-runc** — the host registers sysbox as a Docker runtime
 *      (`docker info` → Runtimes includes `sysbox-runc`). We then launch
 *      the env container with `--runtime=sysbox-runc`. Cleanest UX —
 *      the user's inner `docker compose` "just works" without
 *      `--privileged` or special images. Linux-only.
 *   2. **rootless-dind** — fallback. The host runs stock Docker; the
 *      env container image is expected to run rootless dockerd inside
 *      (e.g. `docker:<v>-dind-rootless`). The host doesn't need a
 *      special runtime; the container image does the work. Works on
 *      Linux + macOS Docker Desktop.
 *   3. **privileged** — last resort, only when the operator opts in.
 *      Surfaces a warning. Docker Desktop sometimes needs this if
 *      rootless-dind images can't get cgroup delegation.
 *
 * Detection is cached for the process lifetime (the runtime doesn't
 * change without a daemon restart, and Domo's own restart re-runs this).
 *
 * Real platform-level checks (kernel userns, cgroup v2 delegation,
 * subuid/subgid, fuse-overlayfs) belong in `scripts/install.sh` — the
 * lib only needs to know which runtime to pick at `docker run` time.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { HostRuntime } from './types'

const exec = promisify(execFile)

let cached: HostRuntime | null = null

/** Force re-detection on the next call (test/dev only). */
export function resetRuntimeCache(): void {
  cached = null
}

interface DockerInfoJson {
  Runtimes?: Record<string, unknown>
  CgroupDriver?: string
  CgroupVersion?: string
}

async function dockerInfo(): Promise<DockerInfoJson | null> {
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{json .}}'], { timeout: 5000 })
    return JSON.parse(stdout) as DockerInfoJson
  } catch {
    return null
  }
}

export async function detectHostRuntime(): Promise<HostRuntime> {
  if (cached) return cached
  const info = await dockerInfo()
  const warnings: string[] = []

  if (!info) {
    // Docker daemon unreachable. We still return a default — the actual
    // `up` will fail with a clearer error message at that call site.
    cached = {
      kind: 'rootless-dind',
      extraRunArgs: [],
      warnings: ['docker daemon not reachable; defaulting to rootless-dind'],
    }
    return cached
  }

  const runtimes = info.Runtimes ?? {}
  if ('sysbox-runc' in runtimes) {
    cached = { kind: 'sysbox', extraRunArgs: ['--runtime=sysbox-runc'], warnings }
    return cached
  }

  // cgroup v2 + a non-cgroupfs driver gives rootless-dind the best chance.
  // We don't refuse to run if it's not there — just note it for operators.
  if (info.CgroupVersion && info.CgroupVersion !== '2') {
    warnings.push(
      `cgroup v${info.CgroupVersion} detected; rootless-dind works best with cgroup v2 + delegation`,
    )
  }

  cached = { kind: 'rootless-dind', extraRunArgs: [], warnings }
  return cached
}

/** Opt-in privileged fallback. Caller is responsible for surfacing the
 * security warning to the operator. Not chosen automatically. */
export function privilegedRuntime(): HostRuntime {
  return {
    kind: 'privileged',
    extraRunArgs: ['--privileged'],
    warnings: ['running env containers as --privileged; not safe for multi-user'],
  }
}

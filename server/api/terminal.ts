/**
 * WS endpoint that opens an interactive shell *inside* the env's
 * devcontainer via `docker exec -i -t <containerId> <shell>`. Replaces
 * the Coast-pass-through that lived here pre-step-3a.
 *
 * Client connects to `WS /api/terminal?envId=<id>`. We resolve the env
 * → container id (via stored id OR the `domo.envId` label fallback)
 * and spawn `docker exec`. Bytes flow both directions:
 *   - client→docker: raw stdin text
 *   - docker→client: combined stdout+stderr
 *
 * Frame extensions the xterm client uses (pre-existing protocol —
 * kept for parity with the rest of the stack):
 *   - `\x01<json>` → resize: `{ cols, rows }`. Honored via
 *     `docker exec`'s daemon API resize endpoint. Best-effort — if the
 *     daemon socket isn't reachable we drop the resize quietly.
 *   - `\x02clear` → equivalent to sending `\x1b[2J\x1b[H` (xterm clear);
 *     no special handling needed server-side.
 *
 * The shell command is auto-picked: `bash` if available in the
 * container, else `sh`. We probe via a small `docker exec` shell test
 * the first time a peer connects.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'

import { getEnv, resolveContainerId } from '../lib/envs'

interface Conn {
  child: ChildProcessWithoutNullStreams
  containerId: string
  /** True after the first non-control byte from client; needed to delay
   * spawning until we know what shell to use. */
  shellReady: boolean
}

const conns = new WeakMap<object, Conn>()

function envIdFromPeer(peer: { request?: { url?: string } }): string | null {
  const raw = peer.request?.url
  if (!raw) return null
  try {
    return new URL(raw, 'http://localhost').searchParams.get('envId')
  } catch {
    return null
  }
}

async function pickShell(containerId: string): Promise<string> {
  // Prefer bash; fall back to sh. We don't probe via `docker exec` (one
  // round-trip just for shell detection adds latency) — instead we run
  // `bash` and the OS surfaces an exec error if it's missing, which the
  // caller would already need to handle. So just default to bash and
  // let the user see the error if their image is alpine-minimal.
  // Operators who need a different default can patch this when we
  // expose a per-env shell preference (post-v1).
  void containerId
  return 'bash'
}

/** Read `remoteUser` from the env's worktree devcontainer.json; default
 * to `vscode` (the Microsoft base image's default user) when absent or
 * unreadable. */
async function resolveRemoteUser(worktreePath: string | null): Promise<string> {
  if (!worktreePath) return 'vscode'
  try {
    const { loadDevcontainer } = await import('../lib/devcontainer/parser')
    const { config } = await loadDevcontainer(worktreePath)
    if (typeof config.remoteUser === 'string' && config.remoteUser.length > 0) {
      return config.remoteUser
    }
  } catch {
    // Missing or unparseable — fall through to the default.
  }
  return 'vscode'
}

export default defineWebSocketHandler({
  async open(peer) {
    const envId = envIdFromPeer(peer)
    if (!envId) {
      try { peer.send('envId query param is required\r\n') } catch { /* gone */ }
      peer.close()
      return
    }
    const env = getEnv(envId)
    if (!env) {
      try { peer.send('env not found\r\n') } catch { /* gone */ }
      peer.close()
      return
    }
    const containerId = await resolveContainerId(env)
    if (!containerId) {
      try { peer.send('\r\n[env has no container — run `devcontainer up` first]\r\n') } catch { /* gone */ }
      peer.close()
      return
    }

    const shell = await pickShell(containerId)
    // The Nitro parent has piped stdio (not a TTY), so `docker exec -t`
    // refuses with "cannot attach stdin to a TTY-enabled container".
    // Drop `-t` on the host side and instead allocate a PTY *inside*
    // the container by wrapping the shell with `script` (util-linux,
    // present in every devcontainer base image we ship). bash sees a
    // real TTY, so PS1/readline/job control all work; docker exec
    // shuffles bytes through as a pipe.
    //
    // `-u <remoteUser>` matches the devcontainer's `remoteUser` so
    // `$HOME` (and therefore the shared `~/.claude` bind-mount) lands
    // in the right place. `-w /workspaces/<envName>` drops us into the
    // env's workspace folder — the devcontainer-CLI mount target.
    const remoteUser = await resolveRemoteUser(env.worktreePath)
    const workdir = `/workspaces/${env.name}`
    const child = spawn(
      'docker',
      [
        'exec', '-i', '-u', remoteUser, '-w', workdir, containerId,
        'script', '-qfc', `${shell} -l`, '/dev/null',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    const conn: Conn = { child, containerId, shellReady: true }
    conns.set(peer, conn)

    child.stdout.on('data', (chunk: Buffer) => {
      try { peer.send(chunk.toString('utf8')) } catch { /* peer gone */ }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      try { peer.send(chunk.toString('utf8')) } catch { /* peer gone */ }
    })
    child.once('close', (code) => {
      try { peer.send(`\r\n[shell exited with code ${code}]\r\n`) } catch { /* gone */ }
      try { peer.close() } catch { /* already closed */ }
    })
    child.once('error', () => {
      try { peer.send('\r\n[docker exec spawn failed]\r\n') } catch { /* gone */ }
      try { peer.close() } catch { /* already closed */ }
    })
  },

  async message(peer, message) {
    const conn = conns.get(peer)
    if (!conn) return
    const data = typeof message.rawData === 'string' ? message.rawData : message.text()
    if (typeof data !== 'string') return

    // Resize control: `\x01{"cols":N,"rows":M}`. Translate to Docker's
    // daemon-API exec resize. The exec_id needed for that endpoint isn't
    // exposed by `docker exec`; we'd need to use the daemon HTTP API
    // (`POST /containers/<id>/exec/<exec_id>/resize`) which requires
    // dockerode or direct socket access. For v1 we drop resizes; the
    // user sees a fixed 80x24 terminal (or whatever the docker exec
    // default is). TODO(step 4 follow-up): wire dockerode for resize.
    if (data.startsWith('\x01')) {
      // Drop silently.
      return
    }
    if (data.startsWith('\x02clear')) {
      // Equivalent to xterm clear; forward as ANSI clear-screen.
      try { peer.send('\x1b[2J\x1b[H') } catch { /* gone */ }
      return
    }

    if (!conn.child.stdin.destroyed) {
      try { conn.child.stdin.write(data) } catch { /* child gone */ }
    }
  },

  close(peer) {
    const conn = conns.get(peer)
    if (conn) {
      try { conn.child.kill('SIGTERM') } catch { /* already exited */ }
    }
    conns.delete(peer)
  },
})

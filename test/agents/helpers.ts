import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from '../../server/lib/dev-env/docker'
import { handleMeshMcpRequest } from '../../server/lib/mesh/server'
import { listAgentEvents } from '../../server/lib/repo'
import type { AgentEvent } from '~~/shared/types'

/** Everything this layer creates in Docker carries this, so a crashed run is sweepable. */
export const PREFIX = 'domo-agents-test-'

export interface MeshCall {
  method: string
  toolName: string | null
  authorization: string
}

export interface MeshHarness {
  server: Server
  port: number
  calls: MeshCall[]
  close: () => Promise<void>
}

/**
 * Domo's own mesh endpoint, on a real socket, in this process.
 *
 * It has to be *this* process: the token secret is `randomBytes(32)` at module
 * scope in `mesh/token.ts` and is never persisted, so a token minted here only
 * verifies here.
 *
 * Bound to `0.0.0.0`, and that is not a matter of taste. `host.docker.internal`
 * resolves to the host *gateway* address, so a server listening only on
 * `127.0.0.1` is not reachable from inside a container at all — the connection
 * is refused, and the symptom is an MCP server the agent says it cannot reach.
 */
export async function startMeshServer(): Promise<MeshHarness> {
  const calls: MeshCall[] = []
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith('/api/internal/mcp')) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    let parsed: any = null
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch { /* a non-JSON body is the transport's problem, not ours */ }
    calls.push({
      method: parsed?.method ?? '(unparsed)',
      toolName: parsed?.params?.name ?? null,
      authorization: String(request.headers.authorization ?? '')
    })

    const answer = await handleMeshMcpRequest(new Request(`http://mesh${request.url}`, {
      method: request.method,
      headers: Object.entries(request.headers).map(([k, v]) => [k, String(v)]) as [string, string][],
      body: body.length > 0 ? body : undefined
    }))
    response.writeHead(answer.status, Object.fromEntries(answer.headers))
    response.end(Buffer.from(await answer.arrayBuffer()))
  })

  const port: number = await new Promise((resolvePort) => {
    server.listen(0, '0.0.0.0', () => resolvePort((server.address() as any).port))
  })
  return {
    server,
    port,
    calls,
    close: () => new Promise<void>(done => server.close(() => done()))
  }
}

/** A committed checkout with a `.domo.json` that keeps the environment cheap. */
export async function fixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'domo-agents-repo-'))
  await run('git', ['init', '--quiet', '--initial-branch=main', repo])
  await writeFile(join(repo, 'README.md'), '# fixture\n')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'index.ts'), 'export {}\n')
  // `docker: false` keeps it unprivileged and quick: nothing here needs a nested
  // daemon, and DinD is already covered by the docker-live layer.
  await writeFile(join(repo, '.domo.json'), JSON.stringify({
    devEnvironment: { docker: false }
  }))
  for (const args of [
    ['add', '--all'],
    ['-c', 'user.name=Domo Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture']
  ]) {
    await run('git', ['-C', repo, ...args])
  }
  return repo
}

/** Wait for something the agent does asynchronously, without a fixed sleep. */
export async function until<T>(
  describe: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 180_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await probe().catch(() => null)
    if (found) return found as T
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${describe}`)
    }
    await new Promise(wait => setTimeout(wait, 500))
  }
}

export async function events(agentSessionId: string): Promise<AgentEvent[]> {
  return listAgentEvents(agentSessionId)
}

export async function eventsOfType(agentSessionId: string, type: string): Promise<AgentEvent[]> {
  return (await events(agentSessionId)).filter(event => event.type === type)
}

/** Everything the agent said this turn, in transcript order. */
export async function assistantText(agentSessionId: string): Promise<string> {
  return (await eventsOfType(agentSessionId, 'agent_message'))
    .map(event => String((event.payload as any)?.text ?? ''))
    .join('\n')
}

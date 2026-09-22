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
  /** Paths fetched by something that is not the MCP transport — i.e. a browser. */
  pageHits: string[]
  close: () => Promise<void>
}

/**
 * The page the browser test opens.
 *
 * Served by the same process for the same reason the mesh is: it needs to be
 * reachable from inside the container at a URL the test knows, and a fetch of
 * it is the proof that a real Chromium in there really loaded something. The
 * marker is the test's own, so there is no page content here that can churn.
 */
export const PROBE_MARKER = 'domo-browser-probe-ok'
const PROBE_PAGE = `<!doctype html><html><head><title>${PROBE_MARKER}</title></head>`
  + `<body><h1>${PROBE_MARKER}</h1></body></html>`

/**
 * Domo's own mesh endpoint, on a real socket, in this process.
 *
 * It has to be *this* process: the token secret is `randomBytes(32)` at module
 * scope in `mesh/token.ts` and is never persisted, so a token minted here only
 * verifies here.
 *
 * Bound to every interface, which is what makes this work in both topologies
 * a container can reach it from. On a Docker Desktop host,
 * `host.docker.internal` forwards to the host's IPv4 loopback — so `127.0.0.1`
 * is enough there, and binding `[::1]` alone is refused (measured). But when
 * the suite itself runs inside a dev environment, the agent's container is a
 * sibling under that environment's nested daemon and `host.docker.internal` is
 * the *bridge* gateway, not loopback: a server on `127.0.0.1` is then
 * unreachable and every test that needs the mesh fails with nothing to say why.
 * The wildcard covers both. It is an ephemeral port, for the length of one
 * run, and every request still needs a bearer minted in this process.
 */
export async function startMeshServer(): Promise<MeshHarness> {
  const calls: MeshCall[] = []
  const pageHits: string[] = []
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/probe')) {
      pageHits.push(request.url)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PROBE_PAGE)
      return
    }
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
    server.listen(0, () => resolvePort((server.address() as any).port))
  })
  return {
    server,
    port,
    calls,
    pageHits,
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
  // daemon, and DinD is already covered by the docker-live layer. Node comes
  // from the shared runtime volume, so the image only has to provide `git`.
  const { DEFAULT_IMAGE } = await import('../../server/lib/dev-env/config')
  await writeFile(join(repo, '.domo.json'), JSON.stringify({
    devEnvironment: { image: DEFAULT_IMAGE, docker: false, remoteUser: 'vscode' }
  }))
  for (const args of [
    ['add', '--all'],
    ['-c', 'user.name=Domo Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture']
  ]) {
    await run('git', ['-C', repo, ...args])
  }
  return repo
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

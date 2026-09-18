import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'

/**
 * A stand-in for ElectricSQL.
 *
 * Electric itself is a container attached to the developer's `domo` database,
 * not to the throwaway one a test runs against, so pointing the shape proxy at
 * this instead is the only way to exercise the proxy against a test database.
 * It answers like Electric does — gzipped body, protocol headers — which is
 * what the proxy has to get right.
 */
export interface ElectricStub {
  url: string
  /** Every request Electric received, newest last. */
  requests: URL[]
  close: () => Promise<void>
}

export async function startElectricStub(): Promise<ElectricStub> {
  const requests: URL[] = []

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://electric.test')
    requests.push(url)

    if (url.pathname === '/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'active' }))
      return
    }

    if (url.pathname !== '/v1/shape') {
      response.writeHead(404).end()
      return
    }

    const body = gzipSync(JSON.stringify([
      { headers: { operation: 'insert' }, key: '"public"."projects"/"prj_1"', value: { id: 'prj_1', name: 'api' } },
      { headers: { control: 'up-to-date' } }
    ]))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(body.byteLength),
      'electric-handle': '42-1700000000000',
      'electric-offset': '0_0',
      'electric-schema': '{}'
    })
    response.end(body)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

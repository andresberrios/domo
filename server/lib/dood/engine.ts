import { request as httpRequest } from 'node:http'

/**
 * A minimal Docker Engine API client over the daemon's unix socket.
 *
 * The proxy resolves references on the request path — which of the
 * environment's containers `web` means, whether a volume exists yet — so what
 * it asks the daemon has to cost a round trip on a local socket, not a
 * process spawn per question as `docker` CLI calls would. Only JSON in and
 * out; nothing here streams.
 */

export interface EngineResponse {
  status: number
  body: any
}

export interface EngineClient {
  request(method: string, path: string, body?: unknown): Promise<EngineResponse>
}

export class EngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** The answer, or an `EngineError` carrying the daemon's own message for anything but 2xx. */
export async function engineOk(engine: EngineClient, method: string, path: string, body?: unknown): Promise<any> {
  const response = await engine.request(method, path, body)
  if (response.status >= 200 && response.status < 300) return response.body
  const message = typeof response.body?.message === 'string' ? response.body.message : `HTTP ${response.status}`
  throw new EngineError(response.status, message)
}

const TIMEOUT_MS = 30_000

export function createEngineClient(socketPath: string): EngineClient {
  return {
    request(method, path, body) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
        const req = httpRequest({
          socketPath,
          method,
          path,
          headers: {
            Host: 'docker',
            ...(payload && { 'Content-Type': 'application/json', 'Content-Length': payload.length })
          },
          timeout: TIMEOUT_MS
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = text
            try {
              parsed = text ? JSON.parse(text) : null
            } catch { /* not JSON; the text is the answer */ }
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        })
        req.on('timeout', () => req.destroy(new Error(`Docker did not answer ${method} ${path} within ${TIMEOUT_MS / 1000} s`)))
        req.on('error', reject)
        req.end(payload)
      })
    }
  }
}

import { describe, expect, it } from 'vitest'

import {
  ChunkedDecoder,
  encodeChunk,
  parseRequestHead,
  renderLocalResponse,
  renderRequestHead,
  ResponseSplicer,
  type ResponseTransform
} from '../../server/lib/dood/http'

const head = (status: string, headers: string[]) => `HTTP/1.1 ${status}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}\r\n`

const jsonResponse = (body: unknown, status = '200 OK') => {
  const text = JSON.stringify(body)
  return head(status, ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(text)}`]) + text
}

const chunked = (status: string, pieces: string[], contentType = 'application/json') =>
  head(status, [`Content-Type: ${contentType}`, 'Transfer-Encoding: chunked'])
  + pieces.map(piece => encodeChunk(piece).toString('latin1')).join('') + '0\r\n\r\n'

/** Feeds `input` to a splicer in pieces of `size` bytes, and returns what the client received. */
function splice(
  input: string,
  expects: Array<{ method?: string, upgrade?: boolean, transform?: ResponseTransform }>,
  size = input.length,
  rewriteError?: (message: string) => string
) {
  const out: Buffer[] = []
  const splicer = new ResponseSplicer({ write: data => out.push(Buffer.from(data)), rewriteError })
  for (const pending of expects) splicer.expect({ method: pending.method ?? 'GET', upgrade: !!pending.upgrade, transform: pending.transform })
  const bytes = Buffer.from(input, 'latin1')
  for (let offset = 0; offset < bytes.length; offset += size) splicer.feed(bytes.subarray(offset, offset + size))
  splicer.end()
  return { text: Buffer.concat(out).toString('latin1'), splicer }
}

/** Every split point, one byte at a time and in odd sizes: framing must not depend on where a read ends. */
const SIZES = [1, 3, 7, 64, 100_000]

describe('request heads', () => {
  it('parses the version prefix, path and query, and renders them back', () => {
    const request = parseRequestHead('POST /v1.47/containers/create?name=web HTTP/1.1\r\nHost: docker\r\nContent-Length: 2')!
    expect(request).toMatchObject({ method: 'POST', path: '/containers/create', version: '/v1.47' })
    expect(request.query.get('name')).toBe('web')
    request.query.set('name', 'env_x-web')
    expect(renderRequestHead(request, 10)).toBe(
      'POST /v1.47/containers/create?name=env_x-web HTTP/1.1\r\nHost: docker\r\nContent-Length: 10\r\n\r\n'
    )
  })

  it('keeps a streamed body\'s own framing', () => {
    const request = parseRequestHead('POST /build HTTP/1.1\r\nTransfer-Encoding: chunked')!
    expect(request.version).toBe('')
    expect(renderRequestHead(request, null)).toBe('POST /build HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n')
  })

  it('refuses what is not a request line', () => {
    expect(parseRequestHead('garbage')).toBeNull()
  })
})

describe('ChunkedDecoder', () => {
  it('decodes across any split, and stops after the trailers', () => {
    const body = `${encodeChunk('hello ').toString('latin1')}${encodeChunk('world').toString('latin1')}0\r\nX-Trailer: 1\r\n\r\nNEXT`
    for (const size of SIZES) {
      const decoder = new ChunkedDecoder()
      const data: Buffer[] = []
      let pending = Buffer.alloc(0)
      let consumedTotal = 0
      const bytes = Buffer.from(body, 'latin1')
      for (let offset = 0; offset < bytes.length && !decoder.done; offset += size) {
        pending = Buffer.concat([pending, bytes.subarray(offset, offset + size)])
        const result = decoder.push(pending)
        data.push(...result.data)
        consumedTotal += result.consumed
        pending = pending.subarray(result.consumed)
      }
      expect(Buffer.concat(data).toString()).toBe('hello world')
      expect(decoder.done).toBe(true)
      // Exactly the body, not a byte of what follows it.
      expect(consumedTotal).toBe(body.length - 'NEXT'.length)
    }
  })
})

describe('ResponseSplicer', () => {
  it('passes an untransformed response through byte for byte', () => {
    const input = chunked('200 OK', ['{"a":1}', '{"b":2}']) + jsonResponse({ c: 3 })
    for (const size of SIZES) expect(splice(input, [{}, {}], size).text).toBe(input)
  })

  it('rewrites a JSON body and restates its length', () => {
    const transform = { json: (body: any) => ({ ...body, Name: 'web' }) }
    for (const size of SIZES) {
      const { text } = splice(jsonResponse({ Name: 'env_x-web' }), [{ transform }], size)
      expect(text).toBe(jsonResponse({ Name: 'web' }).replace(/Content-Length: \d+/, 'Content-Length: 15') + '\n')
    }
  })

  it('rewrites a chunked JSON body into a length-delimited one', () => {
    const transform = { json: () => ['ok'] }
    const { text } = splice(chunked('200 OK', ['[1,', '2]']), [{ transform }])
    expect(text).toBe(head('200 OK', ['Content-Type: application/json', 'Content-Length: 7']) + '["ok"]\n')
  })

  it('strips names out of every JSON error, transform or not', () => {
    const { text } = splice(
      chunked('404 Not Found', ['{"message":"No such container: env_x-web"}']),
      [{}],
      5,
      message => message.replace('env_x-', '')
    )
    expect(text).toContain('{"message":"No such container: web"}')
    expect(text).toContain('Content-Length: 37')
    expect(text).not.toContain('chunked')
  })

  it('does not hand an error body to a success transform', () => {
    let called = false
    splice(jsonResponse({ message: 'nope' }, '500 Internal Server Error'), [{ transform: { json: () => { called = true } } }])
    expect(called).toBe(false)
  })

  it('rewrites an event stream line by line, dropping lines, across chunk boundaries', () => {
    const events = ['{"id":"a"}\n{"id":"b"}\n{"id', '":"c"}\n']
    const transform = { line: (event: any) => event.id === 'b' ? null : { ...event, seen: true } }
    for (const size of SIZES) {
      const { text } = splice(chunked('200 OK', events), [{ transform }], size)
      const body = text.slice(text.indexOf('\r\n\r\n') + 4)
      const decoder = new ChunkedDecoder()
      const decoded = Buffer.concat(decoder.push(Buffer.from(body, 'latin1')).data).toString()
      expect(decoder.done).toBe(true)
      expect(decoded).toBe('{"id":"a","seen":true}\n{"id":"c","seen":true}\n')
    }
  })

  it('knows HEAD, 204 and 304 have no body, whatever their headers say', () => {
    const input = head('200 OK', ['Content-Length: 50']) + head('204 No Content', []) + head('304 Not Modified', [])
      + jsonResponse({ after: true })
    let seen: unknown = null
    const { text } = splice(input, [{ method: 'HEAD' }, {}, {}, { transform: { json: body => (seen = body) } }], 1)
    expect(seen).toEqual({ after: true })
    expect(text.startsWith(head('200 OK', ['Content-Length: 50']))).toBe(true)
  })

  it('passes an interim 100 and still frames the real response', () => {
    let seen: unknown = null
    const input = head('100 Continue', []) + jsonResponse({ ok: 1 })
    splice(input, [{ transform: { json: body => (seen = body) } }])
    expect(seen).toEqual({ ok: 1 })
  })

  it('becomes a raw pipe after 101, and never parses what follows', () => {
    const upgrade = head('101 UPGRADED', ['Content-Type: application/vnd.docker.raw-stream', 'Connection: Upgrade', 'Upgrade: tcp'])
    const input = `${upgrade}HTTP/1.1 this is container output\r\n\r\n`
    for (const size of SIZES) {
      const result = splice(input, [{ method: 'POST', upgrade: true }], size)
      expect(result.text).toBe(input)
      expect(result.splicer.isRaw).toBe(true)
    }
  })

  it('treats a hijack answered 200 with no framing as a raw stream', () => {
    const input = `${head('200 OK', ['Content-Type: application/vnd.docker.raw-stream'])}raw bytes`
    const result = splice(input, [{ method: 'POST', upgrade: true }])
    expect(result.text).toBe(input)
    expect(result.splicer.isRaw).toBe(true)
  })

  it('still frames a hijack the daemon refused, so its error reaches the client', () => {
    const { text } = splice(jsonResponse({ message: 'No such container: env_x-web' }, '404 Not Found'),
      [{ method: 'POST', upgrade: true }], 4, message => message.replace('env_x-', ''))
    expect(text).toContain('No such container: web')
  })

  it('delivers a local answer in order, after the response still arriving', () => {
    const out: string[] = []
    const splicer = new ResponseSplicer({ write: data => out.push(data.toString('latin1')) })
    splicer.expect({ method: 'GET', upgrade: false })
    const first = jsonResponse({ first: true })
    const cut = first.length - 3
    splicer.feed(Buffer.from(first.slice(0, cut), 'latin1'))
    splicer.answer(renderLocalResponse(403, { message: 'Domo: no' }))
    expect(out.join('')).toBe(first.slice(0, cut))
    splicer.feed(Buffer.from(first.slice(cut), 'latin1'))
    expect(out.join('')).toBe(first + renderLocalResponse(403, { message: 'Domo: no' }).toString('latin1'))
  })

  it('writes a local answer at once when nothing is in flight', () => {
    const out: string[] = []
    const splicer = new ResponseSplicer({ write: data => out.push(data.toString('latin1')) })
    splicer.answer(renderLocalResponse(403, { message: 'Domo: no' }))
    expect(out.join('')).toContain('HTTP/1.1 403 Forbidden')
    expect(out.join('')).toContain('{"message":"Domo: no"}')
  })

  it('runs `after` once the response is through', async () => {
    const statuses: number[] = []
    splice(head('204 No Content', []) + jsonResponse({}), [
      { transform: { after: status => { statuses.push(status) } } },
      { transform: { after: status => { statuses.push(status) } } }
    ])
    await new Promise(resolve => setImmediate(resolve))
    expect(statuses).toEqual([204, 200])
  })

  it('hands back the original body when a transform throws', () => {
    const errors: unknown[] = []
    const out: Buffer[] = []
    const splicer = new ResponseSplicer({ write: data => out.push(data), onError: error => errors.push(error) })
    splicer.expect({ method: 'GET', upgrade: false, transform: { json: () => { throw new Error('boom') } } })
    splicer.feed(Buffer.from(jsonResponse({ a: 1 }), 'latin1'))
    expect(Buffer.concat(out).toString()).toContain('{"a":1}')
    expect(errors).toHaveLength(1)
  })

  it('rewrites a streamed body of any type, re-sending it chunked, across any split', () => {
    // A stand-in for the archive rewriter: every byte upper-cased, and a marker at the end.
    const stream = () => ({ push: (chunk: Buffer) => Buffer.from(chunk.toString('latin1').toUpperCase(), 'latin1'), end: () => Buffer.from('!') })
    const archive = 'tar bytes '.repeat(50)
    for (const [input, framing] of [
      [`${head('200 OK', ['Content-Type: application/x-tar', `Content-Length: ${archive.length}`])}${archive}`, 'length'],
      [chunked('200 OK', [archive.slice(0, 7), archive.slice(7)], 'application/x-tar'), 'chunked']
    ] as const) {
      for (const size of SIZES) {
        const { text } = splice(input + jsonResponse({ next: true }), [{ transform: { stream } }, {}], size)
        const [responseHead = '', rest = ''] = [text.slice(0, text.indexOf('\r\n\r\n') + 4), text.slice(text.indexOf('\r\n\r\n') + 4)]
        expect(responseHead, framing).toContain('Transfer-Encoding: chunked')
        expect(responseHead).not.toContain('Content-Length')
        const decoder = new ChunkedDecoder()
        const { data, consumed } = decoder.push(Buffer.from(rest, 'latin1'))
        expect(decoder.done).toBe(true)
        expect(Buffer.concat(data).toString()).toBe(`${archive.toUpperCase()}!`)
        // The next response is framed as usual after it.
        expect(rest.slice(consumed)).toBe(jsonResponse({ next: true }))
      }
    }
  })

  it('leaves an error to a streamed request as it is', () => {
    const stream = () => ({ push: () => Buffer.from('X'), end: () => Buffer.alloc(0) })
    const input = jsonResponse({ message: 'No such image: app' }, '404 Not Found')
    expect(splice(input, [{ transform: { stream } }]).text).toBe(input)
  })

  it('hands an upgraded connection over on 101, with the bytes read past the head', () => {
    const handed: Buffer[] = []
    let hijacked = 0
    const out: Buffer[] = []
    const hijack = () => { hijacked++ }
    const splicer = new ResponseSplicer({
      write: data => out.push(Buffer.from(data)),
      onHijack: (fn, rest) => { handed.push(rest); fn(null as any, null as any) }
    })
    splicer.expect({ method: 'POST', upgrade: true, transform: { hijack } })
    const upgrade = head('101 Switching Protocols', ['Connection: Upgrade', 'Upgrade: h2c'])
    splicer.feed(Buffer.from(`${upgrade}PRI * HTTP/2.0`, 'latin1'))
    splicer.feed(Buffer.from('more h2 bytes', 'latin1'))
    expect(Buffer.concat(out).toString('latin1')).toBe(upgrade)
    expect(hijacked).toBe(1)
    expect(handed.map(bytes => bytes.toString())).toEqual(['PRI * HTTP/2.0'])
  })

  it('says so when a connection it would have taken over was refused the upgrade', () => {
    let declined = 0
    const out: Buffer[] = []
    const splicer = new ResponseSplicer({ write: data => out.push(data), onHijack: () => { throw new Error('not upgraded') }, onHijackDeclined: () => { declined++ } })
    splicer.expect({ method: 'POST', upgrade: true, transform: { hijack: () => {} } })
    splicer.feed(Buffer.from(jsonResponse({ message: 'no' }, '400 Bad Request'), 'latin1'))
    expect(declined).toBe(1)
    expect(Buffer.concat(out).toString()).toContain('{"message":"no"}')
  })
})

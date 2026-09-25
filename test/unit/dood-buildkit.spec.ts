import { describe, expect, it } from 'vitest'

import {
  rewriteSolveRequest,
  rewriteSolveResponse,
  rewriteStatus,
  solveResponseEntries
} from '../../server/lib/dood/buildkit'
import {
  decodeMapEntry,
  decodeMessage,
  encodeBytesField,
  encodeMapEntry,
  encodeVarint,
  encodeVarintField,
  GrpcMessageReader,
  grpcFrame,
  rewriteStrings
} from '../../server/lib/dood/protobuf'

/**
 * The protobuf edits the build bridge makes, on the wire bytes: what it
 * changes, and — as much the point — that every byte it does not change
 * comes out exactly as it went in.
 */

const bytes = encodeBytesField
const map = encodeMapEntry
const cat = (...parts: Buffer[]) => Buffer.concat(parts)

/** A field number no BuildKit has, to stand for one a newer BuildKit adds. */
const unknownField = (field: number) => bytes(field, Buffer.from([0x08, 0x96, 0x01, 0xff]))

const exporter = (type: string, attrs: Record<string, string>) =>
  bytes(13, cat(bytes(1, type), ...Object.entries(attrs).map(([key, value]) => map(2, key, value))))

function exporters(message: Buffer) {
  return decodeMessage(message).filter(field => field.field === 13).map((field) => {
    const inner = decodeMessage(field.value as Buffer)
    return {
      type: (inner.find(entry => entry.field === 1)!.value as Buffer).toString(),
      attrs: Object.fromEntries(inner.filter(entry => entry.field === 2).map(entry => decodeMapEntry(entry.value as Buffer)))
    }
  })
}

const naming = { privateName: (name: string) => `priv/${name}` }
const RULE = { from: '^docker-image://docker\\.io/library/app:dev(@sha256:[a-f0-9]{64})?$', to: 'docker-image://docker.io/priv/app:dev${1}' }

describe('the protobuf wire format', () => {
  it('decodes a message into fields that re-encode to the same bytes', () => {
    const message = cat(
      bytes(1, 'ref'),
      encodeVarintField(2, 300),
      encodeVarintField(16, 2 ** 40),
      Buffer.from([0x19, 1, 2, 3, 4, 5, 6, 7, 8]), // field 3, fixed64
      Buffer.from([0x25, 1, 2, 3, 4]), // field 4, fixed32
      unknownField(99)
    )
    const fields = decodeMessage(message)
    expect(fields.map(field => field.field)).toEqual([1, 2, 16, 3, 4, 99])
    expect(fields[2]!.value).toBe(2 ** 40)
    expect(Buffer.concat(fields.map(field => field.raw)).equals(message)).toBe(true)
    expect(encodeVarint(0)).toEqual(Buffer.from([0]))
  })

  it('refuses a truncated message instead of guessing', () => {
    expect(() => decodeMessage(Buffer.from([0x0a, 0x05, 0x61]))).toThrow(/truncated/)
    expect(() => decodeMessage(Buffer.from([0x08, 0x80]))).toThrow(/truncated/)
  })

  it('rewrites strings only where told, and returns the very same buffer when nothing changed', () => {
    const message = cat(bytes(1, cat(bytes(3, 'keep me'), bytes(7, 'name-x'))), unknownField(42), bytes(2, 'name-x'))
    const same = rewriteStrings(message, { 1: { 3: true } }, text => text.replace('name-x', 'y'))
    expect(same).toBe(message)
    const changed = rewriteStrings(message, { 1: { 7: true }, 2: true }, text => text.replace('name-x', 'y'))
    const fields = decodeMessage(changed)
    expect(decodeMessage(fields[0]!.value as Buffer).map(field => (field.value as Buffer).toString())).toEqual(['keep me', 'y'])
    expect(fields[1]!.raw.equals(unknownField(42))).toBe(true)
    expect((fields[2]!.value as Buffer).toString()).toBe('y')
  })

  it('splits a gRPC stream into messages wherever a read ends', () => {
    const messages = [Buffer.from('one'), Buffer.alloc(0), Buffer.alloc(70_000, 7)]
    const stream = Buffer.concat(messages.map(grpcFrame))
    for (const size of [1, 4, 5, 6, 1000, stream.length]) {
      const reader = new GrpcMessageReader()
      const out: Buffer[] = []
      for (let offset = 0; offset < stream.length; offset += size) {
        out.push(...reader.push(stream.subarray(offset, offset + size)).map(entry => entry.message))
      }
      expect(out.map(message => message.toString('hex'))).toEqual(messages.map(message => message.toString('hex')))
      expect(reader.pending).toBe(0)
    }
  })
})

describe('Control/Solve requests', () => {
  const frontendAttrs = cat(map(7, 'filename', 'Dockerfile'), map(7, 'image-resolve-mode', 'local'))

  it('makes a stored image\'s names private and leaves every other field byte for byte', () => {
    const message = cat(bytes(1, 'buildref'), frontendAttrs, exporter('moby', { name: 'app:dev,app:latest', unpack: 'true' }), unknownField(99))
    const edit = rewriteSolveRequest(message, naming, [])
    expect(edit.renamed).toEqual(['app:dev', 'app:latest'])
    expect(edit.pushed).toEqual([])
    expect(exporters(edit.message)).toEqual([{ type: 'moby', attrs: { name: 'priv/app:dev,priv/app:latest', unpack: 'true' } }])
    const before = decodeMessage(message)
    const after = decodeMessage(edit.message)
    expect(after.map(field => field.field)).toEqual(before.map(field => field.field))
    for (const [index, field] of before.entries()) {
      if (field.field !== 13) expect(after[index]!.raw.equals(field.raw)).toBe(true)
    }
  })

  it('keeps a pushed name for the registry, and leaves exporters that write a file for the client alone', () => {
    const message = cat(
      exporter('image', { name: 'localhost:5000/app:1', push: 'true' }),
      exporter('oci', { name: 'app:dev', dest: '/out.tar' }),
      exporter('local', { dest: '/out' })
    )
    const edit = rewriteSolveRequest(message, naming, [])
    expect(edit.pushed).toEqual(['localhost:5000/app:1'])
    expect(edit.renamed).toEqual([])
    expect(edit.message).toBe(message)
  })

  it('renames the deprecated single exporter an older client sends', () => {
    const message = cat(bytes(3, 'moby'), map(4, 'name', 'app:dev'), map(4, 'unpack', 'true'), bytes(5, 'session'))
    const edit = rewriteSolveRequest(message, naming, [])
    const attrs = decodeMessage(edit.message).filter(field => field.field === 4).map(field => decodeMapEntry(field.value as Buffer))
    expect(attrs).toEqual([['name', 'priv/app:dev'], ['unpack', 'true']])
    expect((decodeMessage(edit.message).at(-1)!.value as Buffer).toString()).toBe('session')
  })

  it('adds a source policy converting the private names, after the client\'s own rules', () => {
    const plain = rewriteSolveRequest(cat(bytes(1, 'ref')), naming, [RULE])
    const policy = decodeMessage(decodeMessage(plain.message).find(field => field.field === 12)!.value as Buffer)
    expect(policy[0]).toMatchObject({ field: 1, value: 1 })
    const rule = decodeMessage(policy[1]!.value as Buffer)
    expect(rule[0]).toMatchObject({ field: 1, value: 2 }) // CONVERT
    const selector = decodeMessage(rule[1]!.value as Buffer)
    expect((selector[0]!.value as Buffer).toString()).toBe(RULE.from)
    expect(selector[1]).toMatchObject({ field: 2, value: 2 }) // REGEX
    expect((decodeMessage(rule[2]!.value as Buffer)[0]!.value as Buffer).toString()).toBe(RULE.to)

    const clientRule = bytes(2, cat(encodeVarintField(1, 1), bytes(2, bytes(1, 'docker-image://docker.io/library/evil:1'))))
    const theirs = cat(bytes(12, cat(encodeVarintField(1, 1), clientRule)), bytes(1, 'ref'))
    const merged = decodeMessage(rewriteSolveRequest(theirs, naming, [RULE]).message)
    expect(merged.filter(field => field.field === 12)).toHaveLength(1)
    const rules = decodeMessage(merged[0]!.value as Buffer).filter(field => field.field === 2)
    expect(rules).toHaveLength(2)
    expect(rules[0]!.raw.equals(clientRule)).toBe(true)
  })

  it('returns the very same message when there is nothing to change', () => {
    const message = cat(bytes(1, 'ref'), frontendAttrs)
    expect(rewriteSolveRequest(message, naming, []).message).toBe(message)
  })

  it('fails the way the naming says when a name cannot be made private', () => {
    const refuse = { privateName: () => { throw new Error('no private name') } }
    expect(() => rewriteSolveRequest(exporter('moby', { name: '[::1]:5000/app' }), refuse, [])).toThrow('no private name')
  })
})

describe('what a build answers', () => {
  const unprivate = (text: string) => text.replaceAll('docker.io/priv/', 'docker.io/library/')

  it('puts the name back in the solve response, inside base64 JSON too', () => {
    const descriptor = Buffer.from(JSON.stringify({ annotations: { name: 'docker.io/priv/app:dev' } })).toString('base64')
    const message = cat(
      map(1, 'image.name', 'docker.io/priv/app:dev'),
      map(1, 'containerimage.config.digest', `sha256:${'d'.repeat(64)}`),
      map(1, 'containerimage.descriptor', descriptor),
      map(1, 'opaque', Buffer.from('not json at all').toString('base64'))
    )
    const out = solveResponseEntries(rewriteSolveResponse(message, unprivate))
    expect(out.get('image.name')).toBe('docker.io/library/app:dev')
    expect(out.get('containerimage.config.digest')).toBe(`sha256:${'d'.repeat(64)}`)
    expect(JSON.parse(Buffer.from(out.get('containerimage.descriptor')!, 'base64').toString())).toEqual({ annotations: { name: 'docker.io/library/app:dev' } })
    expect(out.get('opaque')).toBe(Buffer.from('not json at all').toString('base64'))
  })

  it('puts it back in every progress string, and nowhere a number is', () => {
    const vertex = bytes(1, cat(bytes(1, 'sha256:vertex'), bytes(3, '[1/2] FROM docker.io/priv/app:dev'), encodeVarintField(4, 1), bytes(7, 'docker.io/priv/app:dev: not found')))
    const status = bytes(2, cat(bytes(1, 'naming to docker.io/priv/app:dev'), bytes(2, 'sha256:vertex'), bytes(3, 'docker.io/priv/app:dev')))
    const log = bytes(3, cat(bytes(1, 'sha256:vertex'), encodeVarintField(3, 1), bytes(4, 'pulling docker.io/priv/app:dev\n')))
    const warning = bytes(4, cat(bytes(1, 'v'), bytes(3, 'short docker.io/priv/app:dev'), bytes(4, 'detail docker.io/priv/app:dev'), unknownField(9)))
    const message = cat(vertex, status, log, warning)
    const out = rewriteStatus(message, unprivate)
    expect(out.toString('latin1')).not.toContain('priv/')
    expect(out.toString('latin1')).toContain('[1/2] FROM docker.io/library/app:dev')
    // The digests, the `cached` flag, the log's stream number and an unknown field are as they were.
    const logFields = decodeMessage(decodeMessage(out)[2]!.value as Buffer)
    expect(logFields[1]).toMatchObject({ field: 3, value: 1 })
    expect(decodeMessage(decodeMessage(out)[3]!.value as Buffer).at(-1)!.raw.equals(unknownField(9))).toBe(true)
    // Nothing to put back: the same buffer.
    const clean = cat(bytes(1, bytes(3, 'RUN true')))
    expect(rewriteStatus(clean, unprivate)).toBe(clean)
  })
})

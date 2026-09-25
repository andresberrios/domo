/**
 * Just enough of the protobuf wire format to change a few fields of a message
 * and leave every other byte exactly as it came.
 *
 * The bridge in `grpc-bridge.ts` edits three BuildKit messages and nothing
 * else, so a code generator and a copy of BuildKit's `.proto` files would be
 * a lot of machinery for a handful of field numbers. Decoding keeps each
 * field's raw bytes, and an edit re-encodes only the field it touches: a
 * field this file has never heard of — a newer BuildKit's — survives a round
 * trip byte for byte, which is the property the tests pin.
 *
 * Pure: no I/O.
 */

export interface Field {
  field: number
  wire: number
  /** A varint's value (lengths and enums — nothing here needs more than 2^53), or a length-delimited field's bytes. */
  value: number | Buffer
  /** The whole field as it was encoded, key included. */
  raw: Buffer
}

export const WIRE_VARINT = 0
export const WIRE_LEN = 2

function readVarint(buf: Buffer, start: number): [number, number] {
  let result = 0
  let multiplier = 1
  let pos = start
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated protobuf varint')
    const byte = buf[pos++]!
    result += (byte & 0x7f) * multiplier
    if (!(byte & 0x80)) return [result, pos]
    multiplier *= 128
    if (pos - start > 10) throw new Error('malformed protobuf varint')
  }
}

export function encodeVarint(value: number): Buffer {
  const out: number[] = []
  let rest = value
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest) byte |= 0x80
    out.push(byte)
  } while (rest)
  return Buffer.from(out)
}

/** Top-level fields of a message, in order. */
export function decodeMessage(buf: Buffer): Field[] {
  const fields: Field[] = []
  let pos = 0
  while (pos < buf.length) {
    const start = pos
    let key: number
    ;[key, pos] = readVarint(buf, pos)
    const field = Math.floor(key / 8)
    const wire = key & 7
    let value: number | Buffer
    if (wire === WIRE_VARINT) {
      ;[value, pos] = readVarint(buf, pos)
    } else if (wire === WIRE_LEN) {
      let length: number
      ;[length, pos] = readVarint(buf, pos)
      if (pos + length > buf.length) throw new Error('truncated protobuf field')
      value = buf.subarray(pos, pos + length)
      pos += length
    } else if (wire === 1) {
      value = buf.subarray(pos, pos + 8)
      pos += 8
    } else if (wire === 5) {
      value = buf.subarray(pos, pos + 4)
      pos += 4
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
    if (pos > buf.length) throw new Error('truncated protobuf field')
    fields.push({ field, wire, value, raw: buf.subarray(start, pos) })
  }
  return fields
}

export function encodeBytesField(field: number, bytes: Buffer | string): Buffer {
  const body = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  return Buffer.concat([encodeVarint(field * 8 + WIRE_LEN), encodeVarint(body.length), body])
}

export function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field * 8 + WIRE_VARINT), encodeVarint(value)])
}

export const bytesOf = (field: Field): Buffer | null => field.wire === WIRE_LEN ? field.value as Buffer : null

/** A `map<string, string>` entry: `{ 1: key, 2: value }`. */
export function decodeMapEntry(entry: Buffer): [string, string] {
  let key = ''
  let value = ''
  for (const field of decodeMessage(entry)) {
    const bytes = bytesOf(field)
    if (!bytes) continue
    if (field.field === 1) key = bytes.toString('utf8')
    if (field.field === 2) value = bytes.toString('utf8')
  }
  return [key, value]
}

export function encodeMapEntry(field: number, key: string, value: string): Buffer {
  return encodeBytesField(field, Buffer.concat([encodeBytesField(1, key), encodeBytesField(2, value)]))
}

/**
 * Every string at the given paths rewritten. `paths` maps a field number to
 * `true` (a string or bytes field to pass through `rewrite`) or to a nested
 * map (a message field to recurse into). Fields not named are left verbatim,
 * and so is a message whose strings all came back unchanged.
 */
export type StringPaths = { [field: number]: true | StringPaths }

export function rewriteStrings(message: Buffer, paths: StringPaths, rewrite: (text: string) => string): Buffer {
  let changed = false
  const parts = decodeMessage(message).map((field) => {
    const rule = paths[field.field]
    const bytes = bytesOf(field)
    if (!rule || !bytes) return field.raw
    let next: Buffer
    if (rule === true) {
      const text = bytes.toString('utf8')
      const rewritten = rewrite(text)
      if (rewritten === text) return field.raw
      next = Buffer.from(rewritten, 'utf8')
    } else {
      next = rewriteStrings(bytes, rule, rewrite)
      if (next === bytes) return field.raw
    }
    changed = true
    return encodeBytesField(field.field, next)
  })
  return changed ? Buffer.concat(parts) : message
}

/** A gRPC length-prefixed message: one byte of flags (0: uncompressed), four of length. */
export function grpcFrame(message: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(message.length, 1)
  return Buffer.concat([head, message])
}

/**
 * Splits a gRPC byte stream into messages. `push` returns every message
 * completed so far; a compressed one (flag 1) is returned as it is, flagged,
 * since nothing here can read it.
 */
export class GrpcMessageReader {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Array<{ compressed: boolean, message: Buffer }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: Array<{ compressed: boolean, message: Buffer }> = []
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1)
      if (this.buffer.length < 5 + length) break
      out.push({ compressed: this.buffer[0] === 1, message: this.buffer.subarray(5, 5 + length) })
      this.buffer = this.buffer.subarray(5 + length)
    }
    return out
  }

  get pending(): number {
    return this.buffer.length
  }
}

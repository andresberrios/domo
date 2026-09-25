/**
 * A streaming tar rewriter for image archives (`docker save` out, `docker
 * load` in): the three small files in an archive that *name* images —
 * `index.json`, `manifest.json` and `repositories` — are rewritten; every
 * other entry, the layers included, streams through untouched and unbuffered.
 *
 * Those three are the only places a name lives. Every blob is
 * content-addressed, so none of them can carry a name without changing its
 * own digest, and none of them needs to.
 *
 * A tar is a sequence of 512-byte headers, each followed by its data padded
 * to 512 bytes. A rewritten entry gets a new header — its size and checksum
 * restated — and everything else is forwarded byte for byte, which is what
 * lets a multi-gigabyte archive pass without being held.
 *
 * Pure (a push/end transform over buffers): no I/O.
 */

import type { StreamTransform } from './http'

const BLOCK = 512
/** Beyond this an entry is not the metadata it is named like, and is left alone. */
const MAX_REWRITTEN = 8 * 1024 * 1024
const NAMED_FILES = new Set(['index.json', 'manifest.json', 'repositories'])

export interface ArchiveNames {
  /** The JSON of `index.json` / `manifest.json` / `repositories`, rewritten. `null` leaves the entry as it was. */
  rewrite(file: 'index.json' | 'manifest.json' | 'repositories', json: unknown): unknown | null
}

function readOctal(field: Buffer): number {
  // GNU base-256 for sizes past 8 GiB: high bit set, the rest big-endian.
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f
    for (let index = 1; index < field.length; index++) value = value * 256 + field[index]!
    return value
  }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim()
  return text ? Number.parseInt(text, 8) : 0
}

function entryName(header: Buffer): string {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
  const magic = header.subarray(257, 263).toString('latin1')
  const prefix = magic.startsWith('ustar') ? header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : ''
  return prefix ? `${prefix}/${name}` : name
}

/** A copy of `header` with its size set and its checksum recomputed. */
function withSize(header: Buffer, size: number): Buffer {
  const out = Buffer.from(header)
  out.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
  out.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of out) sum += byte
  out.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return out
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK

/** The `key=value` records of a PAX header. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10)
    if (!Number.isInteger(length) || length <= 0) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

export function archiveRewriter(names: ArchiveNames, onError?: (error: unknown) => void): StreamTransform {
  let buffer: Buffer = Buffer.alloc(0)
  /** What the current entry's data is being used for. */
  let state:
    | { kind: 'header' }
    | { kind: 'pass', remaining: number }
    | { kind: 'meta', header: Buffer, size: number, type: 'x' | 'g' | 'L' }
    | { kind: 'rewrite', header: Buffer, size: number, file: string }
    | { kind: 'trailer' } = { kind: 'header' }
  /** Set by a PAX or GNU long-name header, for the entry after it. */
  let nextName: string | null = null
  let nextSizeOverridden = false

  const step = (out: Buffer[]): boolean => {
    if (state.kind === 'trailer') {
      out.push(buffer)
      buffer = Buffer.alloc(0)
      return false
    }
    if (state.kind === 'pass') {
      const take = Math.min(state.remaining, buffer.length)
      if (!take) return false
      out.push(buffer.subarray(0, take))
      buffer = buffer.subarray(take)
      state.remaining -= take
      if (!state.remaining) state = { kind: 'header' }
      return true
    }
    if (state.kind === 'meta' || state.kind === 'rewrite') {
      const total = state.size + padding(state.size)
      if (buffer.length < total) return false
      const data = buffer.subarray(0, state.size)
      const block = buffer.subarray(0, total)
      buffer = buffer.subarray(total)
      if (state.kind === 'meta') {
        out.push(state.header, block)
        // A global header (`g`) sets defaults for every entry, which is no entry's own name.
        if (state.type === 'x') {
          const records = paxRecords(data)
          if (records.has('path')) nextName = records.get('path')!
          if (records.has('size')) nextSizeOverridden = true
        } else if (state.type === 'L') {
          nextName = data.toString('utf8').replace(/\0.*$/s, '')
        }
        state = { kind: 'header' }
        return true
      }
      const file = state.file as 'index.json' | 'manifest.json' | 'repositories'
      let replaced: Buffer | null = null
      try {
        const rewritten = names.rewrite(file, JSON.parse(data.toString('utf8')))
        if (rewritten !== null) replaced = Buffer.from(JSON.stringify(rewritten), 'utf8')
      } catch (error) {
        onError?.(error)
      }
      if (replaced && !replaced.equals(data)) {
        out.push(withSize(state.header, replaced.length), replaced, Buffer.alloc(padding(replaced.length)))
      } else {
        out.push(state.header, block)
      }
      state = { kind: 'header' }
      return true
    }

    if (buffer.length < BLOCK) return false
    const header = buffer.subarray(0, BLOCK)
    buffer = buffer.subarray(BLOCK)
    if (header.every(byte => byte === 0)) {
      // End of archive: two zero blocks and whatever padding follows.
      out.push(header)
      state = { kind: 'trailer' }
      return true
    }
    const size = readOctal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156]!)
    if (type === 'x' || type === 'g' || type === 'L') {
      state = { kind: 'meta', header, size, type }
      return true
    }
    const name = (nextName ?? entryName(header)).replace(/^\.\//, '')
    const sizeOverridden = nextSizeOverridden
    nextName = null
    nextSizeOverridden = false
    const regular = type === '0' || type === '\0' || type === '7'
    if (regular && NAMED_FILES.has(name) && size <= MAX_REWRITTEN && !sizeOverridden) {
      state = { kind: 'rewrite', header, size, file: name }
      return true
    }
    out.push(header)
    const remaining = size + padding(size)
    state = remaining ? { kind: 'pass', remaining } : { kind: 'header' }
    return true
  }

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      const out: Buffer[] = []
      while (buffer.length && step(out)) { /* consume what can be */ }
      return Buffer.concat(out)
    },
    end() {
      // A truncated archive: hand back what was held; the daemon reports it.
      const rest = buffer
      buffer = Buffer.alloc(0)
      if (state.kind === 'meta' || state.kind === 'rewrite') return Buffer.concat([state.header, rest])
      return rest
    }
  }
}

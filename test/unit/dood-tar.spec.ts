import { describe, expect, it } from 'vitest'

import { archiveRewriter, type ArchiveNames } from '../../server/lib/dood/tar'

/**
 * The image-archive rewriter on real tar bytes: the three files that name
 * images are rewritten with a valid header, everything else passes byte for
 * byte, and none of it depends on where a read happens to end.
 */

function header(name: string, size: number, type = '0', options: { prefix?: string, base256?: boolean } = {}): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100, 8, 'latin1')
  block.write('0000000\0', 108, 8, 'latin1')
  block.write('0000000\0', 116, 8, 'latin1')
  if (options.base256) {
    block[124] = 0x80
    block.writeUIntBE(size, 136 - 6, 6)
  } else {
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
  }
  block.write('00000000000\0', 136, 12, 'latin1')
  block.write(type, 156, 1, 'latin1')
  block.write('ustar\0', 257, 6, 'latin1')
  block.write('00', 263, 2, 'latin1')
  if (options.prefix) block.write(options.prefix, 345, 155, 'utf8')
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return block
}

const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
const entry = (name: string, data: Buffer | string, type = '0', options = {}) => {
  const body = typeof data === 'string' ? Buffer.from(data) : data
  return Buffer.concat([header(name, body.length, type, options), pad(body)])
}
const pax = (records: Record<string, string>) => {
  const body = Object.entries(records).map(([key, value]) => {
    const text = ` ${key}=${value}\n`
    let length = text.length + 1
    length = text.length + String(length).length
    return `${length}${text}`
  }).join('')
  return entry('PaxHeaders/x', body, 'x')
}
const END = Buffer.alloc(1024)

/** Every entry of an archive: name, and data. Checks every header's checksum on the way. */
function entries(archive: Buffer): Array<{ name: string, data: Buffer }> {
  const out: Array<{ name: string, data: Buffer }> = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512)
    if (block.every(byte => byte === 0)) break
    const stored = Number.parseInt(block.subarray(148, 156).toString('latin1'), 8)
    const blank = Buffer.from(block)
    blank.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of blank) sum += byte
    expect(sum).toBe(stored)
    const size = block[124]! & 0x80 ? block.readUIntBE(130, 6) : Number.parseInt(block.subarray(124, 136).toString('latin1'), 8)
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    out.push({ name, data: archive.subarray(offset + 512, offset + 512 + size) })
    offset += 512 + size + ((512 - (size % 512)) % 512)
  }
  return out
}

const names: ArchiveNames = {
  rewrite(file, json: any) {
    if (file === 'manifest.json') return json.map((item: any) => ({ ...item, RepoTags: item.RepoTags.map((tag: string) => `renamed/${tag}`) }))
    if (file === 'index.json') return { ...json, renamed: true }
    return Object.fromEntries(Object.entries(json).map(([key, value]) => [`renamed/${key}`, value]))
  }
}

function run(archive: Buffer, size: number, rewriter = archiveRewriter(names)) {
  const out: Buffer[] = []
  for (let offset = 0; offset < archive.length; offset += size) out.push(rewriter.push(archive.subarray(offset, offset + size)))
  out.push(rewriter.end())
  return Buffer.concat(out)
}

describe('image archives', () => {
  const layer = Buffer.alloc(70_000)
  for (let index = 0; index < layer.length; index++) layer[index] = (index * 31) % 251
  const archive = Buffer.concat([
    entry('blobs/', '', '5'),
    entry('blobs/sha256/aaaa', layer),
    entry('oci-layout', '{"imageLayoutVersion":"1.0.0"}'),
    entry('index.json', '{"manifests":[]}'),
    entry('manifest.json', '[{"RepoTags":["app:dev"],"Layers":["blobs/sha256/aaaa"]}]'),
    entry('./repositories', '{"app":{"dev":"aaaa"}}'),
    END
  ])

  it.each([1, 7, 511, 512, 513, 4096, archive.length])('rewrites the naming files and nothing else, in reads of %i bytes', (size) => {
    const out = entries(run(archive, size))
    expect(out.map(item => item.name)).toEqual(['blobs/', 'blobs/sha256/aaaa', 'oci-layout', 'index.json', 'manifest.json', './repositories'])
    expect(out[1]!.data.equals(layer)).toBe(true)
    expect(out[2]!.data.toString()).toBe('{"imageLayoutVersion":"1.0.0"}')
    expect(JSON.parse(out[3]!.data.toString())).toEqual({ manifests: [], renamed: true })
    expect(JSON.parse(out[4]!.data.toString())[0].RepoTags).toEqual(['renamed/app:dev'])
    expect(JSON.parse(out[5]!.data.toString())).toEqual({ 'renamed/app': { dev: 'aaaa' } })
  })

  it('keeps the end-of-archive blocks, and anything after them', () => {
    const out = run(archive, 100)
    expect(out.subarray(-1024).equals(END)).toBe(true)
  })

  it('passes an archive with nothing to rename through byte for byte', () => {
    const plain = Buffer.concat([entry('blobs/sha256/bbbb', layer), entry('other.json', '{}'), END])
    expect(run(plain, 333).equals(plain)).toBe(true)
    const unchanged = archiveRewriter({ rewrite: () => null })
    expect(run(archive, 1000, unchanged).equals(archive)).toBe(true)
  })

  it('reads a long name from a PAX header or a GNU long-name entry, and a base-256 size', () => {
    const withPax = Buffer.concat([
      pax({ path: 'manifest.json' }),
      entry('PaxShortName', '[{"RepoTags":["x:1"]}]'),
      entry('././@LongLink', 'index.json', 'L'),
      entry('LongLinkShort', '{"manifests":[]}'),
      entry('blobs/sha256/cccc', layer, '0', { base256: true }),
      END
    ])
    const out = entries(run(withPax, 1000))
    expect(JSON.parse(out[1]!.data.toString())[0].RepoTags).toEqual(['renamed/x:1'])
    expect(JSON.parse(out[3]!.data.toString())).toEqual({ manifests: [], renamed: true })
    expect(out[4]!.data.equals(layer)).toBe(true)
  })

  it('does not take a global PAX header\'s path for the next entry\'s name', () => {
    const global = Buffer.concat([entry('pax_global_header', pax({ path: 'manifest.json' }).subarray(512, 512 + 25), 'g'), entry('other.json', '[{"RepoTags":["x:1"]}]'), END])
    expect(run(global, 100).equals(global)).toBe(true)
  })

  it('leaves an entry whose size a PAX header restates, or that is not JSON, as it was', () => {
    const errors: unknown[] = []
    const odd = Buffer.concat([
      pax({ size: '22' }),
      entry('manifest.json', '[{"RepoTags":["x:1"]}]'),
      entry('index.json', 'not json'),
      END
    ])
    expect(run(odd, 64, archiveRewriter(names, error => errors.push(error))).equals(odd)).toBe(true)
    expect(errors).toHaveLength(1)
  })

  it('hands back what it held when the archive is cut short', () => {
    const cut = archive.subarray(0, archive.length - 1024 - 300)
    expect(run(cut, 200).length).toBeGreaterThan(0)
  })
})

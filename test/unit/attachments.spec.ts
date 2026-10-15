import { describe, expect, it } from 'vitest'

import { attachmentUrl, isImageAttachment } from '../../app/utils/attachments'

describe('attachmentUrl', () => {
  it('serves an upload of the composer by its own name, from a path or a file URI', () => {
    expect(attachmentUrl('/data/uploads/up_0123456789abcdef0123.png')).toBe('/api/uploads/up_0123456789abcdef0123.png')
    expect(attachmentUrl('file:///data/uploads/up_0123456789abcdef0123.png')).toBe('/api/uploads/up_0123456789abcdef0123.png')
  })

  it('has no URL for any other file', () => {
    expect(attachmentUrl('file:///etc/passwd')).toBeNull()
    expect(attachmentUrl('file:///tmp/up_..%2F..%2Fsecret.png')).toBeNull()
    expect(attachmentUrl(undefined)).toBeNull()
  })
})

describe('isImageAttachment', () => {
  it('shows raster images and never an SVG', () => {
    expect(isImageAttachment('image-1.png')).toBe(true)
    expect(isImageAttachment('photo.JPG')).toBe(true)
    expect(isImageAttachment('notes.pdf')).toBe(false)
    expect(isImageAttachment('logo.svg')).toBe(false)
    expect(isImageAttachment('x', 'image/svg+xml')).toBe(false)
    expect(isImageAttachment('x', 'image/webp')).toBe(true)
  })
})


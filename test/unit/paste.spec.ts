import { describe, expect, it } from 'vitest'

import { pastedFiles, uploadName } from '../../app/utils/paste'
import type { PastedClipboard } from '../../app/utils/paste'

function file(name: string, type: string): File {
  return { name, type } as File
}

/** Enough of a `DataTransfer` for the decision: what is on it, and any text. */
function clipboard(files: File[], text = ''): PastedClipboard {
  return { files, getData: format => (format === 'text/plain' ? text : '') }
}

describe('pastedFiles', () => {
  it('takes a clipboard that is only files', () => {
    const screenshot = file('', 'image/png')
    expect(pastedFiles(clipboard([screenshot]))).toEqual([screenshot])
  })

  it('leaves an ordinary text paste alone', () => {
    expect(pastedFiles(clipboard([], 'a line of code'))).toEqual([])
  })

  it('prefers the text when the clipboard carries both', () => {
    // A spreadsheet range and a rich-text selection both offer a picture of
    // themselves beside the text. Attaching that instead of pasting is worse
    // than not attaching at all.
    expect(pastedFiles(clipboard([file('', 'image/png')], 'one\ttwo'))).toEqual([])
  })

  it('does not count whitespace as text worth keeping', () => {
    const screenshot = file('', 'image/png')
    expect(pastedFiles(clipboard([screenshot], '  \n '))).toEqual([screenshot])
  })

  it('survives a paste with no clipboard at all', () => {
    expect(pastedFiles(null)).toEqual([])
    expect(pastedFiles(undefined)).toEqual([])
  })
})

describe('uploadName', () => {
  const at = new Date('2026-03-04T05:06:07.000Z')

  it('keeps the name a real file came with', () => {
    expect(uploadName(file('notes.pdf', 'application/pdf'), at)).toBe('notes.pdf')
  })

  it('dates a clipboard image that has no name', () => {
    expect(uploadName(file('', 'image/png'), at)).toBe('pasted-20260304-050607.png')
  })

  it('knows the extensions that are not just the subtype', () => {
    expect(uploadName(file('', 'image/jpeg'), at)).toBe('pasted-20260304-050607.jpg')
    expect(uploadName(file('', 'image/svg+xml'), at)).toBe('pasted-20260304-050607.svg')
  })

  it('falls back to the subtype, and to something when there is not one', () => {
    expect(uploadName(file('', 'application/pdf'), at)).toBe('pasted-20260304-050607.pdf')
    expect(uploadName(file('', ''), at)).toBe('pasted-20260304-050607.bin')
  })
})

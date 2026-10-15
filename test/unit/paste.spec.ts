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
  it('keeps the name a real file came with', () => {
    expect(uploadName(file('notes.pdf', 'application/pdf'))).toBe('notes.pdf')
  })

  /**
   * Every browser hands a screenshot over as `image.png`, so three pastes in
   * one message were three `image.png`s, which read as each replacing the last.
   */
  it('numbers clipboard images past every name already taken', () => {
    const first = uploadName(file('image.png', 'image/png'))
    const second = uploadName(file('image.png', 'image/png'), [first])
    const third = uploadName(file('image.png', 'image/png'), [first, second, 'image-4.png'])
    expect([first, second, third]).toEqual(['image-1.png', 'image-2.png', 'image-3.png'])
    // Past the session's earlier messages too, which arrive the same way.
    expect(uploadName(file('image.png', 'image/png'), ['image-1.png', 'IMAGE-2.PNG'])).toBe('image-3.png')
  })

  it('names a clipboard file with no name at all by its type', () => {
    expect(uploadName(file('', 'image/png'))).toBe('image-1.png')
    expect(uploadName(file('', 'image/jpeg'))).toBe('image-1.jpg')
    expect(uploadName(file('', 'application/pdf'))).toBe('pasted-1.pdf')
    expect(uploadName(file('', ''))).toBe('pasted-1.bin')
  })

  it('numbers a real name only when it is taken, from 2', () => {
    expect(uploadName(file('notes.pdf', 'application/pdf'), ['notes.pdf'])).toBe('notes-2.pdf')
    expect(uploadName(file('Makefile', 'text/plain'), ['Makefile'])).toBe('Makefile-2')
  })
})

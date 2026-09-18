import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import DiffView from '~/components/DiffView.vue'

/** The line-level diff every edit and every permission prompt is eyeballed on. */
async function diff(oldText: string | null, newText: string | null) {
  const component = await mountSuspended(DiffView, { props: { path: 'src/index.ts', oldText, newText } })
  const lines = component.findAll('.max-h-80 > div').map(line => ({
    marker: line.find('span').text(),
    text: line.findAll('span')[1]!.text()
  }))
  return { component, lines, header: component.find('.font-mono').text() }
}

describe('DiffView', () => {
  it('marks an added line', async () => {
    const { lines } = await diff('a\nb', 'a\nnew\nb')

    expect(lines).toEqual([
      { marker: '', text: 'a' },
      { marker: '+', text: 'new' },
      { marker: '', text: 'b' }
    ])
  })

  it('marks a removed line', async () => {
    const { lines } = await diff('a\ngone\nb', 'a\nb')

    expect(lines.map(line => line.marker)).toEqual(['', '-', ''])
  })

  it('shows a replacement as a removal and an addition', async () => {
    const { lines } = await diff('before', 'after')

    expect(lines).toEqual([
      { marker: '-', text: 'before' },
      { marker: '+', text: 'after' }
    ])
  })

  it('counts the changes in the header', async () => {
    const { component } = await diff('a\nb\nc', 'a\nB\nc\nd')

    expect(component.text()).toContain('+2')
    expect(component.text()).toContain('-1')
  })

  it('shows every line of a new file as an addition', async () => {
    const { lines } = await diff(null, 'one\ntwo')

    expect(lines.filter(line => line.marker === '+')).toEqual([
      { marker: '+', text: 'one' },
      { marker: '+', text: 'two' }
    ])
    // Known wart: absent text splits into [''], so a created file also renders
    // one removed empty line and counts as -1.
    expect(lines.filter(line => line.marker === '-')).toEqual([{ marker: '-', text: '' }])
  })

  it('shows the path being changed', async () => {
    const { header } = await diff('a', 'b')

    expect(header).toBe('src/index.ts')
  })

  it('renders an unchanged file as context only', async () => {
    const { component, lines } = await diff('same', 'same')

    expect(lines).toEqual([{ marker: '', text: 'same' }])
    expect(component.text()).toContain('+0')
  })
})

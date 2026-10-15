import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import MarkdownView from '~/components/MarkdownView.vue'

/**
 * A message that streams faster than it renders still shows its progress.
 * Keeping only the newest render starved the view: every render was
 * overtaken by the next delta, and the text sat at its first words until the
 * stream paused.
 */
mockNuxtImport('renderMarkdown', () => async (text: string) => {
  await new Promise(resolve => setTimeout(resolve, 60))
  return `<p>${text}</p>`
})

describe('MarkdownView', () => {
  it('shows streamed text as it goes when rendering is slower than the stream', async () => {
    const view = await mountSuspended(MarkdownView, { props: { text: 'one' } })
    const seen = new Set<string>()
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    for (let i = 2; i <= words.length; i++) {
      await view.setProps({ text: words.slice(0, i).join(' ') })
      await new Promise(resolve => setTimeout(resolve, 25))
      seen.add(view.text())
    }
    // Some intermediate text reached the screen while the stream was still going.
    expect([...seen].some(text => text.startsWith('one two') && text !== words.join(' '))).toBe(true)
    await expect.poll(() => view.text()).toBe(words.join(' '))
  })

  /**
   * A virtual transcript mounts a row as it scrolls into view. A view that
   * drew nothing until its markdown arrived grew a moment later and moved
   * every row under it.
   */
  it('draws its text in the frame it mounts in, and the highlighted render from then on', async () => {
    const text = '**bold** and\n\n```ts\nconst a = 1\n```'
    const view = await mountSuspended(MarkdownView, { props: { text } })

    // Before the (mocked, 60 ms) highlighted render could have landed.
    expect(view.html()).toContain('<strong>bold</strong>')
    expect(view.html()).toContain('<pre><code>const a = 1')

    // The mock renders the source as it is, asterisks and all.
    await expect.poll(() => view.text()).toContain('**bold**')

    // Mounted again, it is the highlighted render at once.
    const again = await mountSuspended(MarkdownView, { props: { text } })
    expect(again.text()).toContain('**bold**')
  })
})

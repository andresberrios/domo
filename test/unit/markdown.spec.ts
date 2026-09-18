import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '~/utils/markdown'

/**
 * Agent output is markdown written by a model: it contains code, links and
 * whatever the model felt like emitting, and it is rendered with `v-html`.
 */
describe('renderMarkdown', () => {
  it('is empty for empty input', async () => {
    expect(await renderMarkdown('')).toBe('')
  })

  it('renders GitHub-flavoured markdown with hard line breaks', async () => {
    const html = await renderMarkdown('one\ntwo')

    expect(html).toContain('<br>')
  })

  it('opens links in a new tab without leaking the referrer', async () => {
    const html = await renderMarkdown('[docs](https://example.com)')

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('renders inline markup inside a link label', async () => {
    const html = await renderMarkdown('[**bold** link](https://example.com)')

    expect(html).toContain('<strong>bold</strong>')
  })

  it('highlights a fenced code block for both colour schemes', async () => {
    const html = await renderMarkdown('```ts\nconst x = 1\n```')

    expect(html).toContain('shiki')
    expect(html).toContain('--shiki-dark')
  })

  it('still renders a fence in a language Shiki does not know', async () => {
    const html = await renderMarkdown('```not-a-language\nhello\n```')

    expect(html).toContain('hello')
  })

  it('escapes HTML inside code so agent output cannot inject markup', async () => {
    const html = await renderMarkdown('```\n<script>alert(1)</script>\n```')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&#x3C;script>alert(1)')
  })
})

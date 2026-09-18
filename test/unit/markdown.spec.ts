import { Window } from 'happy-dom'
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
})

/**
 * The text reaching `MarkdownView` is model output that routinely quotes files,
 * web pages and command output the agent did not write. A payload in a README it
 * read must not become script execution in a tab that can approve the agent's
 * next tool call, so nothing below may survive as live markup.
 */
describe('renderMarkdown: untrusted content', () => {
  const BASE = 'https://domo.test/page'

  /**
   * Assert against a *parsed* document, not against the markup: a real HTML
   * parser decodes the entities and a real URL parser strips the whitespace, so
   * the test sees the payload the way the browser would rather than the way the
   * renderer happened to spell it.
   */
  const expectInert = (html: string) => {
    const window = new Window({ url: BASE })
    window.document.body.innerHTML = html

    expect(window.document.body.querySelectorAll('script, iframe, object, embed, svg')).toHaveLength(0)

    for (const element of window.document.body.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name).not.toMatch(/^on/)
        if (attribute.name === 'href' || attribute.name === 'src') {
          expect(new URL(attribute.value ?? '', BASE).protocol).toMatch(/^(https?|mailto):$/)
        }
      }
    }
  }

  describe('raw HTML', () => {
    it('neutralises a block-level <script> tag', async () => {
      const html = await renderMarkdown('<script>alert(1)</script>')

      expectInert(html)
      expect(html).toContain('&lt;script&gt;')
    })

    it('neutralises a <script> tag inline in a paragraph', async () => {
      const html = await renderMarkdown('hello <script>alert(1)</script> world')

      expectInert(html)
      expect(html).toContain('hello')
      expect(html).toContain('world')
    })

    it('neutralises an event-handler attribute', async () => {
      expectInert(await renderMarkdown('<img src=x onerror="alert(1)">'))
    })

    it('neutralises an <iframe>', async () => {
      expectInert(await renderMarkdown('<iframe src="https://evil.example"></iframe>'))
    })

    it('neutralises <svg onload>', async () => {
      expectInert(await renderMarkdown('<svg onload=alert(1)>'))
    })

    it('neutralises an unclosed tag before a payload', async () => {
      expectInert(await renderMarkdown('<div\n\n<script>alert(1)</script>'))
    })

    it('neutralises a malformed nested tag', async () => {
      expectInert(await renderMarkdown('<scr<script>ipt>alert(1)</scr</script>ipt>'))
    })

    it('neutralises raw HTML inside a table cell', async () => {
      expectInert(await renderMarkdown('| a |\n| --- |\n| <img src=x onerror=alert(1)> |'))
    })

    it('neutralises raw HTML inside a blockquote and a list item', async () => {
      expectInert(await renderMarkdown('> <script>alert(1)</script>\n\n- <img src=x onerror=alert(2)>'))
    })

    it('neutralises raw HTML in a link label and a heading', async () => {
      expectInert(await renderMarkdown('# <script>alert(1)</script>\n\n[<img src=x onerror=alert(2)>](https://example.com)'))
    })
  })

  describe('dangerous URL schemes', () => {
    const cases: Array<[string, string]> = [
      ['javascript: in a link', '[click me](javascript:alert(1))'],
      ['javascript: in an image src', '![boom](javascript:alert(1))'],
      ['data:text/html in a link', '[click me](data:text/html,<script>alert(1)</script>)'],
      ['data: in an image src', '![boom](data:text/html;base64,PHN2Zz4=)'],
      ['vbscript: in a link', '[click me](vbscript:msgbox(1))'],
      ['mixed case', '[click me](jAvAsCrIpT:alert(1))'],
      ['leading whitespace', '[click me]( \t javascript:alert(1))'],
      ['an embedded tab', '[click me](java\tscript:alert(1))'],
      ['a decimal entity', '[click me](&#106;avascript:alert(1))'],
      ['a hex entity', '[click me](&#x6a;avascript:alert(1))'],
      ['a double-encoded entity', '[click me](&amp;#106;avascript:alert(1))'],
      ['an entity-encoded colon', '[click me](javascript&colon;alert(1))'],
      ['a reference-style link', '[click me][ref]\n\n[ref]: javascript:alert(1)'],
      ['a reference-style image', '![boom][ref]\n\n[ref]: javascript:alert(1)'],
      ['an autolink', '<javascript:alert(1)>'],
      ['a nested image inside a link', '[![boom](javascript:alert(1))](javascript:alert(2))']
    ]

    it.each(cases)('rejects %s', async (_name, source) => {
      expectInert(await renderMarkdown(source))
    })

    /**
     * Escaping the `&` would leave these inert on its own. Assert the stronger
     * property — the link is *dropped* — so the decoding in `safeUrl` stays
     * honest rather than being carried by the escaping underneath it.
     */
    it.each([
      ['a decimal entity', '&#106;avascript:alert(1)'],
      ['a padded decimal entity', '&#0000106;avascript:alert(1)'],
      ['a hex entity', '&#x6a;avascript:alert(1)'],
      ['an upper-case hex entity', '&#X6A;avascript:alert(1)'],
      ['a double-encoded entity', '&amp;#106;avascript:alert(1)'],
      ['an entity-encoded colon', 'javascript&colon;alert(1)'],
      ['an entity-encoded tab', 'java&Tab;script:alert(1)'],
      ['an entity-encoded newline', 'java&NewLine;script:alert(1)']
    ])('drops a link whose scheme hides behind %s', async (_name, url) => {
      const html = await renderMarkdown(`[click me](${url})`)

      expect(html).not.toContain('<a ')
    })

    it('keeps the label readable when it drops an unsafe link', async () => {
      const html = await renderMarkdown('[click me](javascript:alert(1))')

      expect(html).not.toContain('<a ')
      expect(html).toContain('click me')
    })

    it('escapes a quote in a title rather than letting it start an attribute', async () => {
      const html = await renderMarkdown('[click me](https://example.com "a\\" onmouseover=\\"alert(1)")')

      expectInert(html)
      expect(html).toContain('title="a&quot; onmouseover=&quot;alert(1)"')
    })
  })

  describe('legitimate rendering still works', () => {
    it('keeps ordinary markdown', async () => {
      const html = await renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two')

      expect(html).toContain('<h1>Title</h1>')
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<code>code</code>')
      expect(html).toContain('<li>one</li>')
    })

    it('keeps http, https, mailto, relative and anchor links', async () => {
      const html = await renderMarkdown(
        '[a](https://example.com/x?y=1#z) [b](http://example.com) [c](mailto:a@example.com)'
        + ' [d](./docs/readme.md) [e](#section) [f](//example.com/x)'
      )

      expect(html).toContain('href="https://example.com/x?y=1#z"')
      expect(html).toContain('href="http://example.com"')
      expect(html).toContain('href="mailto:a@example.com"')
      expect(html).toContain('href="./docs/readme.md"')
      expect(html).toContain('href="#section"')
      expect(html).toContain('href="//example.com/x"')
    })

    it('keeps an https image, with its alt and title', async () => {
      const html = await renderMarkdown('![a diagram](https://example.com/d.png "the title")')

      expect(html).toContain('src="https://example.com/d.png"')
      expect(html).toContain('alt="a diagram"')
      expect(html).toContain('title="the title"')
    })

    it('keeps a link title', async () => {
      const html = await renderMarkdown('[docs](https://example.com "the title")')

      expect(html).toContain('title="the title"')
    })

    it('keeps an autolink to a real page', async () => {
      const html = await renderMarkdown('<https://example.com/page>')

      expect(html).toContain('href="https://example.com/page"')
    })

    it('keeps a table', async () => {
      const html = await renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')

      expect(html).toContain('<table>')
      expect(html).toContain('<td>1</td>')
    })
  })

  describe('code fences', () => {
    it('escapes HTML inside code so agent output cannot inject markup', async () => {
      const html = await renderMarkdown('```\n<script>alert(1)</script>\n```')

      expectInert(html)
      expect(html).toContain('&#x3C;script>alert(1)')
    })

    it('shows markup quoted in a fence as text', async () => {
      const html = await renderMarkdown('```html\n<img src=x onerror="alert(1)">\n```')

      expectInert(html)
      expect(html).toContain('onerror')
    })

    it('highlights a fence without escaping it twice', async () => {
      const html = await renderMarkdown('```ts\nconst x: string[] = ["a & b"]\n```')

      expect(html).toContain('shiki')
      expect(html).toContain('--shiki-dark')
      // Shiki escaped this once already; escaping it again shows `&amp;amp;`.
      expect(html).not.toContain('&amp;amp;')
      expect(html).not.toContain('&amp;#x3C;')
    })

    it('does not let a fence language smuggle an attribute', async () => {
      expectInert(await renderMarkdown('```ts" onload="alert(1)\nconst x = 1\n```'))
    })

    it('escapes HTML in an indented code block and an inline code span', async () => {
      const html = await renderMarkdown('    <script>alert(1)</script>\n\nand `<script>alert(2)</script>`')

      expectInert(html)
    })
  })
})

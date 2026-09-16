import { marked } from 'marked'

let configured = false

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function highlight(code: string, lang?: string): Promise<string> {
  try {
    const { codeToHtml } = await import('shiki')
    return await codeToHtml(code, {
      lang: lang && lang.trim() ? lang.trim().toLowerCase() : 'text',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false
    })
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`
  }
}

function configure() {
  if (configured) return
  configured = true
  marked.use({
    gfm: true,
    breaks: true,
    async: true,
    walkTokens: async (token: any) => {
      if (token.type === 'code') {
        token.text = await highlight(token.text ?? '', token.lang)
        token.escaped = true
      }
    },
    renderer: {
      code(token: any) {
        return token.escaped ? token.text : `<pre><code>${escapeHtml(token.text ?? '')}</code></pre>`
      },
      link(token: any) {
        const href = escapeHtml(token.href ?? '')
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<a href="${href}"${title} target="_blank" rel="noreferrer noopener">${token.text}</a>`
      }
    }
  })
}

/** Render agent/model markdown to HTML with syntax-highlighted code fences. */
export async function renderMarkdown(source: string): Promise<string> {
  configure()
  if (!source) return ''
  return (await marked.parse(source)) as string
}

import { marked } from 'marked'

let configured = false

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The only schemes a link or an image may carry. A URL with no scheme at all is
 * relative (or a bare fragment) and is left alone; anything else — `javascript:`,
 * `data:`, `vbscript:` — is dropped.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * The named entities that could help a scheme hide. Everything else in the HTML
 * entity table decodes to something that cannot appear in one, so it can only
 * break a scheme, never build it.
 */
const URL_ENTITIES: Record<string, string> = {
  amp: '&',
  colon: ':',
  tab: '\t',
  newline: '\n',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  sol: '/',
  nbsp: ' '
}

/**
 * Drop the ASCII whitespace and C0/DEL controls a browser drops before it
 * decides what a URL's scheme is, so `java<tab>script:` cannot hide one.
 */
function stripBlanks(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code > 0x20 && code !== 0x7F) out += char
  }
  return out
}

function decodeEntity(body: string): string | null {
  if (body.startsWith('#')) {
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return null
    return String.fromCodePoint(code)
  }
  return URL_ENTITIES[body.toLowerCase()] ?? null
}

/**
 * Undo what a browser undoes before it decides what a URL's scheme is: an
 * attribute value is entity-decoded, and ASCII whitespace and C0 controls are
 * dropped wherever they appear. `&#106;avascript:`, `javascript&colon;` and
 * `java\tscript:` all mean `javascript:` by the time the URL is navigated.
 */
function decodeUrl(value: string): string {
  let decoded = value
  // Entities can nest: `&amp;#106;` needs a second pass to become `j`.
  for (let pass = 0; pass < 4; pass++) {
    const next = decoded.replace(
      /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g,
      (match, body: string) => decodeEntity(body) ?? match
    )
    if (next === decoded) break
    decoded = next
  }
  return stripBlanks(decoded)
}

/** The URL if it is safe to put in an `href`/`src`, otherwise `null`. */
function safeUrl(raw: string): string | null {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decodeUrl(raw))
  if (scheme && !SAFE_SCHEMES.has(scheme[1]!.toLowerCase())) return null
  return raw
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
      // Both block-level and inline raw HTML arrive as `html` tokens. The text we
      // render is model output that quotes files, web pages and command output,
      // so a tag in it is something the agent *read*, not markup we were asked to
      // render — show it, never run it.
      html(token: any) {
        return escapeHtml(token.text ?? '')
      },
      link(this: any, token: any) {
        // `token.text` is the raw source; the inline tokens carry bold/code/etc.
        const label = this.parser.parseInline(token.tokens ?? [])
        const href = safeUrl(token.href ?? '')
        // An unusable scheme leaves the label behind as plain text: the words
        // still read, but there is nothing to click.
        if (href === null) return label
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noreferrer noopener">${label}</a>`
      },
      image(token: any) {
        const alt = escapeHtml(token.text ?? '')
        const src = safeUrl(token.href ?? '')
        if (src === null) return alt
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`
      }
    }
  })
}

/**
 * Render agent/model markdown to HTML with syntax-highlighted code fences.
 *
 * The result is inserted with `v-html`, so this is the only thing standing
 * between untrusted text and script execution: raw HTML is escaped and link and
 * image URLs are restricted to a scheme allow-list.
 */
export async function renderMarkdown(source: string): Promise<string> {
  configure()
  if (!source) return ''
  return (await marked.parse(source)) as string
}

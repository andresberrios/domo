/**
 * Map a `workspace.read` language id to a CodeMirror language extension.
 *
 * The grammars are dynamically imported so each one is its own chunk and
 * nothing CodeMirror-related is pulled until an editor actually mounts
 * (the app is SPA, but we still want per-language code-splitting). Ids
 * without an installed grammar fall back to plain text (`[]`).
 */
import type { Extension } from '@codemirror/state'

const LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  html: 'HTML',
  vue: 'Vue',
  css: 'CSS',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  cpp: 'C/C++',
  java: 'Java',
  php: 'PHP',
  sql: 'SQL',
  yaml: 'YAML',
  xml: 'XML',
  toml: 'TOML',
  shell: 'Shell',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  text: 'Plain text',
}

export function languageLabel(id: string): string {
  return LABELS[id] ?? 'Plain text'
}

export async function languageExtension(id: string): Promise<Extension[]> {
  switch (id) {
    case 'typescript': {
      const m = await import('@codemirror/lang-javascript')
      return [m.javascript({ typescript: true, jsx: true })]
    }
    case 'javascript': {
      const m = await import('@codemirror/lang-javascript')
      return [m.javascript({ jsx: true })]
    }
    case 'json': {
      const m = await import('@codemirror/lang-json')
      return [m.json()]
    }
    case 'markdown': {
      const m = await import('@codemirror/lang-markdown')
      return [m.markdown()]
    }
    case 'html': {
      const m = await import('@codemirror/lang-html')
      return [m.html()]
    }
    case 'vue': {
      const m = await import('@codemirror/lang-vue')
      return [m.vue()]
    }
    case 'css': {
      const m = await import('@codemirror/lang-css')
      return [m.css()]
    }
    case 'python': {
      const m = await import('@codemirror/lang-python')
      return [m.python()]
    }
    case 'rust': {
      const m = await import('@codemirror/lang-rust')
      return [m.rust()]
    }
    case 'go': {
      const m = await import('@codemirror/lang-go')
      return [m.go()]
    }
    case 'cpp': {
      const m = await import('@codemirror/lang-cpp')
      return [m.cpp()]
    }
    case 'java': {
      const m = await import('@codemirror/lang-java')
      return [m.java()]
    }
    case 'php': {
      const m = await import('@codemirror/lang-php')
      return [m.php()]
    }
    case 'sql': {
      const m = await import('@codemirror/lang-sql')
      return [m.sql()]
    }
    case 'yaml': {
      const m = await import('@codemirror/lang-yaml')
      return [m.yaml()]
    }
    case 'xml': {
      const m = await import('@codemirror/lang-xml')
      return [m.xml()]
    }
    default:
      return []
  }
}

<script setup lang="ts">
/**
 * xterm.js terminal bound to a shell *inside* the selected env's Coast
 * instance, via `WS /api/terminal?envId=…` (which proxies coastd's
 * `exec/interactive`). We speak coastd's frame protocol directly: the
 * first frame is a `{ session_id }` JSON handshake (swallowed), the rest
 * is raw PTY text; we send keystrokes as text and resizes as a
 * `\x01`-prefixed JSON frame.
 */
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

const props = defineProps<{ envId: string }>()

const host = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let ro: ResizeObserver | null = null
let gotInit = false

const RESIZE_PREFIX = '\x01'

function sendResize() {
  if (term && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(RESIZE_PREFIX + JSON.stringify({ cols: term.cols, rows: term.rows }))
  }
}

async function start() {
  const { Terminal: Term } = await import('@xterm/xterm')
  const { FitAddon: Fit } = await import('@xterm/addon-fit')
  const { WebLinksAddon } = await import('@xterm/addon-web-links')

  term = new Term({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: true,
    theme: { background: '#0a0a0a' },
  })
  fit = new Fit()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(host.value!)
  fit.fit()

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/api/terminal?envId=${encodeURIComponent(props.envId)}`)

  ws.addEventListener('open', () => sendResize())
  ws.addEventListener('message', (ev) => {
    const data = String(ev.data)
    if (!gotInit) {
      gotInit = true
      try {
        const parsed = JSON.parse(data)
        if (parsed && typeof parsed.session_id === 'string') return
      } catch { /* not the handshake — fall through and render it */ }
    }
    term?.write(data)
  })
  ws.addEventListener('close', () => term?.write('\r\n[disconnected]\r\n'))

  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(d)
  })
  term.onResize(() => sendResize())

  ro = new ResizeObserver(() => {
    try { fit?.fit() } catch { /* not visible yet */ }
  })
  ro.observe(host.value!)
}

function stop() {
  ro?.disconnect(); ro = null
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  term?.dispose(); term = null
  fit = null
  gotInit = false
}

onMounted(start)
onBeforeUnmount(stop)
watch(
  () => props.envId,
  () => { stop(); start() },
)
</script>

<template>
  <div ref="host" class="h-full min-h-0 w-full bg-black" />
</template>

/**
 * Claude Code IDE bridge — a standalone, per-session WebSocket server the
 * spawned `claude` child connects to (design Decided #15).
 *
 * Why not Nitro/crossws: the CLI discovers this server itself via
 * `~/.claude/ide/<port>.lock` + `CLAUDE_CODE_SSE_PORT` and connects to
 * `ws://127.0.0.1:<port>/` (root path, no session id). Lock files are
 * named `<port>.lock` and carry one `authToken`, so every concurrent
 * session needs its OWN ephemeral-port localhost listener — Nitro only
 * has the single app listener. The protocol surface is tiny (one trusted
 * localhost client, JSON-RPC/MCP over text frames, no compression), so we
 * hand-roll a minimal RFC 6455 server rather than add a dependency. The
 * exact framing mirrors `../claudecode.nvim/lua/claudecode/server/`, which
 * is proven against the real CLI.
 *
 * Scope (step 8c): handshake + auth, frame codec, MCP dispatch, the 8
 * required tools + `getDiagnostics`, and the `~/.claude/ide/<port>.lock`
 * lifecycle. `openDiff` is a blocking call delegated to an injected
 * `onOpenDiff`; the durable park → `pendingDiffs` → inbox `diff_decision`
 * → resolve round-trip is step 11.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MCP_PROTOCOL_VERSION = '2024-11-05'
/** Trusted local client, but cap reassembly so a bad frame can't OOM us. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export interface OpenDiffRequest {
  oldFilePath: string
  newFilePath: string
  newFileContents: string
  tabName: string
}

export interface IdeBridge {
  port: number
  authToken: string
  close(): Promise<void>
}

export interface IdeBridgeOpts {
  /** Absolute worktree dir — lock-file workspaceFolders + getWorkspaceFolders. */
  cwd: string
  /**
   * Blocking approval for an agent edit. Resolve `true` → `FILE_SAVED`,
   * `false` → `DIFF_REJECTED`. Implementations own persistence on accept.
   */
  onOpenDiff: (req: OpenDiffRequest) => Promise<boolean>
}

function claudeIdeDir(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim()
  return cfg ? join(cfg, 'ide') : join(homedir(), '.claude', 'ide')
}

// ── RFC 6455 frame codec ────────────────────────────────────────────────

interface ParsedFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  /** Total bytes this frame occupied in the input buffer. */
  size: number
}

/** Parse one frame from `buf`, or null if `buf` doesn't hold a full frame. */
function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const b0 = buf[0]!
  const b1 = buf[1]!
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let off = 2

  if (len === 126) {
    if (buf.length < off + 2) return null
    len = buf.readUInt16BE(off)
    off += 2
  } else if (len === 127) {
    if (buf.length < off + 8) return null
    const big = buf.readBigUInt64BE(off)
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('ws frame too large')
    len = Number(big)
    off += 8
  }

  let mask: Buffer | null = null
  if (masked) {
    if (buf.length < off + 4) return null
    mask = buf.subarray(off, off + 4)
    off += 4
  }

  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.subarray(off, off + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!
  return { fin, opcode, payload, size: off + len }
}

/** Encode an unmasked server→client frame. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

// ── server ──────────────────────────────────────────────────────────────

export async function createIdeBridge(
  opts: IdeBridgeOpts,
): Promise<IdeBridge> {
  const authToken = randomUUID()

  // The CLI's lock file is named `<port>.lock` and it dials the exact
  // CLAUDE_CODE_SSE_PORT — bind an explicit random port in the documented
  // 10000–65535 range, retrying on collision.
  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('Upgrade Required')
  })

  const port = await listenOnRandomPort(httpServer)

  // Track live upgraded sockets so close() can force-destroy them — an
  // upgraded socket keeps `httpServer.close()` pending forever otherwise.
  const sockets = new Set<Duplex>()
  httpServer.on('upgrade', (req, socket) => {
    if (!handshake(req, socket, authToken)) return
    ;(socket as { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true)
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    attachConnection(socket, opts)
  })

  const lockPath = join(claudeIdeDir(), `${port}.lock`)
  await mkdir(claudeIdeDir(), { recursive: true })
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      workspaceFolders: [opts.cwd],
      ideName: 'domo',
      transport: 'ws',
      authToken,
    }),
  )

  return {
    port,
    authToken,
    async close() {
      await rm(lockPath, { force: true }).catch(() => {})
      for (const s of sockets) s.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

async function listenOnRandomPort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 10000 + Math.floor(Math.random() * 55535)
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onOk)
          reject(e)
        }
        const onOk = (): void => {
          server.removeListener('error', onErr)
          resolve()
        }
        server.once('error', onErr)
        server.once('listening', onOk)
        server.listen(port, '127.0.0.1')
      })
      return port
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
    }
  }
  throw new Error('IDE bridge: no free port found in 10000-65535')
}

function handshake(
  req: IncomingMessage,
  socket: Duplex,
  authToken: string,
): boolean {
  const key = req.headers['sec-websocket-key']
  const auth = req.headers['x-claude-code-ide-authorization']
  const reject = (code: number, msg: string): false => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
    return false
  }
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket')
    return reject(400, 'Bad Request')
  if (auth !== authToken) return reject(401, 'Unauthorized')

  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return true
}

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

function attachConnection(socket: Duplex, opts: IdeBridgeOpts): void {
  let buf: Buffer = Buffer.alloc(0)
  // Reassembly across fragmented data frames (control frames may interleave).
  let fragOpcode = 0
  let fragChunks: Buffer[] = []
  let closed = false

  const send = (data: string): void => {
    if (closed) return
    try {
      socket.write(encodeFrame(OP_TEXT, Buffer.from(data, 'utf8')))
    } catch {
      /* peer gone */
    }
  }

  const onMessage = (text: string): void => {
    let msg: { id?: unknown; method?: unknown; params?: unknown }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : ''
    const isRequest = id !== undefined && id !== null

    void dispatch(method, msg.params, opts)
      .then((result) => {
        if (isRequest) send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      })
      .catch((err: unknown) => {
        if (!isRequest) return
        send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        )
      })
  }

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      let frame: ParsedFrame | null
      try {
        frame = parseFrame(buf)
      } catch {
        socket.destroy()
        return
      }
      if (!frame) return
      buf = buf.subarray(frame.size)

      if (frame.opcode === OP_CLOSE) {
        closed = true
        try {
          socket.end(encodeFrame(OP_CLOSE, Buffer.alloc(0)))
        } catch {
          socket.destroy()
        }
        return
      }
      if (frame.opcode === OP_PING) {
        try {
          socket.write(encodeFrame(OP_PONG, frame.payload))
        } catch {
          /* peer gone */
        }
        continue
      }
      if (frame.opcode === OP_PONG) continue

      if (frame.opcode === OP_TEXT || frame.opcode === OP_CONT) {
        if (frame.opcode === OP_TEXT) {
          fragOpcode = OP_TEXT
          fragChunks = []
        }
        fragChunks.push(frame.payload)
        if (frame.fin && fragOpcode === OP_TEXT) {
          const full = Buffer.concat(fragChunks)
          fragChunks = []
          onMessage(full.toString('utf8'))
        }
      }
    }
  })

  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    closed = true
  })
}

// ── MCP method + tool dispatch ──────────────────────────────────────────

function mcpText(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

async function dispatch(
  method: string,
  params: unknown,
  opts: IdeBridgeOpts,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'domo', version: '0.1.0' },
      }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {}
    case 'tools/list':
      return { tools: TOOL_LIST }
    case 'tools/call': {
      const p = (params ?? {}) as { name?: string; arguments?: unknown }
      return callTool(p.name ?? '', (p.arguments ?? {}) as Record<string, unknown>, opts)
    }
    default:
      // Unknown notifications are silently ignored; unknown requests error.
      throw new Error(`Method not found: ${method}`)
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: IdeBridgeOpts,
): Promise<unknown> {
  switch (name) {
    case 'openDiff': {
      const saved = await opts.onOpenDiff({
        oldFilePath: String(args.old_file_path ?? ''),
        newFilePath: String(args.new_file_path ?? ''),
        newFileContents: String(args.new_file_contents ?? ''),
        tabName: String(args.tab_name ?? 'Proposed changes'),
      })
      return mcpText(saved ? 'FILE_SAVED' : 'DIFF_REJECTED')
    }
    case 'openFile':
      return mcpText(`Opened file: ${String(args.filePath ?? '')}`)
    case 'getCurrentSelection':
      return mcpText(
        JSON.stringify({ success: false, message: 'No active editor found' }),
      )
    case 'getLatestSelection':
      return mcpText(
        JSON.stringify({ success: false, message: 'No selection available' }),
      )
    case 'getOpenEditors':
      return mcpText(JSON.stringify({ tabs: [] }))
    case 'getWorkspaceFolders':
      return mcpText(
        JSON.stringify({
          success: true,
          folders: [
            {
              name: opts.cwd.split('/').filter(Boolean).pop() ?? opts.cwd,
              uri: `file://${opts.cwd}`,
              path: opts.cwd,
            },
          ],
          rootPath: opts.cwd,
        }),
      )
    case 'getDiagnostics':
      return mcpText(JSON.stringify([]))
    case 'checkDocumentDirty':
      // Domo writes the agent's files straight to disk — it never holds an
      // unsaved editor buffer for them, so nothing is ever "dirty" here.
      return mcpText(
        JSON.stringify({
          success: true,
          filePath: String(args.filePath ?? ''),
          isDirty: false,
          isUntitled: false,
        }),
      )
    case 'saveDocument':
      return mcpText(
        JSON.stringify({
          success: true,
          filePath: String(args.filePath ?? ''),
          saved: true,
          message: 'Document saved successfully',
        }),
      )
    case 'closeAllDiffTabs':
      return mcpText('CLOSED_0_DIFF_TABS')
    default:
      throw new Error(`Tool not found: ${name}`)
  }
}

const STR = { type: 'string' } as const

const TOOL_LIST = [
  {
    name: 'openDiff',
    description:
      'Open a diff view comparing old file content with new file content (blocking until the user accepts or rejects)',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: STR,
        new_file_path: STR,
        new_file_contents: STR,
        tab_name: STR,
      },
      required: [
        'old_file_path',
        'new_file_path',
        'new_file_contents',
        'tab_name',
      ],
    },
  },
  {
    name: 'openFile',
    description: 'Open a file in the editor, optionally selecting a range',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: STR,
        preview: { type: 'boolean' },
        startText: STR,
        endText: STR,
        selectToEndOfLine: { type: 'boolean' },
        makeFrontmost: { type: 'boolean' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'getCurrentSelection',
    description: 'Get the current text selection in the active editor',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getLatestSelection',
    description: 'Get the most recent text selection',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getOpenEditors',
    description: 'Get information about currently open editors',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getWorkspaceFolders',
    description: 'Get all workspace folders currently open in the IDE',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getDiagnostics',
    description: 'Get language diagnostics from the editor',
    inputSchema: {
      type: 'object',
      properties: { uri: STR },
    },
  },
  {
    name: 'checkDocumentDirty',
    description: 'Check if a document has unsaved changes',
    inputSchema: {
      type: 'object',
      properties: { filePath: STR },
      required: ['filePath'],
    },
  },
  {
    name: 'saveDocument',
    description: 'Save a document with unsaved changes',
    inputSchema: {
      type: 'object',
      properties: { filePath: STR },
      required: ['filePath'],
    },
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all diff tabs in the editor',
    inputSchema: { type: 'object', properties: {} },
  },
]

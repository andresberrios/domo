import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, posix, resolve } from 'node:path'

import { newId } from './db'
import { run } from './dev-env/docker'
import { RUNTIME_ROOT } from './dev-env/runtime-volume'
import { dataDir } from './paths'
import { appendAgentEvent, createNotification, getDevEnvironment } from './repo'
import { voiceManager } from './voice/runtime'
import type { AgentSession, DomoNotification, NotificationAttachment } from '../../shared/types'

/** Big enough for a full-page screenshot or a log; small enough to keep the data directory sane. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 5

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.diff': 'text/plain',
  '.patch': 'text/plain'
}

export function attachmentMimeType(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Where a notification's files live. The index is the attachment's position in the row. */
export function attachmentPath(notificationId: string, index: number): string {
  return join(dataDir(), 'notifications', notificationId, String(index))
}

/**
 * Read a file the calling agent can see: from its container when it runs in a
 * development environment, from the host otherwise. A relative path is taken
 * from the agent's working directory, as its own shell would.
 *
 * The container read goes through Domo's own Node in the runtime volume, as
 * base64, because the project's image may have neither Node nor `base64`, and
 * `docker exec cat` would mangle a binary through the utf8 pipe.
 */
async function readAgentFile(caller: AgentSession, path: string): Promise<Buffer> {
  if (!caller.devEnvironmentId) {
    const full = isAbsolute(path) ? path : resolve(caller.cwd, path)
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) throw new Error(`No file at ${full}.`)
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${full} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
    return readFile(full)
  }
  const environment = await getDevEnvironment(caller.devEnvironmentId)
  if (!environment || environment.retiredAt) throw new Error('This agent\'s development environment no longer exists.')
  const full = posix.isAbsolute(path) ? path : posix.join(caller.cwd, path)
  const script = [
    'const fs = require("node:fs")',
    'const [file, max] = process.argv.slice(1)',
    'const info = fs.statSync(file)',
    'if (!info.isFile()) { console.error("not a file"); process.exit(2) }',
    'if (info.size > Number(max)) { console.error("too large"); process.exit(3) }',
    'process.stdout.write(fs.readFileSync(file).toString("base64"))'
  ].join('\n')
  const args = ['exec']
  if (environment.remoteUser) args.push('--user', environment.remoteUser)
  args.push(
    environment.containerId || environment.containerName,
    `${RUNTIME_ROOT}/node/bin/node`, '--eval', script, full, String(MAX_ATTACHMENT_BYTES)
  )
  const result = await run('docker', args).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('too large')) throw new Error(`${full} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
    throw new Error(`Could not read ${full} in the environment: ${message}`)
  })
  return Buffer.from(result.stdout, 'base64')
}

/**
 * Tell the human something, and make sure it reaches them.
 *
 * A row in `notifications` is what makes it durable: the browser shows it
 * until it is marked seen, whether or not anyone was looking when it arrived.
 * A live voice conversation also hears it at once. The `mesh_message` event
 * keeps the line in the agent's own transcript.
 */
export async function notifyHuman(input: {
  caller: AgentSession
  message: string
  urgent?: boolean
  files?: string[]
}): Promise<{ notification: DomoNotification, spoken: boolean }> {
  const message = String(input.message ?? '').trim()
  if (!message) throw new Error('A message is required.')
  const files = (input.files ?? []).map(String).filter(Boolean)
  if (files.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`)

  // Every file is read before anything is written, so a bad path fails the
  // whole call rather than leaving a notification with half its attachments.
  const contents = await Promise.all(files.map(path => readAgentFile(input.caller, path)))
  const id = newId('nt')
  const attachments: NotificationAttachment[] = []
  if (contents.length) await mkdir(join(dataDir(), 'notifications', id), { recursive: true })
  for (const [index, data] of contents.entries()) {
    const name = basename(files[index]!)
    await writeFile(attachmentPath(id, index), data)
    attachments.push({ name, mimeType: attachmentMimeType(name), size: data.length })
  }

  const notification = await createNotification({
    id,
    agentSessionId: input.caller.id,
    agentTitle: input.caller.title,
    message,
    urgent: !!input.urgent,
    attachments
  })
  await appendAgentEvent(input.caller.id, 'mesh_message', {
    from: input.caller.title,
    agentId: input.caller.id,
    message,
    urgent: !!input.urgent,
    notificationId: id,
    attachments: attachments.map(attachment => attachment.name)
  })

  const runtime = voiceManager.active()
  if (!runtime) return { notification, spoken: false }
  const attached = attachments.length
    ? ` (attached: ${attachments.map(attachment => attachment.name).join(', ')}, shown in the notifications panel)`
    : ''
  await runtime.injectNote(`Agent "${input.caller.title}" (${input.caller.id}) reports: ${message}${attached}`, true)
  return { notification, spoken: true }
}

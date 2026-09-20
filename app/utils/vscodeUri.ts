/**
 * The URL the Dev Containers extension answers with "Attach to Running
 * Container": the authority carries a JSON blob, hex-encoded, that names the
 * container, and the path is the folder to open inside it.
 *
 *   vscode://vscode-remote/attached-container+<hex>/<absolute path>
 *
 * The `{"containerName":"/<name>"}` form (leading slash — Docker's own name for
 * the container) is documented in the wild; the `settings.host` key that points
 * the extension at a Docker daemon on another machine over SSH is *not* in
 * Microsoft's docs — it is only attested by third-party write-ups, so treat a
 * non-empty `sshHost` as best effort.
 */
export interface VsCodeAttachTarget {
  containerName: string
  workspacePath: string
  /** `user@host`, `host`, or a full `ssh://…`. Blank means Docker is local. */
  sshHost?: string
}

function hex(value: string): string {
  // Hex of the UTF-8 bytes, not of the code units: a container name or path may
  // hold anything Docker accepts.
  return [...new TextEncoder().encode(value)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function normaliseSshHost(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('ssh://') ? trimmed : `ssh://${trimmed.replace(/^\/+/, '')}`
}

export function vscodeAttachUri({ containerName, workspacePath, sshHost }: VsCodeAttachTarget): string {
  const name = containerName.trim().replace(/^\/+/, '')
  if (!name) throw new Error('A container name is required to attach VS Code')

  const path = workspacePath.trim()
  if (!path.startsWith('/')) throw new Error(`The workspace path must be absolute, got "${workspacePath}"`)

  const target: { containerName: string, settings?: { host: string } } = { containerName: `/${name}` }
  if (sshHost?.trim()) target.settings = { host: normaliseSshHost(sshHost) }

  // Per segment, so spaces and unicode survive without the slashes being eaten.
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')

  return `vscode://vscode-remote/attached-container+${hex(JSON.stringify(target))}${encodedPath}`
}

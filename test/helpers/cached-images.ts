import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The images a test run's environments were built from, kept under
 * `<prefix>image-*` for the next environment with the same definition
 * (`server/lib/dev-env/image.ts`). Retiring an environment only removes its
 * own tag, so a run that made any leaves these behind unless it removes them.
 */
export async function removeCachedImages(prefix: string): Promise<void> {
  const { stdout } = await run('docker', ['image', 'ls', '--format', '{{.Repository}}', '--filter', `reference=${prefix}image-*`])
    .catch(() => ({ stdout: '' }))
  for (const image of new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean))) {
    await run('docker', ['image', 'rm', image]).catch(() => null)
  }
}

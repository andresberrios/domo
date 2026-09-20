import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Root for everything Domo persists on disk: uploaded attachments. */
export function dataDir(): string {
  const configured = process.env.NUXT_DATA_DIR || process.env.DOMO_DATA_DIR
  const dir = configured
    ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
    : resolve(process.cwd(), '.data')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function uploadsDir(): string {
  const dir = join(dataDir(), 'uploads')
  mkdirSync(dir, { recursive: true })
  return dir
}

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * What this machine offers the free voices, asked in one place so a test can
 * pin it: which voice is free depends on it (`freeSpeaker`).
 */
export const machine = {
  isMac: (): boolean => process.platform === 'darwin',
  onPath: (command: string): boolean =>
    (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(dir, command)))
}

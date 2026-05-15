/**
 * Shared Zod schemas for procedure inputs/outputs.
 *
 * Keeping a single home for these means the TS types feed both the
 * `defineProcedure` boundaries on the server and the `apiClient`-derived
 * client types in the UI. Add schemas here when a shape is referenced by
 * more than one procedure; per-procedure shapes can stay inline.
 */
import { z } from 'zod'

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  defaultBranch: z.string().nullable(),
  hasCoastfile: z.boolean(),
  createdAt: z.number().int(),
})
export type Project = z.infer<typeof Project>

export const Env = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  coastInstanceName: z.string(),
  /** Cached status from coastd `/ls`; nullable for newly-created envs. */
  status: z.string().nullable(),
  /** Live values folded in from a fresh `/ls` lookup when present. */
  liveStatus: z.string().nullable().optional(),
  checkedOut: z.boolean().optional(),
  createdAt: z.number().int(),
})
export type Env = z.infer<typeof Env>

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  hidden: z.boolean(),
})
export type FsEntry = z.infer<typeof FsEntry>

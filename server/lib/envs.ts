/**
 * Env helpers — typed CRUD against the `envs` table, plus a `coast ls`
 * lookup that folds runtime status into the row.
 *
 * Worktree convention: `<project.rootPath>/.worktrees/<env.name>` (Coast's
 * default). The branch name, worktree directory name, and coast instance
 * name are all the same string.
 */
import { join } from 'node:path'
import { db } from './db'
import { coast } from './coast'
import type { InstanceStatus } from './coast/types'

export interface EnvRow {
  id: string
  projectId: string
  name: string
  branch: string | null
  worktreePath: string | null
  coastInstanceName: string
  status: string | null
  createdAt: number
}

interface EnvDbRow {
  id: string
  project_id: string
  name: string
  branch: string | null
  worktree_path: string | null
  coast_instance_name: string
  status: string | null
  created_at: number
}

function fromDb(r: EnvDbRow): EnvRow {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    branch: r.branch,
    worktreePath: r.worktree_path,
    coastInstanceName: r.coast_instance_name,
    status: r.status,
    createdAt: r.created_at,
  }
}

export function listEnvs(projectId?: string): EnvRow[] {
  const stmt = projectId
    ? db().prepare(`SELECT * FROM envs WHERE project_id = ? ORDER BY created_at ASC`).all(projectId)
    : db().prepare(`SELECT * FROM envs ORDER BY created_at ASC`).all()
  return (stmt as EnvDbRow[]).map(fromDb)
}

export function getEnv(id: string): EnvRow | null {
  const r = db().prepare(`SELECT * FROM envs WHERE id = ?`).get(id) as EnvDbRow | undefined
  return r ? fromDb(r) : null
}

export function getEnvByName(projectId: string, name: string): EnvRow | null {
  const r = db()
    .prepare(`SELECT * FROM envs WHERE project_id = ? AND name = ?`)
    .get(projectId, name) as EnvDbRow | undefined
  return r ? fromDb(r) : null
}

export function insertEnv(row: EnvRow): void {
  db().prepare(`
    INSERT INTO envs (id, project_id, name, branch, worktree_path, coast_instance_name, status, created_at)
    VALUES (@id, @projectId, @name, @branch, @worktreePath, @coastInstanceName, @status, @createdAt)
  `).run(row)
}

export function updateEnvStatus(id: string, status: string | null): void {
  db().prepare(`UPDATE envs SET status = ? WHERE id = ?`).run(status, id)
}

export function updateEnvFields(
  id: string,
  fields: Partial<Pick<EnvRow, 'branch' | 'worktreePath' | 'status'>>,
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (fields.branch !== undefined) { sets.push('branch = @branch'); params.branch = fields.branch }
  if (fields.worktreePath !== undefined) { sets.push('worktree_path = @worktreePath'); params.worktreePath = fields.worktreePath }
  if (fields.status !== undefined) { sets.push('status = @status'); params.status = fields.status }
  if (sets.length === 0) return
  db().prepare(`UPDATE envs SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function deleteEnv(id: string): void {
  db().prepare(`DELETE FROM envs WHERE id = ?`).run(id)
}

export function defaultWorktreePath(projectRoot: string, envName: string): string {
  return join(projectRoot, '.worktrees', envName)
}

/**
 * Reconcile our cached env rows against coastd's live `/ls`. Returns each
 * env row enriched with the instance's `liveStatus` and `checkedOut` flag
 * (or nulls when coastd doesn't know about the instance yet).
 */
export interface EnrichedEnv extends EnvRow {
  liveStatus: InstanceStatus | null
  checkedOut: boolean
}

export async function listEnvsEnriched(
  projectCoastName: string,
  projectId: string,
): Promise<EnrichedEnv[]> {
  const rows = listEnvs(projectId)
  if (rows.length === 0) return []
  let live: { name: string; status: InstanceStatus; checked_out: boolean }[] = []
  try {
    const ls = await coast().ls(projectCoastName)
    live = ls.instances.map((i) => ({ name: i.name, status: i.status, checked_out: i.checked_out }))
  } catch {
    // coastd unreachable — return cached only.
  }
  return rows.map((r) => {
    const hit = live.find((i) => i.name === r.coastInstanceName)
    return {
      ...r,
      liveStatus: hit?.status ?? null,
      checkedOut: hit?.checked_out ?? false,
    }
  })
}

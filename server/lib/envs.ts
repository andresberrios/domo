/**
 * Env helpers — typed CRUD against the `envs` table + a `docker
 * inspect` lookup that folds runtime status into the row. Replaces
 * the Coast-based enrichment (Coast surface dropped step 3a, design
 * §Environments / Decided #9).
 *
 * Worktree convention: `<project.rootPath>/.worktrees/<env.name>`.
 * `branch` is the env's own branch — created at `up` time as a fresh
 * branch named after the env (`env.name`); `baseBranch` records the
 * branch it was forked from (e.g. the project default), so we know
 * what start-point to pass to `git worktree add -b <env.name>
 * <worktreePath> <baseBranch>`. The docker container id
 * (`containerId`) is what we use against the docker daemon for
 * inspect/exec/lifecycle.
 */
import { join } from 'node:path'
import { changeBus } from './changeBus'
import { db } from './db'
import { findByEnvId, inspect, toEnvLiveStatus } from './devcontainer'
import type { EnvLiveStatus } from './devcontainer'

export interface EnvRow {
  id: string
  projectId: string
  name: string
  /** The env's own branch. For non-root envs == `name` (the new branch
   * created at `worktree add -b` time). NULL on the root env, which
   * has no branch of its own — it tracks whatever the host has checked
   * out at `project.rootPath` (step 8). */
  branch: string | null
  /** Branch this env was forked from (the project default, unless the
   * creator overrode it). Stored so the `worktree add` start-point is
   * recoverable across restarts; the env's branch evolves
   * independently afterward. NULL on the root env + on pre-
   * `base_branch`-migration rows. */
  baseBranch: string | null
  /** Host path the env's container has at `/workspaces/<name>`. For
   * non-root envs this is `<projectRoot>/.worktrees/<name>` (a git
   * worktree we create); for the root env it is `project.rootPath`
   * directly (no worktree — step 8). */
  worktreePath: string | null
  /** Docker container id from the most recent `devcontainer up`. Null
   * until the env has been started for the first time. */
  containerId: string | null
  /** Path to the devcontainer.json used at `up` time, or NULL when the
   * Domo default config was applied (step 8 — devcontainer.json is
   * optional). UI surfaces "(default config)" on the env overview
   * when null. */
  devcontainerPath: string | null
  /** sha256 of the merged config the last successful `up` handed the
   * CLI. Drift detection (step 8 decision #6) recomputes this on
   * overview load and surfaces a Rebuild banner when it differs. NULL
   * on envs that haven't been `up`'d yet. */
  devcontainerConfigHash: string | null
  /** True for the auto-created root env per project. Bind-mounts
   * `project.rootPath` directly; cannot be deleted (only "torn down").
   * Reserved name `'root'`. Step 8. */
  isRoot: boolean
  status: string | null
  createdAt: number
}

interface EnvDbRow {
  id: string
  project_id: string
  name: string
  branch: string | null
  base_branch: string | null
  worktree_path: string | null
  container_id: string | null
  devcontainer_path: string | null
  devcontainer_config_hash: string | null
  is_root: number
  status: string | null
  created_at: number
}

const SELECT_COLS =
  'id, project_id, name, branch, base_branch, worktree_path, container_id, devcontainer_path, devcontainer_config_hash, is_root, status, created_at'

function fromDb(r: EnvDbRow): EnvRow {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    branch: r.branch,
    baseBranch: r.base_branch,
    worktreePath: r.worktree_path,
    containerId: r.container_id,
    devcontainerPath: r.devcontainer_path,
    devcontainerConfigHash: r.devcontainer_config_hash,
    isRoot: r.is_root === 1,
    status: r.status,
    createdAt: r.created_at,
  }
}

export function listEnvs(projectId?: string): EnvRow[] {
  const stmt = projectId
    ? db().prepare(`SELECT ${SELECT_COLS} FROM envs WHERE project_id = ? ORDER BY created_at ASC`).all(projectId)
    : db().prepare(`SELECT ${SELECT_COLS} FROM envs ORDER BY created_at ASC`).all()
  return (stmt as EnvDbRow[]).map(fromDb)
}

export function getEnv(id: string): EnvRow | null {
  const r = db().prepare(`SELECT ${SELECT_COLS} FROM envs WHERE id = ?`).get(id) as EnvDbRow | undefined
  return r ? fromDb(r) : null
}

export function getEnvByName(projectId: string, name: string): EnvRow | null {
  const r = db()
    .prepare(`SELECT ${SELECT_COLS} FROM envs WHERE project_id = ? AND name = ?`)
    .get(projectId, name) as EnvDbRow | undefined
  return r ? fromDb(r) : null
}

export function insertEnv(row: EnvRow): void {
  db().prepare(`
    INSERT INTO envs (
      id, project_id, name, branch, base_branch, worktree_path,
      container_id, devcontainer_path, devcontainer_config_hash,
      is_root, status, created_at
    )
    VALUES (
      @id, @projectId, @name, @branch, @baseBranch, @worktreePath,
      @containerId, @devcontainerPath, @devcontainerConfigHash,
      @isRoot, @status, @createdAt
    )
  `).run({ ...row, isRoot: row.isRoot ? 1 : 0 })
  changeBus().emitTableChange({ table: 'envs', id: row.id, op: 'insert' })
}

export function updateEnvStatus(id: string, status: string | null): void {
  db().prepare(`UPDATE envs SET status = ? WHERE id = ?`).run(status, id)
  changeBus().emitTableChange({ table: 'envs', id, op: 'update' })
}

export function updateEnvFields(
  id: string,
  fields: Partial<Pick<EnvRow,
    'branch' | 'baseBranch' | 'worktreePath' | 'containerId'
    | 'devcontainerPath' | 'devcontainerConfigHash' | 'status'
  >>,
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (fields.branch !== undefined) { sets.push('branch = @branch'); params.branch = fields.branch }
  if (fields.baseBranch !== undefined) { sets.push('base_branch = @baseBranch'); params.baseBranch = fields.baseBranch }
  if (fields.worktreePath !== undefined) { sets.push('worktree_path = @worktreePath'); params.worktreePath = fields.worktreePath }
  if (fields.containerId !== undefined) { sets.push('container_id = @containerId'); params.containerId = fields.containerId }
  if (fields.devcontainerPath !== undefined) { sets.push('devcontainer_path = @devcontainerPath'); params.devcontainerPath = fields.devcontainerPath }
  if (fields.devcontainerConfigHash !== undefined) { sets.push('devcontainer_config_hash = @devcontainerConfigHash'); params.devcontainerConfigHash = fields.devcontainerConfigHash }
  if (fields.status !== undefined) { sets.push('status = @status'); params.status = fields.status }
  if (sets.length === 0) return
  db().prepare(`UPDATE envs SET ${sets.join(', ')} WHERE id = @id`).run(params)
  changeBus().emitTableChange({ table: 'envs', id, op: 'update' })
}

export function deleteEnv(id: string): void {
  db().prepare(`DELETE FROM envs WHERE id = ?`).run(id)
  changeBus().emitTableChange({ table: 'envs', id, op: 'delete' })
}

export function defaultWorktreePath(projectRoot: string, envName: string): string {
  return join(projectRoot, '.worktrees', envName)
}

/**
 * Resolve the docker container id for an env, falling back to the
 * `domo.envId` label search if the stored id is missing or the
 * container has been recreated. Returns null when nothing matches —
 * the env exists in DB but no container is live (the normal state
 * for a fresh env until first `up`).
 *
 * When the stored id is stale and the label search recovers a fresh
 * one, we persist the new id back to the row so the engine's hot
 * path (which reads `env.containerId` directly without an inspect
 * round-trip) sees the correct value immediately.
 */
export async function resolveContainerId(env: EnvRow): Promise<string | null> {
  if (env.containerId) {
    const ok = await inspect(env.containerId)
    if (ok) return env.containerId
  }
  const found = await findByEnvId(env.id)
  if (found && found !== env.containerId) {
    updateEnvFields(env.id, { containerId: found })
  }
  return found
}

/**
 * Reconcile cached env rows against the live docker daemon. Returns
 * each env enriched with the container's `liveStatus` (or null when no
 * container exists yet).
 */
export interface EnrichedEnv extends EnvRow {
  liveStatus: EnvLiveStatus | null
}

export async function listEnvsEnriched(projectId: string): Promise<EnrichedEnv[]> {
  const rows = listEnvs(projectId)
  if (rows.length === 0) return []
  return Promise.all(rows.map(async (r) => {
    const cid = await resolveContainerId(r)
    if (!cid) return { ...r, liveStatus: null }
    const info = await inspect(cid)
    return { ...r, liveStatus: info ? toEnvLiveStatus(info.status) : 'missing' }
  }))
}

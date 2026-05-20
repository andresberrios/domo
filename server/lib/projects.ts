/**
 * Project helpers — git detection, devcontainer detection + starter
 * write, `.gitignore` patcher, and typed CRUD against the `projects`
 * table.
 *
 * Post-pivot: projects are identified by their `name` (a slug derived
 * from `devcontainer.json`'s `name` field or the directory basename).
 * The container layer is whatever `devcontainer.json` declares —
 * `image` / `build` / `dockerComposeFile` — Domo doesn't impose a
 * format of its own (no `Domofile` / `Coastfile`).
 */
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { changeBus } from './changeBus'
import { db } from './db'
import { findDevcontainer, loadDevcontainer } from './devcontainer'

const execFile = promisify(execFileCb)

export interface ProjectRow {
  id: string
  name: string
  rootPath: string
  defaultBranch: string | null
  hasDevcontainer: boolean
  createdAt: number
}

interface ProjectDbRow {
  id: string
  name: string
  root_path: string
  default_branch: string | null
  has_devcontainer: number
  created_at: number
}

function fromDb(r: ProjectDbRow): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    defaultBranch: r.default_branch,
    hasDevcontainer: r.has_devcontainer === 1,
    createdAt: r.created_at,
  }
}

export function listProjects(): ProjectRow[] {
  return (db().prepare(`SELECT * FROM projects ORDER BY created_at ASC`).all() as ProjectDbRow[]).map(fromDb)
}

export function getProject(id: string): ProjectRow | null {
  const r = db().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectDbRow | undefined
  return r ? fromDb(r) : null
}

export function getProjectByRoot(rootPath: string): ProjectRow | null {
  const r = db().prepare(`SELECT * FROM projects WHERE root_path = ?`).get(rootPath) as
    | ProjectDbRow
    | undefined
  return r ? fromDb(r) : null
}

export function insertProject(row: ProjectRow): void {
  db().prepare(`
    INSERT INTO projects (id, name, root_path, default_branch, has_devcontainer, created_at)
    VALUES (@id, @name, @rootPath, @defaultBranch, @hasDevcontainer, @createdAt)
  `).run({
    ...row,
    hasDevcontainer: row.hasDevcontainer ? 1 : 0,
  })
  changeBus().emitTableChange({ table: 'projects', id: row.id, op: 'insert' })
}

export function deleteProject(id: string): void {
  db().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  changeBus().emitTableChange({ table: 'projects', id, op: 'delete' })
}

// --- Git detection / init -------------------------------------------------

export async function detectGitRoot(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', rootPath, 'rev-parse', '--show-toplevel'])
    return stdout.trim()
  } catch {
    return null
  }
}

export async function gitInit(rootPath: string): Promise<void> {
  await execFile('git', ['-C', rootPath, 'init'])
}

export async function detectDefaultBranch(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', rootPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const v = stdout.trim()
    return v && v !== 'HEAD' ? v : null
  } catch {
    return null
  }
}

// --- Devcontainer detection ----------------------------------------------

export interface DevcontainerInfo {
  /** Absolute path to detected devcontainer.json, or null if missing. */
  path: string | null
  /** Is there a ./docker-compose.yml or compose.yml? Informational. */
  composeDetected: boolean
  /** `name` field parsed from the devcontainer.json, if present. */
  parsedName: string | null
}

export async function inspectDevcontainer(rootPath: string): Promise<DevcontainerInfo> {
  const path = await findDevcontainer(rootPath)

  const composeCandidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
  const composeDetected = composeCandidates.some((c) => existsSync(join(rootPath, c)))

  let parsedName: string | null = null
  if (path) {
    try {
      const { config } = await loadDevcontainer(rootPath)
      parsedName = typeof config.name === 'string' ? config.name : null
    } catch {
      // Malformed JSONC — leave parsedName null; the procedure layer
      // surfaces parse errors separately if it needs to.
    }
  }

  return { path, composeDetected, parsedName }
}

// --- .gitignore patch -----------------------------------------------------

/** Whether `.gitignore` ignores the `.worktrees/` directory. */
export async function gitignoreCoversWorktrees(rootPath: string): Promise<boolean> {
  const p = join(rootPath, '.gitignore')
  if (!existsSync(p)) return false
  const text = await readFile(p, 'utf8')
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed === '.worktrees' || trimmed === '.worktrees/' || trimmed === '/.worktrees' || trimmed === '/.worktrees/'
  })
}

export async function addWorktreesToGitignore(rootPath: string): Promise<void> {
  const p = join(rootPath, '.gitignore')
  if (existsSync(p)) {
    const text = await readFile(p, 'utf8')
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    await appendFile(p, `${sep}.worktrees/\n`, 'utf8')
  } else {
    await writeFile(p, `.worktrees/\n`, 'utf8')
  }
}

// --- Naming convenience ---------------------------------------------------

/** Derive a default project name from the directory basename. */
export function defaultProjectName(rootPath: string): string {
  return basename(rootPath)
}

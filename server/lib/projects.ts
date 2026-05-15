/**
 * Project helpers — git / Coastfile detection, starter-Coastfile writer,
 * `.gitignore` patcher, and typed CRUD against the `projects` table.
 *
 * Coast identifies projects by the `[coast] name = "..."` field in the
 * Coastfile. We extract that on add and store it as the project row's
 * `name` so subsequent calls to coastd (`/ls`, `/run`, ...) pass through
 * the right identifier. If parsing fails we fall back to the directory
 * basename, which matches Coast's own default behavior.
 */
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { db } from './db'

const execFile = promisify(execFileCb)

export interface ProjectRow {
  id: string
  name: string
  rootPath: string
  defaultBranch: string | null
  hasCoastfile: boolean
  createdAt: number
}

interface ProjectDbRow {
  id: string
  name: string
  root_path: string
  default_branch: string | null
  has_coastfile: number
  created_at: number
}

function fromDb(r: ProjectDbRow): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    defaultBranch: r.default_branch,
    hasCoastfile: r.has_coastfile === 1,
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
    INSERT INTO projects (id, name, root_path, default_branch, has_coastfile, created_at)
    VALUES (@id, @name, @rootPath, @defaultBranch, @hasCoastfile, @createdAt)
  `).run({
    ...row,
    hasCoastfile: row.hasCoastfile ? 1 : 0,
  })
}

export function deleteProject(id: string): void {
  db().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
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

// --- Coastfile detection / init / parse -----------------------------------

export interface CoastfileInfo {
  path: string | null  // absolute path to detected Coastfile, or null if missing
  composeDetected: boolean  // is there a ./docker-compose.yml or compose.yml?
  parsedName: string | null  // [coast].name from the Coastfile, if present
}

export async function inspectCoastfile(rootPath: string): Promise<CoastfileInfo> {
  const candidates = ['Coastfile', 'Coastfile.toml']
  let path: string | null = null
  for (const c of candidates) {
    const p = join(rootPath, c)
    if (existsSync(p)) { path = p; break }
  }

  const composeCandidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
  const composeDetected = composeCandidates.some((c) => existsSync(join(rootPath, c)))

  let parsedName: string | null = null
  if (path) {
    try {
      const content = await readFile(path, 'utf8')
      parsedName = parseCoastfileName(content)
    } catch { /* ignore */ }
  }

  return { path, composeDetected, parsedName }
}

/**
 * Cheap TOML probe for `[coast] name = "..."`. Coastfile is TOML, but we
 * don't pull a full parser in here — we just need the project name, and a
 * regex over the `[coast]` table is enough. Falls back to null on any
 * surprise; callers handle the fallback.
 */
export function parseCoastfileName(content: string): string | null {
  const sectionMatch = content.match(/^\s*\[coast\]\s*\r?\n([\s\S]*?)(?=^\s*\[|$(?![\r\n]))/m)
  if (!sectionMatch) return null
  const body = sectionMatch[1] ?? ''
  const nameMatch = body.match(/^\s*name\s*=\s*"([^"\r\n]+)"\s*$/m)
  return nameMatch?.[1] ?? null
}

export async function writeStarterCoastfile(
  rootPath: string,
  opts: { name: string; composeDetected: boolean },
): Promise<string> {
  const composeLine = opts.composeDetected
    ? `compose = "./docker-compose.yml"\n`
    : `# compose = "./docker-compose.yml"  # uncomment when you have a compose file\n`

  const content =
    `[coast]\n` +
    `name = "${opts.name}"\n` +
    composeLine +
    `\n` +
    `[ports]\n` +
    `# logical_name = canonical_port\n`

  const path = join(rootPath, 'Coastfile')
  await writeFile(path, content, 'utf8')
  return path
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

/** Derive a default coast project name from the directory basename. */
export function defaultProjectName(rootPath: string): string {
  return basename(rootPath)
}

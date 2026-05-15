import Database from 'better-sqlite3'
import { domoDbPath } from './paths'

let _db: Database.Database | null = null

/**
 * Singleton handle to Domo's SQLite metadata DB. Schema is migrated on first
 * access. Holds projects, envs, sessions, settings — the small UX-shaped
 * state that survives restarts. Coast owns runtime state (running/stopped,
 * dynamic ports); Electric Agents owns session event streams. We just point
 * at them and remember user-facing flags (session done, last-viewed-at,
 * cached `coast ls` status for fast first render).
 */
export function db(): Database.Database {
  if (_db) return _db
  _db = new Database(domoDbPath())
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      has_coastfile INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS envs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      coast_instance_name TEXT NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      done INTEGER NOT NULL DEFAULT 0,
      entity_id TEXT,
      durable_stream_url TEXT,
      native_claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_event_at INTEGER,
      viewed_at_per_device TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_env_id ON sessions(env_id);
    CREATE INDEX IF NOT EXISTS idx_envs_project_id ON envs(project_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)

  const row = d.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
    | { version: number }
    | undefined
  if (!row) {
    d.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(1)
  }
}
